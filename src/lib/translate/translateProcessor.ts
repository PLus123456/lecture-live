import 'server-only';

import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { JOB_TYPE, JOB_STATUS, createJob, retryJob } from '@/lib/jobQueue';
import { getSiteSettings } from '@/lib/siteSettings';
import { refundWalletCents } from '@/lib/wallet';
import { resolveUserTranslationModelId } from '@/lib/userRoles';
import { resolveGroupBoundModel } from '@/lib/llm/summaryModel';
import {
  getTranslateFleetConfig,
  pingTranslateWorker,
  uploadTranslateInput,
  startTranslateJob,
  getTranslateJob,
  downloadTranslateOutput,
  deleteTranslateJob,
  buildWorkerModelLabel,
  TranslateWorkerError,
  type TranslateFleetConfig,
  type TranslateWorkerConfig,
  type TranslateJobStatus,
} from '@/lib/translate/workerClient';
import {
  readSourceFile,
  saveOutputFile,
  deleteTaskFiles,
} from '@/lib/translate/taskStorage';
import { logger, serializeError } from '@/lib/logger';

/**
 * 文档翻译调度器（tick 对账制状态机，与 enhanceProcessor 同构）。
 *
 * 真源分工：JobQueue(type=doc_translate) 是**调度**真源（claim/attempt/退避），
 * TranslationTask 是**业务**真源（用户可见状态/进度/产物/计费）。worker 侧 jobId
 * 直接用 JobQueue 行 id，天然幂等：中断后下一轮 tick 查 worker 实际状态续接。
 *
 * 状态流转（JobQueue.status / TranslationTask.status）：
 *   SUBMITTED / PENDING     → 已确认扣费待派发（含自动重试回炉）
 *   PROCESSING / TRANSLATING → worker 排队或翻译中，每轮 tick 对账回写进度
 *   SUCCESS / COMPLETED     → mono/dual 已回存本地，代理凭据失效
 *   FAILED / TRANSLATING|FAILED → 可重试失败对用户仍显示处理中；终态失败自动全额退款
 *
 * 推进途径：1) ws 进程 startDocTranslateLoop 周期 tick；2) 任务状态路由 fire-and-forget
 * 踢一脚。多进程并发安全靠 claim 的条件 updateMany 抢占。
 */

const translateLogger = logger.child({ component: 'doc-translate' });

/** 单任务在 worker 侧最长滞留：大文档（数百页 × QPS 限速）给足 3 小时 */
const MAX_WORKER_RUNTIME_MS = 180 * 60_000;
/** 自动重试退避（按已消耗 attempt 索引） */
const RETRY_BACKOFF_MS = [5 * 60_000, 20 * 60_000, 45 * 60_000];
const DEFAULT_MAX_ATTEMPTS = 3;

interface TranslateJobParams {
  /** 业务行 id（TranslationTask） */
  taskId?: string;
  /** 任务绑定的 worker 行 id（多台时由派发选定；后续对账/收割/清理都走它） */
  workerId?: string;
  nextRetryAt?: string;
  progress?: { stage: string | null; percent: number; at: string };
  [key: string]: unknown;
}

function parseJobParams(raw: string | null): TranslateJobParams {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TranslateJobParams) : {};
  } catch {
    return {};
  }
}

async function writeJobParams(jobId: string, params: TranslateJobParams): Promise<void> {
  await prisma.jobQueue
    .update({ where: { id: jobId }, data: { params: JSON.stringify(params) } })
    .catch(() => undefined);
}

// ─── 入队（由确认扣费路由调用） ───

/**
 * 把已确认扣费的翻译任务入队（幂等：task 已关联在途 JobQueue 行则复用）。
 * 返回 jobId；创建失败返回 null（调用方回滚扣费）。
 */
