import 'server-only';

import { prisma } from '@/lib/prisma';
import { JOB_TYPE, JOB_STATUS, createJob, retryJob } from '@/lib/jobQueue';
import {
  loadSessionAudioArtifact,
  stageArtifact,
  finalizeStagedArtifactPublish,
  rollbackStagedArtifact,
} from '@/lib/sessionPersistence';
import {
  getEnhanceWorkerConfig,
  uploadEnhanceInput,
  startEnhanceJob,
  getEnhanceJob,
  downloadEnhanceOutput,
  deleteEnhanceJob,
  EnhanceWorkerError,
  type EnhanceWorkerConfig,
} from '@/lib/audio/enhanceWorkerClient';
import { logger, serializeError } from '@/lib/logger';

/**
 * 音频增强调度器（tick 对账制状态机）。
 *
 * JobQueue(type=audio_enhance) 是任务唯一真源；worker 侧 jobId 直接用 JobQueue 行 id，
 * 天然幂等：任何一步中断后，下一次 tick 通过「查 worker 实际状态」续接，不重复处理。
 *
 * 状态流转（JobQueue.status / Session.audioEnhanceStatus）：
 *   SUBMITTED/pending   → 待派发（含自动重试回炉），claim 后推音频给 worker
 *   PROCESSING/processing → worker 排队或处理中，每轮 tick 对账
 *   SUCCESS/completed   → 结果已回存（enhancedAudioPath 就绪）
 *   FAILED/failed|pending → 失败；attempt 未用尽且到达退避时间则自动 retryJob 回 SUBMITTED
 *
 * 推进途径有两条（与「异步文件转录靠前端轮询驱动」惯例一致）：
 *   1) ws 进程的 startAudioEnhanceLoop 周期 tick（无人在线也推进）；
 *   2) enhance-status / enhance-audio 路由 fire-and-forget 踢一脚（页面打开时快速推进）。
 * 多进程并发安全靠 claim 的条件 updateMany（SUBMITTED→PROCESSING 抢占）保证。
 */

const enhanceLogger = logger.child({ component: 'audio-enhance' });

/** 单任务在 worker 侧的最长滞留时长；超时视为失败重试（jobQueue 2h stale 回收之前主动处理） */
const MAX_WORKER_RUNTIME_MS = 100 * 60_000;
/** 自动重试退避（按已消耗的 attempt 次数索引）；admin 手动重试不受此限制 */
const RETRY_BACKOFF_MS = [5 * 60_000, 20 * 60_000, 45 * 60_000];
const DEFAULT_MAX_ATTEMPTS = 3;

interface EnhanceJobParams {
  nextRetryAt?: string;
  [key: string]: unknown;
}

function parseJobParams(raw: string | null): EnhanceJobParams {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as EnhanceJobParams) : {};
  } catch {
    return {};
  }
}

// ─── 入队 ───

export interface EnqueueEnhanceOptions {
  sessionId: string;
  userId: string;
  triggeredBy?: string;
}

/**
 * 把一个会话的音频增强任务入队（幂等：已有在途任务直接复用）。
 * 门禁（站点开关/组能力/会话状态）由调用方负责；这里只管队列与展示状态。
 * 返回 jobId；创建失败返回 null（不抛，入队属 best-effort 增值路径）。
 */
