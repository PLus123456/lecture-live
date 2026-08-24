import 'server-only';

import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
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
  deleteOutputGeneration,
} from '@/lib/translate/taskStorage';
import { logger, serializeError } from '@/lib/logger';

/**
 * 文档翻译调度器（tick 对账制状态机，与 enhanceProcessor 同构）。
 *
 * 真源分工：JobQueue(type=doc_translate) 是**调度**真源（claim/attempt/退避），
 * TranslationTask 是**业务**真源（用户可见状态/进度/产物/计费）。worker 侧 id
 * 由 JobQueue id + proxyGeneration 派生；同一调度行自动重试也不会让旧代远端副作用
 * 命中新代任务，中断后下一轮 tick 仍可按同一派生 id 找回。
 *
 * 状态流转（JobQueue.status / TranslationTask.status）：
 *   SUBMITTED / PENDING     → 已确认扣费待派发（含自动重试回炉）
 *   PROCESSING / TRANSLATING → worker 排队或翻译中，每轮 tick 对账回写进度
 *   SUCCESS / COMPLETED     → mono/dual 已回存本地，代理凭据失效
 *   FAILED / TRANSLATING|FAILED → 可重试失败对用户仍显示处理中；终态失败自动全额退款
 *
 * 推进途径：1) ws 进程 startDocTranslateLoop 周期 tick；2) 任务状态路由 fire-and-forget
 * 踢一脚。多进程并发安全靠 claim 的条件 updateMany 抢占。
 *
 * ─── 代次不变式（generation invariant，本文件最重要的一条规矩）───
 *
 * `TranslationTask.jobQueueId` 是**代次令牌**：它指向"当前这一代"调度行。
 * 用户 retry 会把任务重置回 PENDING、重新扣一次费、并换一条全新的调度行
 *（retry 路由事务里先把 jobQueueId 置 null，再由 enqueueDocTranslate 绑到新行）。
 * 于是同一个 taskId 上可能同时存在**上一代的在途逻辑**和**新一代的任务行**。
 *
 * 不变式：**调度器里所有对 TranslationTask 的写、以及所有对任务目录的 rm -rf，
 * 都必须带 `jobQueueId: <自己这一代的 jobId>` 谓词。**
 *
 * 漏一处的后果都是真金白银级的（这一簇 bug 全部出自"漏了谓词"）：
 *   - harvest 漏 → 旧代产物把新一代标成 COMPLETED，新代收割再 rm -rf 删光整个目录
 *     = 用户看到"已完成"但文件 404，且新扣的钱不退（H4）；
 *   - markTaskTranslating 漏 → 旧 worker 的 workerId 被写进新一代，用户取消时停错台（M12）；
 *   - 进度回写漏 → 旧代低进度反复盖掉新代真实进度，进度条回跳（M13）；
 *   - issueProxyToken 漏 → 唯一索引互相覆盖，其中一台 worker 的 LLM 调用全 401（M11）；
 *   - 绑定漏 → 双进程孤儿扫描各建一行都绑定成功，同一份 PDF 翻两遍（M11）。
 *
 * 两道防线：① 派发入口先比 `task.jobQueueId / task.proxyGeneration` 早退（省掉无谓的
 *   worker 往返与副作用，并顺手清掉远端任务、终态化本代调度行）；
 * ② 每一次写都带 `jobQueueId + proxyGeneration` 谓词（原子、不受 TOCTOU 影响，这才是
 *   权威防线）。只有 ① 没有 ② 不作数。
 */

const translateLogger = logger.child({ component: 'doc-translate' });

/**
 * 单任务在 worker 侧最长滞留：大文档（数百页 × QPS 限速）给足 3 小时。
 * H5：导出是为了让单测能钉住「僵尸回收阈值必须严格大于它」这条跨模块不变式 ——
 * 这两个常量当初就是各改各的漂移开的（jobQueue 的 2h < 这里的 3h），必然误杀。
 */
export const MAX_WORKER_RUNTIME_MS = 180 * 60_000;
/**
 * 任务级**绝对死线**：一个 TranslationTask 允许停留在非终态（PENDING/TRANSLATING）的总时长。
 *
 * 为什么单有 MAX_WORKER_RUNTIME_MS 不够：`job.startedAt` 在**每一次重派时都被清空**
 *（回炉 SUBMITTED 的五处、以及 retryJob），所以那 3 小时其实是「每一次派发」的预算，
 * 不是任务总预算。整个 worker 机队长期不可达时，任务就在 SUBMITTED ↔ PROCESSING 之间
 * 无限弹跳、永不终态：用户侧永远显示「翻译中」，而 chargedCents 一直押着不退。
 * 机队被整个删掉/停用（getTranslateFleetConfig 返回 null）时更彻底 —— 连 tick 都直接早退。
 *
 * 取值 24h 的理由：一次完整的合法重试链最长 ≈ 3 次派发 × 3h + 退避(5+20+45min) ≈ 9.5h，
 * 24h 留了 2.5 倍余量；同时必须严格大于僵尸回收阈值（4h）与单次运行上限（3h），
 * 三者的序关系由 translateGeneration.test.ts 的跨模块不变式测试钉死 —— 它们当初就是
 * 各改各的漂移开的（H5 的成因）。
 *
 * **锚点**是 `max(TranslationTask.createdAt, 本代 JobQueue 行的 createdAt)`，不是裸的任务
 * createdAt：用户 retry 复用同一个 TranslationTask 行（createdAt 不变）但会换一条全新的调度行，
 * 若只看任务 createdAt，隔天来点一次重试会被本扫描当场打死 —— 钱虽然退了，重试却等于不可用。
 * 而调度行的 createdAt 在「弹跳」这条真正的病态路径上是稳定的（五处回炉只清 startedAt、
 * 不新建行），死线照样咬得住。
 */
export const MAX_TASK_LIFETIME_MS = 24 * 60 * 60_000;
/** 自动重试退避（按已消耗 attempt 索引） */
const RETRY_BACKOFF_MS = [5 * 60_000, 20 * 60_000, 45 * 60_000];
const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * claim 到 worker start 之间要读取源文件并最多上传 10 分钟。其他进程的
 * reconcile 在这个窗口内不得把“PROCESSING 但尚未写 workerId”误判为孤儿。
 * 真崩溃最迟 12 分钟回炉；所有旧 dispatch 还受 proxyGeneration CAS 二次保护。
 */
const DISPATCH_START_GRACE_MS = 12 * 60_000;
/**
 * L23：孤儿任务（PENDING 但没有调度行）的补入队宽限期。
 * 正常路径里「扣费事务提交 → enqueueDocTranslate 写回 jobQueueId」只隔几十毫秒，
 * 取 2 分钟足以避开正常窗口，又不至于让真正的孤儿等太久。
 */
const ORPHAN_TASK_GRACE_MS = 2 * 60_000;
/**
 * H6：绑定台连续不可达多久之后解绑重派。
 * 断电/域名失效的 worker 会让对账每轮都在 getTranslateJob 上抛错，任务干等着那台复活。
 * 取 10 分钟：足够跨过一次重启/短暂网络抖动，又不至于让用户等上小时级。
 */
const WORKER_UNREACHABLE_REBIND_MS = 10 * 60_000;