export async function enqueueDocTranslate(taskId: string, userId: string): Promise<string | null> {
  try {
    const task = await prisma.translationTask.findUnique({
      where: { id: taskId },
      select: { jobQueueId: true },
    });
    if (task?.jobQueueId) {
      const existing = await prisma.jobQueue.findUnique({
        where: { id: task.jobQueueId },
        select: { id: true, status: true },
      });
      if (
        existing &&
        existing.status !== JOB_STATUS.SUCCESS &&
        existing.status !== JOB_STATUS.FAILED
      ) {
        return existing.id;
      }
    }
    const jobId = await createJob({
      type: JOB_TYPE.DOC_TRANSLATE,
      userId,
      triggeredBy: userId,
      params: { taskId },
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
    if (!jobId) return null;
    await prisma.translationTask.update({
      where: { id: taskId },
      data: { jobQueueId: jobId },
    });
    return jobId;
  } catch (error) {
    translateLogger.warn({ taskId, err: serializeError(error) }, '翻译任务入队失败');
    return null;
  }
}

// ─── tick 入口（进程内互斥） ───

declare global {
  // eslint-disable-next-line no-var
  var __docTranslateTickRun: Promise<void> | undefined;
}

export function runDocTranslateTick(): Promise<void> {
  if (globalThis.__docTranslateTickRun) {
    return globalThis.__docTranslateTickRun;
  }
  const run = executeTick()
    .catch((error) => {
      translateLogger.warn({ err: serializeError(error) }, '文档翻译 tick 异常');
    })
    .finally(() => {
      globalThis.__docTranslateTickRun = undefined;
    });
  globalThis.__docTranslateTickRun = run;
  return run;
}

async function executeTick(): Promise<void> {
  const fleet = await getTranslateFleetConfig();
  if (!fleet) {
    return; // 文档翻译未启用/无可用 worker：入队任务保留，配置好后自动推进
  }

  // 1) 对账所有 PROCESSING 任务
  const processing = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.PROCESSING },
    orderBy: { startedAt: 'asc' },
  });
  for (const job of processing) {
    await reconcileProcessingJob(job, fleet).catch((error) => {
      translateLogger.warn(
        { jobId: job.id, err: serializeError(error) },
        '文档翻译任务对账异常（下轮重试）'
      );
    });
  }

  // 2) 到期自动重试：FAILED 且未用尽 attempt 且过退避时间 → 回炉 SUBMITTED
  const failed = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.FAILED },
    orderBy: { completedAt: 'asc' },
    take: 20,
  });
  const now = Date.now();
  for (const job of failed) {
    if (job.attempt >= job.maxAttempts) continue;
    const params = parseJobParams(job.params);
    if (!params.nextRetryAt) continue;
    if (new Date(params.nextRetryAt).getTime() > now) continue;
    const retried = await retryJob(job.id);
    if (retried) {
      translateLogger.info(
        { jobId: job.id, attempt: job.attempt + 1 },
        '文档翻译任务自动重试回炉'
      );
    }
  }

  // 3) 派发：总槽位 = Σ每台 concurrency − 全部在途
  const busyRows = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.PROCESSING },
    select: { params: true },
  });
  const busyByWorkerId = new Map<string, number>();
  for (const row of busyRows) {
    const id = parseJobParams(row.params).workerId;
    if (id) busyByWorkerId.set(id, (busyByWorkerId.get(id) ?? 0) + 1);
  }
  const capacity = fleet.workers.reduce((sum, w) => sum + w.concurrency, 0);
  const totalSlots = capacity - busyRows.length;
  if (totalSlots <= 0) return;

  const submitted = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.SUBMITTED },
    orderBy: { createdAt: 'asc' },
    take: totalSlots,
  });
  const healthCache = new Map<string, { ok: boolean; load: number }>();
  for (const job of submitted) {
    const claimed = await claimJob(job.id);
    if (!claimed) continue;
    await dispatchJob(job, fleet, busyByWorkerId, healthCache).catch(async (error) => {
      translateLogger.warn(
        { jobId: job.id, err: serializeError(error) },
        '文档翻译任务派发异常'
      );
      await failJob(job.id, error, { retryable: true });
    });
  }
}

// ─── 选台（负载均衡：评分 = (实际队列 + 本地在途) / 权重，取最小） ───