export async function enqueueAudioEnhance(
  options: EnqueueEnhanceOptions
): Promise<string | null> {
  try {
    const existing = await prisma.jobQueue.findFirst({
      where: {
        type: JOB_TYPE.AUDIO_ENHANCE,
        sessionId: options.sessionId,
        status: { in: [JOB_STATUS.SUBMITTED, JOB_STATUS.PROCESSING] },
      },
      select: { id: true },
    });
    if (existing) {
      return existing.id;
    }

    const jobId = await createJob({
      type: JOB_TYPE.AUDIO_ENHANCE,
      sessionId: options.sessionId,
      userId: options.userId,
      triggeredBy: options.triggeredBy ?? 'system',
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
    if (!jobId) {
      return null;
    }

    await prisma.session.updateMany({
      where: { id: options.sessionId },
      data: { audioEnhanceStatus: 'pending', audioEnhanceError: null },
    });
    return jobId;
  } catch (error) {
    enhanceLogger.warn(
      { sessionId: options.sessionId, err: serializeError(error) },
      '音频增强任务入队失败'
    );
    return null;
  }
}

/**
 * 带完整门禁的自动入队（finalize 收尾时调用，fire-and-forget）：
 * 站点开关 + worker 已配置 + 会话拥有者所属组开启 allowAudioEnhance 三关全过才入队，
 * 入队后立刻踢一次 tick 加速派发。任何失败都只记录，绝不影响 finalize 主流程。
 */
export async function maybeEnqueueAudioEnhanceForSession(options: {
  sessionId: string;
  userId: string;
  triggeredBy?: string;
}): Promise<void> {
  try {
    const config = await getEnhanceWorkerConfig();
    if (!config) {
      return;
    }
    const owner = await prisma.user.findUnique({
      where: { id: options.userId },
      select: { role: true, customGroupId: true },
    });
    if (!owner) {
      return;
    }
    const { resolveUserFeatureFlags } = await import('@/lib/userRoles');
    const flags = await resolveUserFeatureFlags(owner);
    if (!flags.allowAudioEnhance) {
      return;
    }
    const jobId = await enqueueAudioEnhance(options);
    if (jobId) {
      void runAudioEnhanceTick();
    }
  } catch (error) {
    enhanceLogger.warn(
      { sessionId: options.sessionId, err: serializeError(error) },
      '音频增强自动入队检查失败'
    );
  }
}

// ─── tick 主循环 ───

declare global {
  // eslint-disable-next-line no-var
  var __audioEnhanceTickRun: Promise<void> | undefined;
}

/**
 * 推进音频增强状态机一轮（防重入：同进程内已有 tick 在跑则直接搭车等待）。
 * 任何单个任务的异常都被吞掉并记录，绝不让一个坏任务拖垮整轮 tick。
 */
export function runAudioEnhanceTick(): Promise<void> {
  if (globalThis.__audioEnhanceTickRun) {
    return globalThis.__audioEnhanceTickRun;
  }
  const run = executeTick()
    .catch((error) => {
      enhanceLogger.warn({ err: serializeError(error) }, '音频增强 tick 异常');
    })
    .finally(() => {
      globalThis.__audioEnhanceTickRun = undefined;
    });
  globalThis.__audioEnhanceTickRun = run;
  return run;
}

async function executeTick(): Promise<void> {
  const config = await getEnhanceWorkerConfig();
  if (!config) {
    return; // 站点未启用/未配置 worker：静默跳过（入队的任务保留，配置好后自动推进）
  }

  // 1) 对账所有 PROCESSING 任务（收割完成/失败/丢失的）
  const processing = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.AUDIO_ENHANCE, status: JOB_STATUS.PROCESSING },
    orderBy: { startedAt: 'asc' },
  });
  for (const job of processing) {
    await reconcileProcessingJob(job, config).catch((error) => {
      enhanceLogger.warn(
        { jobId: job.id, sessionId: job.sessionId, err: serializeError(error) },
        '音频增强任务对账异常（下轮重试）'
      );
    });
  }

  // 2) 到期的自动重试：FAILED 且未用尽 attempt 且过了退避时间 → 回炉 SUBMITTED
  const failed = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.AUDIO_ENHANCE, status: JOB_STATUS.FAILED },
    orderBy: { completedAt: 'asc' },
    take: 20,
  });
  const now = Date.now();
  for (const job of failed) {
    if (job.attempt >= job.maxAttempts) continue;
    const params = parseJobParams(job.params);
    if (!params.nextRetryAt) continue; // 无重试标记 = 终态失败（或 admin 已手动处理）
    if (new Date(params.nextRetryAt).getTime() > now) continue;
    const retried = await retryJob(job.id);
    if (retried) {
      enhanceLogger.info(
        { jobId: job.id, sessionId: job.sessionId, attempt: job.attempt + 1 },
        '音频增强任务自动重试回炉'
      );
    }
  }

  // 3) 派发新的任务：受 worker 并发配置约束
  const busy = await prisma.jobQueue.count({
    where: { type: JOB_TYPE.AUDIO_ENHANCE, status: JOB_STATUS.PROCESSING },
  });
  const slots = Math.max(0, config.concurrency - busy);
  if (slots === 0) {
    return;
  }
  const submitted = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.AUDIO_ENHANCE, status: JOB_STATUS.SUBMITTED },
    orderBy: { createdAt: 'asc' },
    take: slots,
  });
  for (const job of submitted) {
    const claimed = await claimJob(job.id);
    if (!claimed) continue; // 其它进程抢到了
    await dispatchJob(job.id, job.sessionId, config).catch(async (error) => {
      enhanceLogger.warn(
        { jobId: job.id, sessionId: job.sessionId, err: serializeError(error) },
        '音频增强任务派发异常'
      );
      await failJob(job.id, job.sessionId, error, { retryable: true });
    });
  }
}