interface TranslateJobParams {
  /** 业务行 id（TranslationTask） */
  taskId?: string;
  /** 任务绑定的 worker 行 id（多台时由派发选定；后续对账/收割/清理都走它） */
  workerId?: string;
  /** 每次 SUBMITTED→PROCESSING 换新，同一 JobQueue id 回炉也不复用。 */
  proxyGeneration?: string;
  /** worker 侧 generation-scoped id；可由 job id + proxyGeneration 确定性重建。 */
  remoteJobId?: string;
  dispatchState?: 'claiming' | 'started';
  nextRetryAt?: string;
  progress?: { stage: string | null; percent: number; at: string };
  /** H6：绑定台首次不可达的时刻（ISO）；任何一次成功对账即清除 */
  unreachableSince?: string;
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

/**
 * worker 协议只接受 1..64 位 `[A-Za-z0-9_-]`。固定 64 位 hex 同时隐藏内部
 * JobQueue id，并确保同一 DB 行的不同调度代绝不复用远端副作用命名空间。
 */
export function translationRemoteJobId(
  jobQueueId: string,
  proxyGeneration: string
): string {
  return crypto
    .createHash('sha256')
    .update('translation-worker-generation-v1\0')
    .update(jobQueueId)
    .update('\0')
    .update(proxyGeneration)
    .digest('hex');
}

function remoteJobIdFor(
  jobQueueId: string,
  proxyGeneration: string | null | undefined
): string {
  return proxyGeneration
    ? translationRemoteJobId(jobQueueId, proxyGeneration)
    : jobQueueId;
}

// ─── 入队（由确认扣费路由调用） ───

/**
 * 把已确认扣费的翻译任务入队（幂等：task 已关联在途 JobQueue 行则复用）。
 * 返回 jobId；创建失败返回 null（调用方回滚扣费）。
 */
export async function enqueueDocTranslate(taskId: string, userId: string): Promise<string | null> {
  let createdJobId: string | null = null;
  try {
    const task = await prisma.translationTask.findUnique({
      where: { id: taskId },
      select: { jobQueueId: true, updatedAt: true },
    });
    if (!task) return null; // 行已被删：别留一条没人认领的调度行占派发槽
    if (task.jobQueueId) {
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
    createdJobId = jobId;
    // L23：绑定失败（任务被并发取消/删除、或状态已不是 PENDING）时必须把刚建的调度行
    // 就地终态化。原来用的是会抛的 prisma.update：抛出后外层 catch 只 return null，
    // 那行永远留在 SUBMITTED 里，每轮 tick 都被捞进 take(totalSlots)、白占一个全局派发槽。
    // M11：绑定必须是对**读到的那个代次令牌**的 CAS，不能只看 status。
    // tick 同时跑在 ws 进程和每个 API 进程里（runDocTranslateTick 的 globalThis 互斥仅
    // 进程内），两个进程的孤儿扫描可以同时捞到同一条 jobQueueId=null 的任务、各自 createJob，
    // 只带 `status: 'PENDING'` 的话两次绑定会**先后都成功**：两条 SUBMITTED 行都被派发，
    // 同一份 PDF 翻两遍、两笔 worker 费用，且 issueProxyToken 互相覆盖唯一索引，
    // 其中一台的 LLM 调用当场全 401。
    // 用读到的旧值做谓词（null 或上一条已终态的行 id）→ 只有第一个写入者能命中。
    const bound = await prisma.translationTask.updateMany({
      where: {
        id: taskId,
        status: 'PENDING',
        jobQueueId: null,
        updatedAt: task?.updatedAt,
      },
      data: { jobQueueId: jobId },
    });
    if (bound.count === 0) {
      await prisma.jobQueue
        .updateMany({
          where: { id: jobId, status: JOB_STATUS.SUBMITTED },
          data: {
            status: JOB_STATUS.FAILED,
            error: '入队时任务状态已变化',
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      const winner = await prisma.translationTask.findUnique({
        where: { id: taskId },
        select: { status: true, jobQueueId: true },
      });
      if (
        winner?.jobQueueId &&
        (winner.status === 'PENDING' || winner.status === 'TRANSLATING')
      ) {
        return winner.jobQueueId;
      }
      return null;
    }
    return jobId;
  } catch (error) {
    // bind update 的提交响应可能丢失；先从业务真源读回，已绑定有效行就复用，
    // 不能让上层把正在派发的任务误标失败并退款。
    try {
      const current = await prisma.translationTask.findUnique({
        where: { id: taskId },
        select: { status: true, jobQueueId: true },
      });
      if (
        current?.jobQueueId &&
        (current.status === 'PENDING' || current.status === 'TRANSLATING')
      ) {
        const currentJob = await prisma.jobQueue.findUnique({
          where: { id: current.jobQueueId },
          select: { status: true },
        });
        if (
          currentJob &&
          currentJob.status !== JOB_STATUS.SUCCESS &&
          currentJob.status !== JOB_STATUS.FAILED
        ) {
          return current.jobQueueId;
        }
      }
      if (createdJobId) {
        await prisma.jobQueue.updateMany({
          where: { id: createdJobId, status: JOB_STATUS.SUBMITTED },
          data: {
            status: JOB_STATUS.FAILED,
            error: '入队绑定失败',
            completedAt: new Date(),
          },
        });
      }
    } catch {
      // readback 也失败时提交状态未知，保留行等待后续 tick 对账，不能猜测退款。
    }
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

  // 0) 任务级绝对死线。**必须排在下面 `if (!fleet)` 早退之前** —— 机队被停用/删空正是
  // 任务永久挂起的形态之一（连 tick 都进不来），死线放在早退之后就永远够不着它。
  await enforceTaskLifetimeDeadlines(fleet).catch((error) =>
    translateLogger.warn(
      { err: serializeError(error) },
      '任务生存期死线扫描异常（下轮重试）'
    )
  );

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
    const params = parseJobParams(job.params);
    if (!params.nextRetryAt) continue;
    if (job.attempt >= job.maxAttempts) continue;
    if (new Date(params.nextRetryAt).getTime() > now) continue;
    const retried = await retryJob(job.id);
    if (retried) {
      translateLogger.info(
        { jobId: job.id, attempt: job.attempt + 1 },
        '文档翻译任务自动重试回炉'
      );
    }
  }

  // 2.4) H5：断链任务自愈 —— 调度行已终态，业务行却还停在非终态。
  //
  // 通用僵尸回收（jobQueue.reclaimStaleProcessingJobs）是 updateMany 直改 job 行、
  // **绕过 failJob**：它不回写 TranslationTask、不退 chargedCents、不发通知、
  // 也不写 params.nextRetryAt（上面那圈自动重试要求该字段存在，没有就直接 continue）。
  // 结果是任务永久停在 TRANSLATING（前端一直转圈）、钱滞留在系统里，而且行已非 PROCESSING
  // → 上面第 1 步的对账永远捞不到它，worker 就算翻完也没人收割。
  // 进程在 failJob 的「先写 job 行、再写 task 行」中间被 kill、以及 admin 手动改状态，
  // 都会落到同一形态。
  //
  // 这里按业务行反查（在途任务数量受机队容量约束，很小）：只要它绑定的调度行已终态
  // 且没有排定自动重试，就补跑一次 failJob —— 还有 attempt 就排退避重试，
  // 用光了就终态失败 + 全额退款 + 通知。failJob 自带代次谓词，跨代不会误伤。
  const strandedTasks = await prisma.translationTask.findMany({
    where: {
      status: { in: ['PENDING', 'TRANSLATING'] },
      jobQueueId: { not: null },
      updatedAt: { lt: new Date(now - ORPHAN_TASK_GRACE_MS) },
    },
    select: { id: true, jobQueueId: true },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  });
  for (const stranded of strandedTasks) {
    const jobId = stranded.jobQueueId;
    if (!jobId) continue;
    const jobRow = await prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, status: true, params: true },
    });
    if (!jobRow || jobRow.type !== JOB_TYPE.DOC_TRANSLATE) continue;
    if (jobRow.status !== JOB_STATUS.FAILED && jobRow.status !== JOB_STATUS.SUCCESS) {
      continue; // 还在途，正常推进中
    }
    if (parseJobParams(jobRow.params).nextRetryAt) continue; // 已排重试，等它自己回炉
    translateLogger.warn(
      { jobId, taskId: stranded.id, jobStatus: jobRow.status },
      '调度链断裂（调度行已终态但任务未结算），补做失败结算'
    );
    await failJob(jobId, new Error('调度中断，已自动补做结算'), {
      retryable: true,
    }).catch((error) =>
      translateLogger.warn(
        { jobId, taskId: stranded.id, err: serializeError(error) },
        '断链任务补结算失败（下轮重试）'
      )
    );
  }

  // 2.5) L23：捞回「扣了费但没有调度行」的孤儿任务。
  // 扣费必须先于建行（建行的 params 需要 taskId），confirm/retry 两条路由都是
  // 「事务里扣费 → 事务外 enqueueDocTranslate」。进程在这两步之间挂掉（部署/OOM）时，
  // 任务永久停在 PENDING + jobQueueId=null：钱扣了、没有任何调度器认识它、
  // 用户界面上是一个永远转圈的任务。宽限期避开正常请求内那几十毫秒的窗口。
  const orphanedTasks = await prisma.translationTask.findMany({
    where: {
      status: 'PENDING',
      jobQueueId: null,
      updatedAt: { lt: new Date(Date.now() - ORPHAN_TASK_GRACE_MS) },
    },
    select: { id: true, userId: true },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  });
  for (const orphan of orphanedTasks) {
    const jobId = await enqueueDocTranslate(orphan.id, orphan.userId);
    translateLogger.warn(
      { taskId: orphan.id, jobId },
      jobId ? '补入队已扣费但无调度行的翻译任务' : '孤儿翻译任务补入队失败（下轮重试）'
    );
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
    let proxyGeneration: string | null = null;
    try {
      proxyGeneration = await claimJob(job);
    } catch (error) {
      // 一条被并发取消/换绑的 poisoned SUBMITTED 行不能中止整个 tick，
      // 否则后续所有合法任务都会长期饿死。
      translateLogger.warn(
        { jobId: job.id, err: serializeError(error) },
        '翻译任务 claim 失败，跳过该行继续派发'
      );
      const taskId = parseJobParams(job.params).taskId;
      if (taskId) {
        try {
          const current = await prisma.translationTask.findUnique({
            where: { id: taskId },
            select: { status: true, jobQueueId: true },
          });
          if (
            !current ||
            current.jobQueueId !== job.id ||
            current.status === 'CANCELED' ||
            current.status === 'COMPLETED' ||
            current.status === 'FAILED'
          ) {
            await prisma.jobQueue.updateMany({
              where: { id: job.id, status: JOB_STATUS.SUBMITTED },
              data: {
                status: JOB_STATUS.FAILED,
                error: '调度行未绑定当前任务',
                completedAt: new Date(),
              },
            });
          }
        } catch {
          // DB 状态也不可确认时保留 SUBMITTED，下轮重试，不能误杀可能有效的行。
        }
      }
      continue;
    }
    if (!proxyGeneration) continue;
    await dispatchJob(
      job,
      proxyGeneration,
      fleet,
      busyByWorkerId,
      healthCache
    ).catch(async (error) => {
      translateLogger.warn(
        { jobId: job.id, err: serializeError(error) },
        '文档翻译任务派发异常'
      );
      await failJob(job.id, error, { retryable: true }, proxyGeneration);
    });
  }
}

/**
 * 任务级绝对死线扫描：把在非终态停留超过 MAX_TASK_LIFETIME_MS 的任务终态化 + **退款**。
 *
 * 必须走 `failJob(..., { retryable: false })`，不能图省事用裸 updateMany —— 只有 failJob 会
 * 跑 refundTaskCharge（释放押着的 chargedCents，这正是本扫描存在的全部意义）、发失败通知、
 * 并带上 L24 代次谓词。绕过它就等于没修。
 *
 * 与既有机制的关系：
 *  - retryable:false ⇒ failJob 会 `delete params.nextRetryAt`，第 2 步的到期自动重试因此
 *    不会把它再捞回炉（那圈明确要求 nextRetryAt 存在）；
 *  - 任务随即变 FAILED，第 2.4 步 H5 断链自愈的 `status in [PENDING, TRANSLATING]` 不再匹配，
 *    两者不会互相打架，也没有造出 H5 捞不到的新形态；
 *  - 退避（RETRY_BACKOFF_MS / params.nextRetryAt）不受影响：它只作用于 retryable 的失败。
 */
async function enforceTaskLifetimeDeadlines(
  fleet: TranslateFleetConfig | null,
  now: number = Date.now()
): Promise<void> {
  const cutoff = new Date(now - MAX_TASK_LIFETIME_MS);
  // 命中 @@index([status, createdAt])。jobQueueId 非空是硬前提：failJob 的入参就是代次令牌，
  // 没有调度行的孤儿由第 2.5 步补入队，下一轮再落到这里。
  const candidates = await prisma.translationTask.findMany({
    where: {
      status: { in: ['PENDING', 'TRANSLATING'] },
      createdAt: { lt: cutoff },
      jobQueueId: { not: null },
    },
    select: { id: true, jobQueueId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  for (const task of candidates) {
    const jobId = task.jobQueueId;
    if (!jobId) continue;
    const job = await prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, status: true, params: true, createdAt: true },
    });
    if (!job || job.type !== JOB_TYPE.DOC_TRANSLATE) continue;
    // 锚点取较晚者（见 MAX_TASK_LIFETIME_MS 注释）：本代调度行还年轻 = 用户刚重试过，放行。
    if (job.createdAt.getTime() >= cutoff.getTime()) continue;

    // best-effort 收掉 worker 侧可能还在的那份任务（机队不可达时必然失败，无所谓）。
    const bound = fleet ? workerById(fleet, parseJobParams(job.params).workerId) : null;
    if (bound) await deleteTranslateJob(bound, job.id).catch(() => undefined);

    translateLogger.warn(
      {
        jobId,
        taskId: task.id,
        taskCreatedAt: task.createdAt.toISOString(),
        jobCreatedAt: job.createdAt.toISOString(),
        jobStatus: job.status,
      },
      '文档翻译任务超过最长生存期，终止并退款'
    );
    await failJob(jobId, new Error('文档翻译超时未完成，已终止并退款'), {
      retryable: false,
    }).catch((error) =>
      translateLogger.warn(
        { jobId, taskId: task.id, err: serializeError(error) },
        '死线终止失败（下轮重试）'
      )
    );
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
  remoteJobId: string
): Promise<{ worker: TranslateWorkerConfig; remote: TranslateJobStatus } | null> {
  for (const worker of fleet.workers) {
    try {
      const remote = await getTranslateJob(worker, remoteJobId);
      return { worker, remote };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 条件抢占：SUBMITTED → PROCESSING（跨进程唯一赢家）。旧 worker token
 * 的吊销必须与调度行重新变为 PROCESSING 同事务；否则两步之间的
 * 窗口会让上一代凭据再次通过 proxy post-claim 调度检查。
 */
async function claimJob(job: JobRow): Promise<string | null> {
  const taskId = parseJobParams(job.params).taskId;
  if (!taskId) return null;
  const proxyGeneration = crypto.randomBytes(32).toString('hex');
  const params: TranslateJobParams = {
    ...parseJobParams(job.params),
    workerId: undefined,
    proxyGeneration,
    remoteJobId: translationRemoteJobId(job.id, proxyGeneration),
    dispatchState: 'claiming',
  };
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.jobQueue.updateMany({
      where: { id: job.id, status: JOB_STATUS.SUBMITTED },
      data: {
        status: JOB_STATUS.PROCESSING,
        startedAt: new Date(),
        params: JSON.stringify(params),
      },
    });
    if (claimed.count !== 1) return null;
    const revoked = await tx.translationTask.updateMany({
      where: {
        id: taskId,
        jobQueueId: job.id,
        proxyGeneration: null,
        status: { in: ['PENDING', 'TRANSLATING'] },
      },
      data: { proxyTokenHash: null, proxyGeneration, workerId: null },
    });
    if (revoked.count !== 1) {
      throw new Error('翻译任务代次已变更，拒绝重新调度');
    }
    return proxyGeneration;
  });
}

function generationMarker(proxyGeneration: string): string {
  return `\"proxyGeneration\":\"${proxyGeneration}\"`;
}

/**
 * 只能把调用方所持的 dispatch 代次回炉。JobQueue 状态转换和任务
 * token/代次撤销同事务：新 claim 必须等这个行锁提交后才能写新代次，
 * 因此旧进程不会清掉新 worker 的凭据。
 */
async function requeueClaimedJob(
  taskId: string,
  jobId: string,
  proxyGeneration: string
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const requeued = await tx.jobQueue.updateMany({
      where: {
        id: jobId,
        status: JOB_STATUS.PROCESSING,
        params: { contains: generationMarker(proxyGeneration) },
      },
      data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
    });
    if (requeued.count !== 1) return false;
    const revoked = await tx.translationTask.updateMany({
      where: { id: taskId, jobQueueId: jobId, proxyGeneration },
      data: {
        proxyTokenHash: null,
        proxyGeneration: null,
        workerId: null,
      },
    });
    if (revoked.count !== 1) {
      throw new Error('翻译任务代次已变更，拒绝回炉');
    }
    return true;
  });
}

/** migration 期无 generation 的 PROCESSING 行也必须用完整 params 快照 CAS。 */
async function requeueLegacyJob(taskId: string, job: JobRow): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const requeued = await tx.jobQueue.updateMany({
      where: {
        id: job.id,
        status: JOB_STATUS.PROCESSING,
        params: job.params,
      },
      data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
    });
    if (requeued.count !== 1) return false;
    const revoked = await tx.translationTask.updateMany({
      where: {
        id: taskId,
        jobQueueId: job.id,
        proxyGeneration: null,
        status: { in: ['PENDING', 'TRANSLATING'] },
      },
      data: { proxyTokenHash: null, workerId: null },
    });
    if (revoked.count !== 1) {
      throw new Error('翻译任务 legacy 代次已变更，拒绝回炉');
    }
    return true;
  });
}