async function pickWorker(
  fleet: TranslateFleetConfig,
  busyByWorkerId: Map<string, number>,
  healthCache: Map<string, { ok: boolean; load: number }>
): Promise<TranslateWorkerConfig | null> {
  const candidates = fleet.workers.filter(
    (w) => (busyByWorkerId.get(w.id) ?? 0) < w.concurrency
  );
  if (candidates.length === 0) return null;

  await Promise.all(
    candidates
      .filter((w) => !healthCache.has(w.id))
      .map(async (w) => {
        try {
          const health = await pingTranslateWorker(w, { timeoutMs: 4_000 });
          healthCache.set(w.id, {
            // queue 缺失 = token 鉴权失败的裸响应，同样视为不可用
            ok: Boolean(health.ok && health.queue),
            load: (health.queue?.running ?? 0) + (health.queue?.queued ?? 0),
          });
        } catch {
          healthCache.set(w.id, { ok: false, load: Number.POSITIVE_INFINITY });
        }
      })
  );

  const alive = candidates.filter((w) => healthCache.get(w.id)?.ok);
  if (alive.length === 0) return null;
  alive.sort((a, b) => {
    const scoreA =
      (healthCache.get(a.id)!.load + (busyByWorkerId.get(a.id) ?? 0)) / a.weight;
    const scoreB =
      (healthCache.get(b.id)!.load + (busyByWorkerId.get(b.id) ?? 0)) / b.weight;
    return scoreA - scoreB;
  });
  return alive[0];
}

function workerById(
  fleet: TranslateFleetConfig,
  id: string | undefined
): TranslateWorkerConfig | null {
  if (!id) return null;
  return fleet.workers.find((w) => w.id === id) ?? null;
}

/** 无绑定时逐台查找该任务落在哪台上（找回场景） */
async function findJobOnFleet(
  fleet: TranslateFleetConfig,
  jobId: string
): Promise<{ worker: TranslateWorkerConfig; remote: TranslateJobStatus } | null> {
  for (const worker of fleet.workers) {
    try {
      const remote = await getTranslateJob(worker, jobId);
      return { worker, remote };
    } catch {
      continue;
    }
  }
  return null;
}

/** 条件抢占：SUBMITTED → PROCESSING（跨进程唯一赢家） */
async function claimJob(jobId: string): Promise<boolean> {
  const result = await prisma.jobQueue.updateMany({
    where: { id: jobId, status: JOB_STATUS.SUBMITTED },
    data: { status: JOB_STATUS.PROCESSING, startedAt: new Date() },
  });
  return result.count === 1;
}

// ─── 派发 ───

type TaskRow = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

async function loadTask(taskId: string | undefined) {
  if (!taskId) return null;
  return prisma.translationTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      userId: true,
      status: true,
      sourceLang: true,
      targetLang: true,
      glossaryJson: true,
      chargedCents: true,
      refundedAt: true,
      pageCount: true,
      modelId: true,
      user: { select: { role: true, customGroupId: true } },
    },
  });
}