/** 条件抢占：SUBMITTED → PROCESSING（跨进程唯一赢家），返回是否拿到。 */
async function claimJob(jobId: string): Promise<boolean> {
  const result = await prisma.jobQueue.updateMany({
    where: { id: jobId, status: JOB_STATUS.SUBMITTED },
    data: { status: JOB_STATUS.PROCESSING, startedAt: new Date() },
  });
  return result.count === 1;
}

// ─── 派发 ───

async function loadSessionForEnhance(sessionId: string | null) {
  if (!sessionId) return null;
  return prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      recordingPath: true,
      transcriptPath: true,
      summaryPath: true,
      enhancedAudioPath: true,
      audioEnhanceStatus: true,
      durationMs: true,
    },
  });
}

async function dispatchJob(
  jobId: string,
  sessionId: string | null,
  config: NonNullable<Awaited<ReturnType<typeof getEnhanceWorkerConfig>>>
): Promise<void> {
  const session = await loadSessionForEnhance(sessionId);
  if (!session || !session.recordingPath) {
    // 会话已删或没有录音：终态失败，不再重试
    await failJob(jobId, sessionId, new Error('会话或录音不存在'), { retryable: false });
    return;
  }

  // 对账 worker 现状：进程中断/stale 回收后重派时，worker 可能早已在跑甚至已完成
  let remote: Awaited<ReturnType<typeof getEnhanceJob>> | null = null;
  try {
    remote = await getEnhanceJob(config, jobId);
  } catch (error) {
    if (!(error instanceof EnhanceWorkerError) || error.status !== 404) {
      throw error;
    }
  }
  if (remote?.status === 'succeeded') {
    await harvestJob(jobId, session, config);
    return;
  }
  if (remote?.status === 'queued' || remote?.status === 'running') {
    await markSessionProcessing(session.id);
    return; // 已在 worker 队列里：保持 PROCESSING，等对账收割
  }

  // 404 / created / failed（半途而废）→ 重推输入并启动
  const audio = await loadSessionAudioArtifact(session);
  if (!audio) {
    await failJob(jobId, session.id, new Error('录音文件读取失败'), { retryable: false });
    return;
  }
  try {
    await uploadEnhanceInput(config, jobId, audio.data, audio.contentType);
    await startEnhanceJob(config, jobId, {
      targetLufs: config.targetLufs,
      attenLimDb: config.attenLimDb,
      denoise: 'auto',
      outputFormat: 'm4a',
    });
  } catch (error) {
    if (error instanceof EnhanceWorkerError && error.status === 429) {
      // worker 队列满：让位回 SUBMITTED，下轮再派，不消耗 attempt
      await prisma.jobQueue.updateMany({
        where: { id: jobId, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      return;
    }
    throw error;
  }
  await markSessionProcessing(session.id);
  enhanceLogger.info({ jobId, sessionId: session.id }, '音频增强任务已派发给 worker');
}

async function markSessionProcessing(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId },
    data: { audioEnhanceStatus: 'processing', audioEnhanceError: null },
  });
}

// ─── 对账 ───

interface JobRow {
  id: string;
  sessionId: string | null;
  startedAt: Date | null;
  attempt: number;
  maxAttempts: number;
  params: string | null;
}