async function writeJobParamsForGeneration(
  jobId: string,
  proxyGeneration: string,
  params: TranslateJobParams
): Promise<void> {
  const updated = await prisma.jobQueue.updateMany({
    where: {
      id: jobId,
      status: JOB_STATUS.PROCESSING,
      params: { contains: generationMarker(proxyGeneration) },
    },
    data: { params: JSON.stringify(params) },
  });
  if (updated.count !== 1) {
    throw new Error('翻译调度代次已变更');
  }
}

/**
 * 写回 JobQueue.params 的统一入口：
 *  - 有 proxyGeneration → 代次谓词 CAS（`writeJobParamsForGeneration`）；
 *  - legacy 行（无代次）→ 退回「完整 params 快照」CAS，语义等价。
 * 两者都保证「代次/快照已变更」时写不进去，不会把新一代的绑定改回旧 worker。
 */
async function writeJobParamsSnapshot(
  job: JobRow,
  proxyGeneration: string | null,
  params: TranslateJobParams
): Promise<void> {
  if (proxyGeneration) {
    await writeJobParamsForGeneration(job.id, proxyGeneration, params);
    return;
  }
  const updated = await prisma.jobQueue.updateMany({
    where: {
      id: job.id,
      status: JOB_STATUS.PROCESSING,
      params: job.params,
    },
    data: { params: JSON.stringify(params) },
  });
  if (updated.count !== 1) {
    throw new Error('翻译调度 legacy 快照已变更');
  }
}