function parseGlossary(raw: string | null): { src: string; dst: string }[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const entries = arr
      .filter(
        (e): e is { src: string; dst: string } =>
          Boolean(e) &&
          typeof e === 'object' &&
          typeof (e as { src?: unknown }).src === 'string' &&
          typeof (e as { dst?: unknown }).dst === 'string'
      )
      .slice(0, 500);
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/** 生成任务级 LLM 代理凭据：明文只下发给 worker，库里只存 sha256（同 EmailToken 惯例） */
async function issueProxyToken(taskId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.translationTask.update({
    where: { id: taskId },
    data: { proxyTokenHash: hash },
  });
  return raw;
}

async function dispatchJob(
  job: JobRow,
  fleet: TranslateFleetConfig,
  busyByWorkerId: Map<string, number>,
  healthCache: Map<string, { ok: boolean; load: number }>
): Promise<void> {
  const jobId = job.id;
  const params = parseJobParams(job.params);
  const task = await loadTask(params.taskId);
  if (!task) {
    await failJob(jobId, new Error('翻译任务已删除'), { retryable: false });
    return;
  }
  if (task.status === 'CANCELED' || task.status === 'COMPLETED') {
    // 用户已取消 / 任务已由别的路径完成：清 worker 痕迹，调度行终态
    const bound = workerById(fleet, params.workerId);
    if (bound) await deleteTranslateJob(bound, jobId).catch(() => undefined);
    await prisma.jobQueue.updateMany({
      where: { id: jobId, status: JOB_STATUS.PROCESSING },
      data: {
        status: task.status === 'COMPLETED' ? JOB_STATUS.SUCCESS : JOB_STATUS.FAILED,
        error: task.status === 'CANCELED' ? '用户已取消' : null,
        completedAt: new Date(),
      },
    });
    return;
  }

  // 对账 worker 现状：中断重派时任务可能已在某台上跑甚至已完成
  const bound = workerById(fleet, params.workerId);
  let located: { worker: TranslateWorkerConfig; remote: TranslateJobStatus } | null = null;
  if (bound) {
    try {
      located = { worker: bound, remote: await getTranslateJob(bound, jobId) };
    } catch (error) {
      if (!(error instanceof TranslateWorkerError) || error.status !== 404) {
        throw error; // 绑定台网络异常：保持 PROCESSING 下轮重试
      }
    }
  } else {
    located = await findJobOnFleet(fleet, jobId);
  }

  if (located) {
    if (located.worker.id !== params.workerId) {
      await writeJobParams(jobId, { ...params, workerId: located.worker.id });
    }
    if (located.remote.status === 'succeeded') {
      await harvestJob(jobId, task, located.worker);
      return;
    }
    if (located.remote.status === 'queued' || located.remote.status === 'running') {
      await markTaskTranslating(task.id, located.worker.id);
      return;
    }
    // created / failed：留在这台重推
  }

  const target = located?.worker ?? (await pickWorker(fleet, busyByWorkerId, healthCache));
  if (!target) {
    // 全部不可达/占满：让位回 SUBMITTED，不消耗 attempt
    await prisma.jobQueue.updateMany({
      where: { id: jobId, status: JOB_STATUS.PROCESSING },
      data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
    });
    return;
  }

  const source = await readSourceFile(task.id);
  if (!source) {
    await failJob(jobId, new Error('源文件读取失败'), { retryable: false });
    return;
  }

  const settings = await getSiteSettings();
  const appUrl = settings.site_url.replace(/\/+$/, '');

  // 派发时解析任务实际使用的模型：① 生成真实模型标识下发（pdf2zh 缓存按模型分键，
  // 换模型不再复用旧译文）；② 解析出具体路由行且任务尚无快照时定格回 task.modelId，
  // 让代理端点全程恒定同一模型（中途 admin 换全局默认不影响在途任务）。
  const boundId =
    task.modelId || (await resolveUserTranslationModelId(task.user).catch(() => null));
  const resolved = await resolveGroupBoundModel(boundId, 'TRANSLATION').catch(() => null);
  const resolvedDbId =
    resolved?.provider?.dbModelId && resolved.provider.purpose === 'TRANSLATION'
      ? resolved.provider.dbModelId
      : null;
  if (resolvedDbId && !task.modelId) {
    await prisma.translationTask
      .updateMany({ where: { id: task.id }, data: { modelId: resolvedDbId } })
      .catch(() => undefined);
  }
  const modelLabel = buildWorkerModelLabel(resolved?.provider ?? null);

  try {
    await uploadTranslateInput(target, jobId, source);
    const proxyToken = await issueProxyToken(task.id);
    await startTranslateJob(target, jobId, {
      langIn: task.sourceLang,
      langOut: task.targetLang,
      qps: target.qps,
      watermark: fleet.watermark,
      glossary: parseGlossary(task.glossaryJson),
      llm: {
        baseUrl: `${appUrl}/api/translate/llm-proxy/v1`,
        apiKey: proxyToken,
        model: modelLabel,
      },
    });
  } catch (error) {
    if (error instanceof TranslateWorkerError && error.status === 429) {
      // 这台队列满：清绑定让位，下轮重选别台，不消耗 attempt
      await writeJobParams(jobId, { ...params, workerId: undefined });
      await prisma.jobQueue.updateMany({
        where: { id: jobId, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      return;
    }
    if (
      error instanceof TranslateWorkerError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      // 确定性 4xx（413 超限/401 token 错/400 参数错）：立即终态失败并退款
      await failJob(jobId, error, { retryable: false });
      return;
    }
    throw error; // 5xx/网络错：外层按可重试失败处理
  }

  await writeJobParams(jobId, { ...params, workerId: target.id });
  busyByWorkerId.set(target.id, (busyByWorkerId.get(target.id) ?? 0) + 1);
  await markTaskTranslating(task.id, target.id);
  translateLogger.info(
    { jobId, taskId: task.id, worker: target.name },
    '文档翻译任务已派发给 worker'
  );
}

async function markTaskTranslating(taskId: string, workerId: string): Promise<void> {
  await prisma.translationTask.updateMany({
    where: { id: taskId, status: { in: ['PENDING', 'TRANSLATING'] } },
    data: { status: 'TRANSLATING', workerId, errorMessage: null },
  });
}

// ─── 对账 ───

interface JobRow {
  id: string;
  startedAt: Date | null;
  attempt: number;
  maxAttempts: number;
  params: string | null;
}

async function reconcileProcessingJob(
  job: JobRow,
  fleet: TranslateFleetConfig
): Promise<void> {
  const params = parseJobParams(job.params);
  const task = await loadTask(params.taskId);
  if (!task || task.status === 'CANCELED') {
    const bound = workerById(fleet, params.workerId);
    if (bound) await deleteTranslateJob(bound, job.id).catch(() => undefined);
    if (task) await deleteTaskFiles(task.id).catch(() => undefined);
    await prisma.jobQueue.updateMany({
      where: { id: job.id, status: JOB_STATUS.PROCESSING },
      data: {
        status: JOB_STATUS.FAILED,
        error: task ? '用户已取消' : '翻译任务已删除',
        completedAt: new Date(),
      },
    });
    return;
  }

  const bound = workerById(fleet, params.workerId);
  if (!bound) {
    // PROCESSING 却无有效绑定（那台被删/禁用）：回炉重派（dispatch 会逐台找回）
    await prisma.jobQueue.updateMany({
      where: { id: job.id, status: JOB_STATUS.PROCESSING },
      data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
    });
    return;
  }

  let remote: TranslateJobStatus;
  try {
    remote = await getTranslateJob(bound, job.id);
  } catch (error) {
    if (error instanceof TranslateWorkerError && error.status === 404) {
      // worker 重启弄丢任务：清绑定回炉重推（jobId 不变，幂等）
      await writeJobParams(job.id, { ...params, workerId: undefined });
      await prisma.jobQueue.updateMany({
        where: { id: job.id, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      translateLogger.info(
        { jobId: job.id, taskId: task.id, worker: bound.name },
        'worker 侧任务丢失，回炉重派'
      );
      return;
    }
    throw error;
  }

  switch (remote.status) {
    case 'succeeded':
      await harvestJob(job.id, task, bound);
      return;
    case 'failed':
      await deleteTranslateJob(bound, job.id).catch(() => undefined);
      await failJob(job.id, new Error(remote.error || 'worker 翻译失败'), {
        retryable: true,
      });
      return;
    default: {
      // queued/running：进度回写 task 行（用户轮询直接读 task；变化才写）
      const percent = Number.isFinite(remote.progress)
        ? Math.max(0, Math.min(99, Math.round(remote.progress)))
        : 0;
      if (params.progress?.percent !== percent || params.progress?.stage !== (remote.stage ?? null)) {
        await writeJobParams(job.id, {
          ...params,
          progress: { stage: remote.stage ?? null, percent, at: new Date().toISOString() },
        });
        await prisma.translationTask
          .updateMany({
            where: { id: task.id, status: 'TRANSLATING' },
            data: { progress: percent },
          })
          .catch(() => undefined);
      }
      const startedAt = job.startedAt?.getTime() ?? Date.now();
      if (Date.now() - startedAt > MAX_WORKER_RUNTIME_MS) {
        await deleteTranslateJob(bound, job.id).catch(() => undefined);
        await failJob(job.id, new Error('worker 翻译超时'), { retryable: true });
      }
    }
  }
}

// ─── 收割与失败 ───

async function harvestJob(
  jobId: string,
  task: TaskRow,
  worker: TranslateWorkerConfig
): Promise<void> {
  // mono 必得；dual 允许缺（worker 侧按参数可能只产单语）
  const mono = await downloadTranslateOutput(worker, jobId, 'mono');
  let dual: { data: Buffer } | null = null;
  try {
    dual = await downloadTranslateOutput(worker, jobId, 'dual');
  } catch (error) {
    if (!(error instanceof TranslateWorkerError) || error.status !== 404) {
      throw error;
    }
  }

  const monoPath = await saveOutputFile(task.id, 'mono', mono.data);
  const dualPath = dual ? await saveOutputFile(task.id, 'dual', dual.data) : null;

  const updated = await prisma.translationTask.updateMany({
    where: { id: task.id, status: { in: ['PENDING', 'TRANSLATING'] } },
    data: {
      status: 'COMPLETED',
      progress: 100,
      monoPath,
      dualPath,
      errorMessage: null,
      completedAt: new Date(),
      proxyTokenHash: null, // 任务终态即吊销代理凭据
    },
  });
  if (updated.count === 0) {
    // 任务在下载期间被取消/删除：清落盘产物，调度行终态
    await deleteTaskFiles(task.id).catch(() => undefined);
    await prisma.jobQueue.updateMany({
      where: { id: jobId, status: JOB_STATUS.PROCESSING },
      data: { status: JOB_STATUS.FAILED, error: '任务已取消', completedAt: new Date() },
    });
    await deleteTranslateJob(worker, jobId).catch(() => undefined);
    return;
  }

  await prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.SUCCESS,
        result: JSON.stringify({
          monoPath,
          dualPath,
          monoBytes: mono.data.length,
          dualBytes: dual?.data.length ?? null,
        }),
        completedAt: new Date(),
      },
    })
    .catch((err) =>
      translateLogger.warn({ jobId, err: serializeError(err) }, '标记任务成功失败')
    );
  await deleteTranslateJob(worker, jobId).catch(() => undefined);
  notifyTaskFinished(task.id, 'completed');
  translateLogger.info(
    { jobId, taskId: task.id, monoBytes: mono.data.length },
    '文档翻译完成并已回存'
  );
}

async function failJob(
  jobId: string,
  error: unknown,
  options: { retryable: boolean }
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const job = await prisma.jobQueue.findUnique({ where: { id: jobId } });
  if (!job) return;

  const canRetry = options.retryable && job.attempt < job.maxAttempts;
  const params = parseJobParams(job.params);
  if (canRetry) {
    const backoff = RETRY_BACKOFF_MS[Math.min(job.attempt - 1, RETRY_BACKOFF_MS.length - 1)];
    params.nextRetryAt = new Date(Date.now() + backoff).toISOString();
  } else {
    delete params.nextRetryAt;
  }

  await prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.FAILED,
        error: message.slice(0, 1000),
        params: JSON.stringify(params),
        completedAt: new Date(),
      },
    })
    .catch((err) =>
      translateLogger.warn({ jobId, err: serializeError(err) }, '标记任务失败失败')
    );

  const taskId = params.taskId;
  if (taskId) {
    if (canRetry) {
      // 等待自动重试期间对用户仍显示「翻译中」，不闪失败
      await prisma.translationTask
        .updateMany({
          where: { id: taskId, status: 'TRANSLATING' },
          data: { errorMessage: null },
        })
        .catch(() => undefined);
    } else {
      await prisma.translationTask
        .updateMany({
          where: { id: taskId, status: { in: ['PENDING', 'TRANSLATING'] } },
          data: {
            status: 'FAILED',
            errorMessage: message.slice(0, 500),
            proxyTokenHash: null,
          },
        })
        .catch(() => undefined);
      await refundTaskCharge(taskId, '翻译失败自动退款');
      notifyTaskFinished(taskId, 'failed');
    }
  }
  translateLogger.warn(
    { jobId, taskId, retryable: canRetry, error: message },
    canRetry ? '文档翻译失败，稍后自动重试' : '文档翻译终态失败'
  );
}

/**
 * 终态失败/取消的全额退款。幂等闸：refundedAt 的条件 CAS 抢占（赢家才真正入账），
 * 杜绝「对账与取消路由并发都退一次」的双退。chargedCents=0（未扣费）直接跳过。
 */
export async function refundTaskCharge(taskId: string, note: string): Promise<void> {
  const claimed = await prisma.translationTask.updateMany({
    where: { id: taskId, refundedAt: null, chargedCents: { gt: 0 } },
    data: { refundedAt: new Date() },
  });
  if (claimed.count === 0) return;
  const task = await prisma.translationTask.findUnique({
    where: { id: taskId },
    select: { userId: true, chargedCents: true },
  });
  if (!task) return;
  try {
    await refundWalletCents({
      userId: task.userId,
      amountCents: task.chargedCents,
      type: 'translation_refund',
      note: `${note} doc-translate:${taskId}`,
    });
  } catch (error) {
    // 入账失败则收回幂等闸，让下一轮兜底重试
    await prisma.translationTask
      .updateMany({ where: { id: taskId }, data: { refundedAt: null } })
      .catch(() => undefined);
    translateLogger.error(
      { taskId, err: serializeError(error) },
      '翻译退款入账失败（已还原退款闸，等待重试）'
    );
  }
}

/** 完成/失败通知（邮件接偶合放 emailNotify 模块；fire-and-forget，不阻塞调度） */
function notifyTaskFinished(taskId: string, outcome: 'completed' | 'failed'): void {
  import('@/lib/translate/notify')
    .then(({ sendDocTranslateNotification }) =>
      sendDocTranslateNotification(taskId, outcome)
    )
    .catch(() => undefined);
}