async function reconcileProcessingJob(
  job: JobRow,
  config: NonNullable<Awaited<ReturnType<typeof getEnhanceWorkerConfig>>>
): Promise<void> {
  const session = await loadSessionForEnhance(job.sessionId);
  if (!session) {
    // 会话中途被删：清 worker、终态失败
    await deleteEnhanceJob(config, job.id).catch(() => undefined);
    await failJob(job.id, job.sessionId, new Error('会话已删除'), { retryable: false });
    return;
  }

  let remote: Awaited<ReturnType<typeof getEnhanceJob>>;
  try {
    remote = await getEnhanceJob(config, job.id);
  } catch (error) {
    if (error instanceof EnhanceWorkerError && error.status === 404) {
      // worker 重启弄丢任务：回炉 SUBMITTED，下轮重推输入（jobId 不变，幂等）
      await prisma.jobQueue.updateMany({
        where: { id: job.id, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      enhanceLogger.info(
        { jobId: job.id, sessionId: session.id },
        'worker 侧任务丢失，回炉重派'
      );
      return;
    }
    throw error; // 网络抖动等：保持 PROCESSING，下轮重试对账
  }

  switch (remote.status) {
    case 'succeeded':
      await harvestJob(job.id, session, config);
      return;
    case 'failed':
      await deleteEnhanceJob(config, job.id).catch(() => undefined);
      await failJob(job.id, session.id, new Error(remote.error || 'worker 处理失败'), {
        retryable: true,
      });
      return;
    default: {
      // queued/running：超时守卫（防 worker 假活卡死占坑）
      const startedAt = job.startedAt?.getTime() ?? Date.now();
      if (Date.now() - startedAt > MAX_WORKER_RUNTIME_MS) {
        await deleteEnhanceJob(config, job.id).catch(() => undefined);
        await failJob(job.id, session.id, new Error('worker 处理超时'), { retryable: true });
      }
    }
  }
}

// ─── 收割与失败 ───

async function harvestJob(
  jobId: string,
  session: NonNullable<Awaited<ReturnType<typeof loadSessionForEnhance>>>,
  config: EnhanceWorkerConfig
): Promise<void> {
  const output = await downloadEnhanceOutput(config, jobId);
  const remote = await getEnhanceJob(config, jobId).catch(() => null);

  // 与 finalize 相同的两阶段发布：先写版本化对象，CAS 落库成功后才删旧增强文件
  const staged = await stageArtifact(session, 'recordings', output.data, {
    mimeType: output.contentType || 'audio/mp4',
    previousReference: session.enhancedAudioPath,
  });

  const updated = await prisma.session.updateMany({
    where: { id: session.id },
    data: {
      enhancedAudioPath: staged.reference,
      audioEnhanceStatus: 'completed',
      audioEnhanceError: null,
    },
  });
  if (updated.count === 0) {
    // 会话在下载期间被删：回滚刚写的对象，任务终态失败
    await rollbackStagedArtifact(session, staged);
    await failJob(jobId, session.id, new Error('会话已删除'), { retryable: false });
    return;
  }
  await finalizeStagedArtifactPublish(session, staged).catch(() => undefined);

  await prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.SUCCESS,
        result: JSON.stringify({
          enhancedAudioPath: staged.reference,
          bytes: output.data.length,
          durationMs: remote?.output?.durationMs ?? null,
          denoiseEngine: remote?.output?.denoiseEngine ?? null,
          normalized: remote?.output?.normalized ?? null,
        }),
        completedAt: new Date(),
      },
    })
    .catch((err) =>
      enhanceLogger.warn({ jobId, err: serializeError(err) }, '标记任务成功失败')
    );
  await deleteEnhanceJob(config, jobId).catch(() => undefined);
  enhanceLogger.info(
    { jobId, sessionId: session.id, bytes: output.data.length },
    '音频增强完成并已回存'
  );
}

async function failJob(
  jobId: string,
  sessionId: string | null,
  error: unknown,
  options: { retryable: boolean }
): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const job = await prisma.jobQueue.findUnique({ where: { id: jobId } });
  if (!job) return;

  const canRetry = options.retryable && job.attempt < job.maxAttempts;
  const params = parseJobParams(job.params);
  if (canRetry) {
    const backoff =
      RETRY_BACKOFF_MS[Math.min(job.attempt - 1, RETRY_BACKOFF_MS.length - 1)];
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
      enhanceLogger.warn({ jobId, err: serializeError(err) }, '标记任务失败失败')
    );

  if (sessionId) {
    await prisma.session
      .updateMany({
        where: { id: sessionId },
        // 等待自动重试期间对用户展示 pending（仍在处理中）；终态才是 failed
        data: canRetry
          ? { audioEnhanceStatus: 'pending', audioEnhanceError: null }
          : { audioEnhanceStatus: 'failed', audioEnhanceError: message.slice(0, 500) },
      })
      .catch(() => undefined);
  }
  enhanceLogger.warn(
    { jobId, sessionId, retryable: canRetry, error: message },
    canRetry ? '音频增强失败，稍后自动重试' : '音频增强终态失败'
  );
}