async function writeLegacyProgress(
  job: JobRow,
  params: TranslateJobParams,
  taskId: string,
  percent: number
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.jobQueue.updateMany({
      where: {
        id: job.id,
        status: JOB_STATUS.PROCESSING,
        params: job.params,
      },
      data: { params: JSON.stringify(params) },
    });
    if (updated.count !== 1) {
      throw new Error('翻译调度 legacy 快照已变更');
    }
    const taskUpdated = await tx.translationTask.updateMany({
      where: {
        id: taskId,
        jobQueueId: job.id,
        proxyGeneration: null,
        status: 'TRANSLATING',
      },
      data: { progress: percent },
    });
    if (taskUpdated.count !== 1) {
      throw new Error('翻译任务 legacy 快照已变更');
    }
  });
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
      proxyGeneration: true,
      workerId: true,
      monoPath: true,
      dualPath: true,
      // L24：代次令牌 —— 清盘/退款前必须确认任务仍绑在当前这一代调度行上
      jobQueueId: true,
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

/**
 * 签发凭据与当前调度代次/TRANSLATING 状态做一次 CAS。这必须先于
 * worker start，否则远端刚启动就回调代理时会看到 PENDING 而收到401。
 */
async function issueProxyToken(
  taskId: string,
  jobId: string,
  workerId: string,
  proxyGeneration: string
): Promise<{ raw: string; hash: string }> {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.$transaction(async (tx) => {
    // 写入同一 JobQueue 行取 X lock，并同时校验它仍是调用方的
    // PROCESSING 代次。回炉事务要么先清代次，要么等这里提交后再清 token。
    const guarded = await tx.jobQueue.updateMany({
      where: {
        id: jobId,
        status: JOB_STATUS.PROCESSING,
        params: { contains: generationMarker(proxyGeneration) },
      },
      data: { startedAt: new Date() },
    });
    if (guarded.count !== 1) {
      throw new Error('翻译调度代次已变更，拒绝签发代理凭据');
    }
    const issued = await tx.translationTask.updateMany({
      where: {
        id: taskId,
        jobQueueId: jobId,
        proxyGeneration,
        status: { in: ['PENDING', 'TRANSLATING'] },
      },
      data: {
        proxyTokenHash: hash,
        status: 'TRANSLATING',
        workerId,
        errorMessage: null,
      },
    });
    if (issued.count !== 1) {
      throw new Error('翻译任务代次已变更，拒绝签发代理凭据');
    }
  });
  return { raw, hash };
}

async function dispatchJob(
  job: JobRow,
  proxyGeneration: string,
  fleet: TranslateFleetConfig,
  busyByWorkerId: Map<string, number>,
  healthCache: Map<string, { ok: boolean; load: number }>
): Promise<void> {
  const jobId = job.id;
  const remoteJobId = translationRemoteJobId(jobId, proxyGeneration);
  const params: TranslateJobParams = {
    ...parseJobParams(job.params),
    proxyGeneration,
    remoteJobId,
    dispatchState: 'claiming',
    workerId: undefined,
  };
  const task = await loadTask(params.taskId);
  if (!task) {
    await failJob(
      jobId,
      new Error('翻译任务已删除'),
      { retryable: false },
      proxyGeneration
    );
    return;
  }
  if (
    task.jobQueueId !== jobId ||
    task.proxyGeneration !== proxyGeneration ||
    task.status === 'CANCELED' ||
    task.status === 'COMPLETED'
  ) {
    // claim 后的业务真源必须仍精确绑定本 generation；否则 provider 前失败关闭。
    const bound = workerById(fleet, params.workerId);
    if (bound) {
      await deleteTranslateJob(bound, remoteJobId).catch(() => undefined);
    }
    await prisma.jobQueue.updateMany({
      where: {
        id: jobId,
        status: JOB_STATUS.PROCESSING,
        params: { contains: generationMarker(proxyGeneration) },
      },
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
      located = {
        worker: bound,
        remote: await getTranslateJob(bound, remoteJobId),
      };
    } catch (error) {
      if (!(error instanceof TranslateWorkerError) || error.status !== 404) {
        throw error; // 绑定台网络异常：保持 PROCESSING 下轮重试
      }
    }
  } else {
    located = await findJobOnFleet(fleet, remoteJobId);
  }

  if (located) {
    if (located.worker.id !== params.workerId) {
      await writeJobParamsForGeneration(jobId, proxyGeneration, {
        ...params,
        workerId: located.worker.id,
      });
    }
    if (located.remote.status === 'succeeded') {
      await harvestJob(jobId, task, located.worker, proxyGeneration);
      return;
    }
    if (located.remote.status === 'queued' || located.remote.status === 'running') {
      await markTaskTranslating(
        task.id,
        located.worker.id,
        jobId,
        proxyGeneration
      );
      return;
    }
    // created / failed：留在这台重推
  }

  const target = located?.worker ?? (await pickWorker(fleet, busyByWorkerId, healthCache));
  if (!target) {
    // 全部不可达/占满：让位回 SUBMITTED，不消耗 attempt
    await requeueClaimedJob(task.id, jobId, proxyGeneration);
    return;
  }

  const source = await readSourceFile(task.id);
  if (!source) {
    await failJob(
      jobId,
      new Error('源文件读取失败'),
      { retryable: false },
      proxyGeneration
    );
    return;
  }

  const settings = await getSiteSettings();
  const appUrl = settings.site_url.replace(/\/+$/, '');

  // 派发时解析任务实际使用的模型：① 生成真实模型标识下发（pdf2zh 缓存按模型分键，
  // 换模型不再复用旧译文）；② 解析出具体路由行且任务尚无快照时定格回 task.modelId，
  // 让代理端点全程恒定同一模型（中途 admin 换全局默认不影响在途任务）。
  const boundId =
    task.modelId || (await resolveUserTranslationModelId(task.user));
  const resolved = await resolveGroupBoundModel(boundId, 'TRANSLATION');
  const resolvedDbId =
    resolved?.provider?.dbModelId && resolved.provider.purpose === 'TRANSLATION'
      ? resolved.provider.dbModelId
      : null;
  if (!resolvedDbId) {
    throw new Error('无法持久化翻译模型快照，拒绝启动 worker');
  }
  if (task.modelId && task.modelId !== resolvedDbId) {
    throw new Error('翻译模型快照解析不一致，拒绝启动 worker');
  }
  if (!task.modelId) {
    let snapshotCount = 0;
    let snapshotError: unknown;
    try {
      const snapshotted = await prisma.translationTask.updateMany({
        where: {
          id: task.id,
          jobQueueId: jobId,
          proxyGeneration,
          status: { in: ['PENDING', 'TRANSLATING'] },
          modelId: null,
        },
        data: { modelId: resolvedDbId },
      });
      snapshotCount = snapshotted.count;
    } catch (error) {
      snapshotError = error;
    }
    if (snapshotCount !== 1) {
      const current = await prisma.translationTask.findUnique({
        where: { id: task.id },
        select: {
          jobQueueId: true,
          proxyGeneration: true,
          status: true,
          modelId: true,
        },
      });
      if (
        current?.jobQueueId !== jobId ||
        current.proxyGeneration !== proxyGeneration ||
        (current.status !== 'PENDING' && current.status !== 'TRANSLATING') ||
        current.modelId !== resolvedDbId
      ) {
        throw snapshotError ?? new Error('翻译模型快照写入未生效');
      }
    }
  }
  const modelLabel = buildWorkerModelLabel(resolved?.provider ?? null);

  let issuedProxy: { raw: string; hash: string } | null = null;
  try {
    await uploadTranslateInput(target, remoteJobId, source);
    issuedProxy = await issueProxyToken(
      task.id,
      jobId,
      target.id,
      proxyGeneration
    );
    await startTranslateJob(target, remoteJobId, {
      langIn: task.sourceLang,
      langOut: task.targetLang,
      qps: target.qps,
      watermark: fleet.watermark,
      glossary: parseGlossary(task.glossaryJson),
      llm: {
        baseUrl: `${appUrl}/api/translate/llm-proxy/v1`,
        apiKey: issuedProxy.raw,
        model: modelLabel,
      },
    });
  } catch (error) {
    if (error instanceof TranslateWorkerError && error.status === 429) {
      // 这台队列满：清绑定让位，下轮重选别台，不消耗 attempt
      await deleteTranslateJob(target, remoteJobId).catch(() => undefined);
      await requeueClaimedJob(task.id, jobId, proxyGeneration);
      return;
    }
    if (
      error instanceof TranslateWorkerError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      // 确定性 4xx（413 超限/401 token 错/400 参数错）：立即终态失败并退款
      await deleteTranslateJob(target, remoteJobId).catch(() => undefined);
      await failJob(jobId, error, { retryable: false }, proxyGeneration);
      return;
    }
    if (issuedProxy) {
      // start 请求已携带本代 token 发出，网络/5xx 无法证明远端未接受。
      // 保持本代 PROCESSING+token，下一 tick 查 worker 真实状态；若实际 404
      // 再原子回炉。此处若直接 fail/retry，已运行的远端只持旧 token，会连续 401。
      try {
        await writeJobParamsForGeneration(jobId, proxyGeneration, {
          ...params,
          workerId: target.id,
          dispatchState: 'started',
        });
      } catch (writeError) {
        // token/workerId 已先在 TranslationTask 事务化落库。这里若是 DB 响应丢失
        // 或旧代 CAS 失败，都不能再进入外层 failJob 吊销可能正在使用的 token；
        // 下一 tick 会用 task.workerId 找回远端，或由新代 CAS 自然隔离旧 dispatch。
        translateLogger.warn(
          {
            jobId,
            taskId: task.id,
            worker: target.name,
            err: serializeError(writeError),
          },
          '记录不确定 worker start 绑定失败，保留本代凭据等待对账'
        );
      }
      translateLogger.warn(
        { jobId, taskId: task.id, worker: target.name, err: serializeError(error) },
        'worker start 结果不确定，保留本代凭据等待对账'
      );
      return;
    }
    // token 尚未签发，远端不可能进行付费回调；若 upload 响应丢失只会留下
    // created 壳，尽力按本 generation id 清理后再让外层走可重试失败。
    await deleteTranslateJob(target, remoteJobId).catch(() => undefined);
    throw error; // 5xx/网络错：外层按可重试失败处理
  }

  try {
    await writeJobParamsForGeneration(jobId, proxyGeneration, {
      ...params,
      workerId: target.id,
      dispatchState: 'started',
    });
  } catch (writeError) {
    // start 已成功返回后仍必须按“远端已运行”处理；params 辅助写失败不能
    // 反向终结 JobQueue/吊销 token。task.workerId 是下一 tick 的 durable fallback。
    translateLogger.warn(
      {
        jobId,
        taskId: task.id,
        worker: target.name,
        err: serializeError(writeError),
      },
      '记录 worker start 绑定失败，保留本代凭据等待对账'
    );
  }
  busyByWorkerId.set(target.id, (busyByWorkerId.get(target.id) ?? 0) + 1);
  translateLogger.info(
    { jobId, taskId: task.id, worker: target.name },
    '文档翻译任务已派发给 worker'
  );
}

async function markTaskTranslating(
  taskId: string,
  workerId: string,
  jobId: string,
  proxyGeneration: string
): Promise<void> {
  const marked = await prisma.translationTask.updateMany({
    where: {
      id: taskId,
      jobQueueId: jobId,
      proxyGeneration,
      status: { in: ['PENDING', 'TRANSLATING'] },
    },
    data: { status: 'TRANSLATING', workerId, errorMessage: null },
  });
  if (marked.count !== 1) {
    throw new Error('翻译任务代次已变更');
  }
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
  const paramsGeneration = params.proxyGeneration ?? null;
  if (task?.status === 'COMPLETED' && task.jobQueueId === job.id) {
    // Task CAS 已发布、JobQueue SUCCESS 尚未提交的正常间隙。第三个 tick 不能
    // 因 task 已清 proxyGeneration 而把同一行标 FAILED；完整 params 快照 CAS
    // 又确保旧 generation 快照无法收敛当前新代。
    const converged = await prisma.jobQueue.updateMany({
      where: {
        id: job.id,
        status: JOB_STATUS.PROCESSING,
        params: job.params,
      },
      data: {
        status: JOB_STATUS.SUCCESS,
        result: JSON.stringify({
          monoPath: task.monoPath,
          dualPath: task.dualPath,
          reconciledAfterPublish: true,
        }),
        completedAt: new Date(),
      },
    });
    if (converged.count === 1) {
      const bound = workerById(fleet, params.workerId);
      if (bound) {
        await deleteTranslateJob(
          bound,
          remoteJobIdFor(job.id, paramsGeneration)
        ).catch(() => undefined);
      }
    }
    return;
  }
  const ownsTaskGeneration =
    task?.jobQueueId === job.id &&
    (paramsGeneration
      ? task.proxyGeneration === paramsGeneration
      : task.proxyGeneration === null);
  if (!task || task.status === 'CANCELED' || !ownsTaskGeneration) {
    // 旧 legacy 行在用户 retry 换绑后，绝不能借用新任务的 generation/worker。
    // CANCELED 的 source 也必须保留：产品允许取消后重试，物理删除路由才清目录。
    const staleGeneration = params.proxyGeneration ?? null;
    const bound = workerById(
      fleet,
      params.workerId ??
        (ownsTaskGeneration && paramsGeneration
          ? task?.workerId ?? undefined
          : undefined)
    );
    if (bound) {
      await deleteTranslateJob(
        bound,
        remoteJobIdFor(job.id, staleGeneration)
      ).catch(() => undefined);
    }
    await prisma.jobQueue.updateMany({
      where: {
        id: job.id,
        status: JOB_STATUS.PROCESSING,
        // 精确快照 CAS 也保护无 generation 的迁移期 legacy 行，防迟到对账
        // 把同一 JobQueue 行的新 claim 终结。
        params: job.params,
      },
      data: {
        status: JOB_STATUS.FAILED,
        error: !task
          ? '翻译任务已删除'
          : task.status === 'CANCELED'
            ? '用户已取消'
            : '翻译任务已换代',
        completedAt: new Date(),
      },
    });
    return;
  }

  // 远端 identity 只能来自当前 JobQueue params 快照；绝不能从 task fallback，
  // 因为自动 retry 会复用同一 JobQueue id，而 task 已可能属于新 generation。
  const proxyGeneration = paramsGeneration;
  const remoteJobId = remoteJobIdFor(job.id, proxyGeneration);
  const paramsBound = workerById(fleet, params.workerId);
  if (!paramsBound) {
    if (
      proxyGeneration &&
      job.startedAt &&
      Date.now() - job.startedAt.getTime() < DISPATCH_START_GRACE_MS
    ) {
      // 另一进程可能正在最长 10 分钟的上传/start 窗口。issueProxyToken
      // 会先把 workerId 写进 task，但 start 尚未发出时远端仍会返回404；这里必须
      // 先等 grace，不能因 task.workerId fallback 提前回炉并吊销刚签发的 token。
      return;
    }
  }
  // start 后 params 辅助写若响应丢失，task.workerId 是 durable fallback；grace
  // 结束后先按它查询远端，再决定是否回炉。
  const bound =
    paramsBound ??
    (proxyGeneration
      ? workerById(fleet, task.workerId ?? undefined)
      : null);
  if (!bound) {
    // PROCESSING 却无有效绑定（那台被删/禁用）：回炉重派（dispatch 会逐台找回）
    if (proxyGeneration) {
      await requeueClaimedJob(task.id, job.id, proxyGeneration);
    } else {
      await requeueLegacyJob(task.id, job);
    }
    return;
  }

  let remote: TranslateJobStatus;
  try {
    remote = await getTranslateJob(bound, remoteJobId);
  } catch (error) {
    if (error instanceof TranslateWorkerError && error.status === 404) {
      // worker 重启弄丢任务：清绑定回炉重推（jobId 不变，幂等）
      if (proxyGeneration) {
        await requeueClaimedJob(task.id, job.id, proxyGeneration);
      } else {
        await requeueLegacyJob(task.id, job);
      }
      translateLogger.info(
        { jobId: job.id, taskId: task.id, worker: bound.name },
        'worker 侧任务丢失，回炉重派'
      );
      return;
    }
    // H6 下半段：绑定台连不上（断电 / 域名失效 / 持续 5xx）。原来一路 throw 上去，
    // 由 executeTick 吞成「下轮重试」，任务就干等着那台自己复活 —— 可能永远不会。
    // 连续不可达超过阈值就解绑回炉，让 pickWorker（带健康探测）把它挪到活着的台上。
    const firstFailureMs = Number.isFinite(
      new Date(params.unreachableSince ?? '').getTime()
    )
      ? new Date(params.unreachableSince as string).getTime()
      : Date.now();
    if (Date.now() - firstFailureMs >= WORKER_UNREACHABLE_REBIND_MS) {
      await writeJobParamsSnapshot(
        job,
        proxyGeneration,
        { ...params, workerId: undefined, unreachableSince: undefined }
      );
      await prisma.jobQueue.updateMany({
        where: { id: job.id, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      translateLogger.warn(
        { jobId: job.id, taskId: task.id, worker: bound.name },
        'worker 持续不可达，解绑重派'
      );
      return;
    }
    if (!params.unreachableSince) {
      await writeJobParamsSnapshot(job, proxyGeneration, {
        ...params,
        unreachableSince: new Date(firstFailureMs).toISOString(),
      });
    }
    throw error;
  }

  // 拿到状态了 = 那台还活着，清掉不可达计时（否则一次抖动会永久拉高后续判定的基线）
  if (params.unreachableSince) {
    params.unreachableSince = undefined;
    await writeJobParamsSnapshot(job, proxyGeneration, {
      ...params,
      unreachableSince: undefined,
    });
  }

  switch (remote.status) {
    case 'succeeded':
      await harvestJob(
        job.id,
        task,
        bound,
        proxyGeneration ?? undefined,
        job.params
      );
      return;
    case 'failed':
      await deleteTranslateJob(bound, remoteJobId).catch(() => undefined);
      await failJob(job.id, new Error(remote.error || 'worker 翻译失败'), {
        retryable: true,
      }, proxyGeneration ?? undefined, proxyGeneration ? undefined : job.params);
      return;
    case 'created':
      // upload 已完成但 start 尚未可靠发生时只存在未运行壳。精确删除本代
      // remote id 并回炉，不能把 created 当 running 挂到总超时。
      await deleteTranslateJob(bound, remoteJobId).catch(() => undefined);
      if (proxyGeneration) {
        await requeueClaimedJob(task.id, job.id, proxyGeneration);
      } else {
        await requeueLegacyJob(task.id, job);
      }
      return;
    default: {
      // queued/running：进度回写 task 行（用户轮询直接读 task；变化才写）
      const percent = Number.isFinite(remote.progress)
        ? Math.max(0, Math.min(99, Math.round(remote.progress)))
        : 0;
      if (params.progress?.percent !== percent || params.progress?.stage !== (remote.stage ?? null)) {
        const nextParams = {
          ...params,
          progress: { stage: remote.stage ?? null, percent, at: new Date().toISOString() },
        };
        if (proxyGeneration) {
          await writeJobParamsForGeneration(
            job.id,
            proxyGeneration,
            nextParams
          );
          await prisma.translationTask
            .updateMany({
              where: {
                id: task.id,
                jobQueueId: job.id,
                proxyGeneration,
                status: 'TRANSLATING',
              },
              data: { progress: percent },
            })
            .catch(() => undefined);
        } else {
          await writeLegacyProgress(job, nextParams, task.id, percent);
        }
      }
      const startedAt = job.startedAt?.getTime() ?? Date.now();
      if (Date.now() - startedAt > MAX_WORKER_RUNTIME_MS) {
        await deleteTranslateJob(bound, remoteJobId).catch(() => undefined);
        await failJob(
          job.id,
          new Error('worker 翻译超时'),
          { retryable: true },
          proxyGeneration ?? undefined,
          proxyGeneration ? undefined : job.params
        );
      }
    }
  }
}

// ─── 收割与失败 ───

async function harvestJob(
  jobId: string,
  task: TaskRow,
  worker: TranslateWorkerConfig,
  proxyGeneration?: string,
  expectedLegacyParams?: string | null
): Promise<void> {
  const remoteJobId = remoteJobIdFor(jobId, proxyGeneration);
  // mono 必得；dual 允许缺（worker 侧按参数可能只产单语）
  const mono = await downloadTranslateOutput(worker, remoteJobId, 'mono');
  let dual: { data: Buffer } | null = null;
  try {
    dual = await downloadTranslateOutput(worker, remoteJobId, 'dual');
  } catch (error) {
    if (!(error instanceof TranslateWorkerError) || error.status !== 404) {
      throw error;
    }
  }

  // 每次 harvest 都写唯一 attempt 目录。同 generation 的两个 tick 也不会互相
  // rename/删除；CAS winner 发布自己的精确引用，loser 只能清自己的 attempt。
  const storageGeneration = proxyGeneration ?? jobId;
  const storageAttempt = crypto
    .createHash('sha256')
    .update('translation-output-attempt-v1\0')
    .update(storageGeneration)
    .update('\0')
    .update(crypto.randomBytes(32))
    .digest('hex');
  let monoPath: string;
  let dualPath: string | null;
  try {
    monoPath = await saveOutputFile(
      task.id,
      'mono',
      mono.data,
      storageAttempt
    );
    dualPath = dual
      ? await saveOutputFile(
          task.id,
          'dual',
          dual.data,
          storageAttempt
        )
      : null;
  } catch (error) {
    await deleteOutputGeneration(task.id, storageAttempt).catch(
      () => undefined
    );
    throw error;
  }

  let publishCount = 0;
  let publishError: unknown;
  try {
    const taskPublish: Prisma.TranslationTaskUpdateManyArgs = {
      where: {
        id: task.id,
        jobQueueId: jobId,
        ...(proxyGeneration
          ? { proxyGeneration }
          : { proxyGeneration: null }),
        status: { in: ['PENDING', 'TRANSLATING'] },
      },
      data: {
        status: 'COMPLETED',
        progress: 100,
        monoPath,
        dualPath,
        errorMessage: null,
        completedAt: new Date(),
        proxyTokenHash: null, // 任务终态即吊销代理凭据
        proxyGeneration: null,
      },
    };
    const updated = proxyGeneration
      ? await prisma.translationTask.updateMany(taskPublish)
      : await prisma.$transaction(async (tx) => {
          if (expectedLegacyParams === undefined) {
            throw new Error('legacy harvest 缺少 JobQueue params 快照');
          }
          // 先锁住并验证 legacy 调度真源。requeue-first 时这里 count=0；
          // publish-first 时 requeue 随后会因 Task 已终态而整笔回滚。
          const owned = await tx.jobQueue.updateMany({
            where: {
              id: jobId,
              status: JOB_STATUS.PROCESSING,
              params: expectedLegacyParams,
            },
            data: { params: expectedLegacyParams },
          });
          if (owned.count !== 1) return { count: 0 };
          return tx.translationTask.updateMany(taskPublish);
        });
    publishCount = updated.count;
  } catch (error) {
    publishError = error;
  }

  if (publishCount !== 1) {
    let publishedByThisGeneration = false;
    let sameGenerationStillActive = false;
    let completedBySameJobGeneration = false;
    try {
      const current = await prisma.translationTask.findUnique({
        where: { id: task.id },
        select: {
          status: true,
          jobQueueId: true,
          proxyGeneration: true,
          monoPath: true,
          dualPath: true,
        },
      });
      const currentJob = await prisma.jobQueue.findUnique({
        where: { id: jobId },
        select: { status: true, params: true },
      });
      publishedByThisGeneration =
        current?.status === 'COMPLETED' &&
        current.jobQueueId === jobId &&
        current.monoPath === monoPath &&
        current.dualPath === dualPath;
      sameGenerationStillActive =
        current?.jobQueueId === jobId &&
        (current.status === 'PENDING' || current.status === 'TRANSLATING') &&
        (proxyGeneration
          ? current.proxyGeneration === proxyGeneration
          : current.proxyGeneration === null);
      const jobStillRepresentsCaller = proxyGeneration
        ? currentJob?.params?.includes(generationMarker(proxyGeneration)) ===
          true
        : currentJob?.params === expectedLegacyParams;
      completedBySameJobGeneration =
        current?.status === 'COMPLETED' &&
        current.jobQueueId === jobId &&
        typeof current.monoPath === 'string' &&
        jobStillRepresentsCaller &&
        (currentJob?.status === JOB_STATUS.PROCESSING ||
          currentJob?.status === JOB_STATUS.SUCCESS);
      if (completedBySameJobGeneration && current) {
        // 另一个同代 harvest 已赢得 Task CAS。使用 winner 的引用收敛同一
        // JobQueue，当前 loser 只清自己的唯一 attempt，绝不能把队列改 FAILED。
        await deleteOutputGeneration(task.id, storageAttempt).catch(
          () => undefined
        );
        monoPath = current.monoPath as string;
        dualPath = current.dualPath;
      }
    } catch (readbackError) {
      // DB 提交结果未知时不能删除 staged generation：它可能正是 task 已发布路径。
      throw publishError ?? readbackError;
    }
    if (publishedByThisGeneration) {
      // update 已提交但响应丢失；继续收敛 JobQueue，保留已发布文件。
      publishCount = 1;
    } else if (completedBySameJobGeneration) {
      publishCount = 1;
    } else if (sameGenerationStillActive) {
      // readback 已确认发布未提交，故只清本次 attempt；若 readback 本身失败，
      // 上面的 catch 会保留它，避免误删已提交但响应丢失的产物。
      await deleteOutputGeneration(task.id, storageAttempt).catch(
        () => undefined
      );
      throw publishError ?? new Error('翻译产物发布未完成');
    }
  }

  if (publishCount !== 1) {
    await deleteOutputGeneration(task.id, storageAttempt).catch(
      () => undefined
    );
    // 任务在下载期间被取消/删除/换代：只终结调用方 generation 的调度行。
    await prisma.jobQueue.updateMany({
      where: {
        id: jobId,
        status: JOB_STATUS.PROCESSING,
        ...(proxyGeneration
          ? { params: { contains: generationMarker(proxyGeneration) } }
          : { params: expectedLegacyParams }),
      },
      data: { status: JOB_STATUS.FAILED, error: '任务已取消', completedAt: new Date() },
    });
    await deleteTranslateJob(worker, remoteJobId).catch(() => undefined);
    return;
  }

  await prisma.jobQueue
    .updateMany({
      where: {
        id: jobId,
        status: JOB_STATUS.PROCESSING,
        ...(proxyGeneration
          ? { params: { contains: generationMarker(proxyGeneration) } }
          : { params: expectedLegacyParams }),
      },
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
  await deleteTranslateJob(worker, remoteJobId).catch(() => undefined);
  notifyTaskFinished(task.id, 'completed');
  translateLogger.info(
    { jobId, taskId: task.id, monoBytes: mono.data.length },
    '文档翻译完成并已回存'
  );
}

async function failJob(
  jobId: string,
  error: unknown,
  options: { retryable: boolean },
  expectedGeneration?: string,
  expectedLegacyParams?: string | null
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

  const failed = await prisma.jobQueue
    .updateMany({
      where: {
        id: jobId,
        ...(expectedGeneration
          ? {
              status: JOB_STATUS.PROCESSING,
              params: { contains: generationMarker(expectedGeneration) },
            }
          : expectedLegacyParams !== undefined
            ? {
                status: JOB_STATUS.PROCESSING,
                params: expectedLegacyParams,
              }
            : {}),
      },
      data: {
        status: JOB_STATUS.FAILED,
        error: message.slice(0, 1000),
        params: JSON.stringify(params),
        completedAt: new Date(),
      },
    })
    .catch((err) => {
      translateLogger.warn(
        { jobId, err: serializeError(err) },
        '标记任务失败失败'
      );
      return { count: 0 };
    });
  if (failed.count !== 1) return;

  const taskId = params.taskId;
  if (taskId) {
    // L24：所有对 TranslationTask 的写都带 `jobQueueId: jobId` 代次谓词。
    // 用户 retry 会把任务重置回 PENDING + 重新扣一次费 + 换一条新调度行，此时若上一代的
    // failJob 才姗姗来迟，它会把刚重试的任务打成 FAILED 并退掉**新一代**的钱
    //（refundedAt 被 retry 清成 null，幂等闸拦不住）——用户白拿一次翻译。
    // TranslationTask.jobQueueId 就是天然的代次令牌：retry 事务里先置 null，
    // 再由 enqueueDocTranslate 绑到新行，旧代次的谓词永远匹配不上。
    if (canRetry) {
      // 等待自动重试期间对用户仍显示「翻译中」，不闪失败
      await prisma.translationTask
        .updateMany({
          where: {
            id: taskId,
            jobQueueId: jobId,
            ...(expectedGeneration
              ? { proxyGeneration: expectedGeneration }
              : expectedLegacyParams !== undefined
                ? { proxyGeneration: null }
                : {}),
            status: { in: ['PENDING', 'TRANSLATING'] },
          },
          data: {
            errorMessage: null,
            proxyTokenHash: null,
            proxyGeneration: null,
          },
        })
        .catch(() => undefined);
    } else {
      const marked = await prisma.translationTask
        .updateMany({
          where: {
            id: taskId,
            jobQueueId: jobId,
            ...(expectedGeneration
              ? { proxyGeneration: expectedGeneration }
              : expectedLegacyParams !== undefined
                ? { proxyGeneration: null }
                : {}),
            status: { in: ['PENDING', 'TRANSLATING'] },
          },
          data: {
            status: 'FAILED',
            errorMessage: message.slice(0, 500),
            proxyTokenHash: null,
            proxyGeneration: null,
          },
        })
        .catch(() => ({ count: 0 }));
      if (marked.count > 0) {
        await refundTaskCharge(taskId, '翻译失败自动退款', jobId);
        notifyTaskFinished(taskId, 'failed');
      }
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
 *
 * L22：CAS 抢占 + 读金额 + 钱包入账三步必须同事务。原来是三条独立语句，
 * 中间任一步挂掉都会留下「refundedAt 已写、钱没到账」的状态 —— 幂等闸从此挡住所有重试，
 * 这笔钱永久消失（补偿写 refundedAt=null 本身也可能挂）。refundWalletCents 本就收
 * 可选 tx 参数，包进来后失败即整体回滚，refundedAt 自动还原，不需要任何补偿写。
 *
 * L24：可选代次守卫。调度器可按 jobQueueId 守卫；HTTP 路由必须传完整终态快照
 *（status/jobQueueId/proxyGeneration/chargedCents），防止迟到请求退掉重试后新扣的费用。
 */
export async function refundTaskCharge(
  taskId: string,
  note: string,
  expectation?:
    | string
    | {
        status: 'FAILED' | 'CANCELED';
        jobQueueId: string | null;
        proxyGeneration: string | null;
        chargedCents: number;
        updatedAt: Date;
      }
): Promise<{ claimed: boolean; updatedAt?: Date }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const refundAt = new Date(
        expectation && typeof expectation !== 'string'
          ? Math.max(Date.now(), expectation.updatedAt.getTime() + 1)
          : Date.now()
      );
      const claimed = await tx.translationTask.updateMany({
        where: {
          id: taskId,
          refundedAt: null,
          chargedCents:
            expectation && typeof expectation !== 'string'
              ? { equals: expectation.chargedCents, gt: 0 }
              : { gt: 0 },
          ...(typeof expectation === 'string'
            ? { jobQueueId: expectation }
            : expectation
              ? {
                  status: expectation.status,
                  jobQueueId: expectation.jobQueueId,
                  proxyGeneration: expectation.proxyGeneration,
                  updatedAt: expectation.updatedAt,
                }
              : {}),
        },
        data: { refundedAt: refundAt, updatedAt: refundAt },
      });
      if (claimed.count === 0) return { claimed: false };
      const task = await tx.translationTask.findUnique({
        where: { id: taskId },
        select: { userId: true, chargedCents: true },
      });
      if (!task) {
        throw new Error('Translation refund target disappeared');
      }
      await refundWalletCents(
        {
          userId: task.userId,
          amountCents: task.chargedCents,
          type: 'translation_refund',
          note: `${note} doc-translate:${taskId}`,
        },
        tx
      );
      return { claimed: true, updatedAt: refundAt };
    });
  } catch (error) {
    // 事务已整体回滚（refundedAt 自动还原），兜底路径下轮重试
    translateLogger.error(
      { taskId, err: serializeError(error) },
      '翻译退款入账失败（事务已回滚，等待重试）'
    );
    return { claimed: false };
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
