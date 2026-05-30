import { prisma } from '@/lib/prisma';
import { logSystemEvent } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
import { trackJob, createJob, markJobProcessing, markJobSuccess, markJobFailed, JOB_TYPE, reclaimStaleProcessingJobs } from '@/lib/jobQueue';
import {
  loadRecordingDraftManifest,
} from '@/lib/recordingDraftPersistence';
import {
  loadTranscriptDraftManifest,
} from '@/lib/transcriptDraftPersistence';
import {
  resetExpiredTranscriptionQuotas,
  reconcileStorageBytes,
} from '@/lib/quota';
import { runTranscriptionUsageReconciliation } from '@/lib/reconciliation';
import { finalizeSession } from '@/lib/sessionFinalization';
import { runChatFilesCleanup } from '@/lib/jobs/chatFilesCleanupJob';
import { deleteAsyncUpload } from '@/lib/audio/asyncUploadChunkPersistence';

const STALE_SESSION_THRESHOLD_MS = 4 * 60 * 60_000;
// 异步上传转录的停滞阈值取更大值：Soniox 异步任务在 300 分钟上限文件上偶尔较慢，
// 6 小时仍无进展才判定为僵尸，避免误杀正常的长任务。
const STALE_ASYNC_THRESHOLD_MS = 6 * 60 * 60_000;
// 异步转录状态机里所有"非终态"——卡在任一状态超时都应回收（终态：completed/failed/canceled）
const ASYNC_RECLAIMABLE_STATUSES = [
  'pending_upload',
  'uploading_chunks',
  'transcoding',
  'uploading_to_soniox',
  'transcribing',
  'finalizing',
];
const MAINTENANCE_INTERVAL_MS = 15 * 60_000;
const RECONCILIATION_LAST_RUN_KEY = 'billing.reconciliation.lastRunUtcDate';
const billingLogger = logger.child({ component: 'billing-maintenance' });

type BillingMaintenanceGlobal = typeof globalThis & {
  __lectureLiveBillingMaintenanceStarted?: boolean;
  __lectureLiveBillingMaintenanceTimer?: ReturnType<typeof setInterval>;
  __lectureLiveBillingMaintenanceRun?: Promise<void> | null;
};

export interface BillingMaintenanceSummary {
  resetUsers: number;
  reclaimedSessions: number;
  reclaimedAsyncUploads: number;
  reclaimedStaleJobs: number;
  storageBytesReconciled: number;
  reconciliationRunId: string | null;
  chatFilesCleanup: {
    agingDeleted: number;
    softCapDeleted: number;
    bytesReleased: string; // bigint 序列化为 string，避免 JSON 序列化抛错
    errors: number;
  } | null;
}

export function startBillingMaintenanceLoop(
  intervalMs = MAINTENANCE_INTERVAL_MS
) {
  const globalState = globalThis as BillingMaintenanceGlobal;
  if (globalState.__lectureLiveBillingMaintenanceStarted) {
    return;
  }

  globalState.__lectureLiveBillingMaintenanceStarted = true;

  const triggerRun = () => {
    if (globalState.__lectureLiveBillingMaintenanceRun) {
      return;
    }

    const runPromise = trackJob(
      {
        type: JOB_TYPE.BILLING_MAINTENANCE,
        triggeredBy: 'system',
        params: { source: 'scheduler' },
      },
      () => runBillingMaintenance({ source: 'scheduler' }),
    )
      .catch((error) => {
        billingLogger.error(
          { err: serializeError(error) },
          'Billing maintenance failed'
        );
        logSystemEvent(
          'billing.maintenance.failed',
          JSON.stringify({
            source: 'scheduler',
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        );
      })
      .finally(() => {
        globalState.__lectureLiveBillingMaintenanceRun = null;
      });

    globalState.__lectureLiveBillingMaintenanceRun = runPromise.then(
      () => undefined
    );
  };

  triggerRun();

  const timer = setInterval(triggerRun, intervalMs);
  timer.unref?.();
  globalState.__lectureLiveBillingMaintenanceTimer = timer;
}

export function stopBillingMaintenanceLoop() {
  const globalState = globalThis as BillingMaintenanceGlobal;
  const timer = globalState.__lectureLiveBillingMaintenanceTimer;
  if (timer) {
    clearInterval(timer);
    globalState.__lectureLiveBillingMaintenanceTimer = undefined;
  }
  globalState.__lectureLiveBillingMaintenanceStarted = false;
  globalState.__lectureLiveBillingMaintenanceRun = null;
}

export async function runBillingMaintenance(options?: {
  now?: Date;
  source?: 'scheduler' | 'manual';
}): Promise<BillingMaintenanceSummary> {
  const now = options?.now ?? new Date();
  const source = options?.source ?? 'manual';

  // 配额重置
  let resetUsers = 0;
  {
    const jobId = await createJob({ type: JOB_TYPE.QUOTA_RESET, triggeredBy: 'system', params: { source } });
    if (jobId) markJobProcessing(jobId);
    try {
      resetUsers = await resetExpiredTranscriptionQuotas(now);
      if (jobId) markJobSuccess(jobId, { resetUsers });
    } catch (err) {
      if (jobId) markJobFailed(jobId, err);
      throw err;
    }
  }

  // 过期会话回收
  let reclaimedSessions = 0;
  {
    const jobId = await createJob({ type: JOB_TYPE.STALE_SESSION_RECLAIM, triggeredBy: 'system', params: { source } });
    if (jobId) markJobProcessing(jobId);
    try {
      reclaimedSessions = await reclaimStaleSessions(now);
      if (jobId) markJobSuccess(jobId, { reclaimedSessions });
    } catch (err) {
      if (jobId) markJobFailed(jobId, err);
      throw err;
    }
  }

  // 停滞的异步上传转录回收（与实时 reclaimStaleSessions 是不同状态机，单独扫描）
  let reclaimedAsyncUploads = 0;
  {
    const jobId = await createJob({ type: JOB_TYPE.STALE_SESSION_RECLAIM, triggeredBy: 'system', params: { source, kind: 'async_upload' } });
    if (jobId) markJobProcessing(jobId);
    try {
      reclaimedAsyncUploads = await reclaimStaleAsyncUploads(now);
      if (jobId) markJobSuccess(jobId, { reclaimedAsyncUploads });
    } catch (err) {
      if (jobId) markJobFailed(jobId, err);
      throw err;
    }
  }

  // 僵尸任务回收：把卡在 PROCESSING 超时的 JobQueue 记录标失败（解锁前端指示器、可被 retryJob 重试）。
  // 不为本步骤单独建 job —— 它是对 job 表自身的清道夫，建 job 反而引入"清道夫卡住谁来清"的递归。
  let reclaimedStaleJobs = 0;
  try {
    reclaimedStaleJobs = await reclaimStaleProcessingJobs(now);
  } catch (err) {
    billingLogger.error(
      { err: serializeError(err) },
      'stale processing job reclaim failed'
    );
    // 不 rethrow —— 其他维护任务结果仍要返回
  }

  // 每日对账
  const reconciliationRunId = await maybeRunDailyReconciliation(now);

  // Chat 上传文件清理（aging + soft-cap LRU）。失败也不阻塞其他维护工作。
  let chatFilesCleanup: BillingMaintenanceSummary['chatFilesCleanup'] = null;
  {
    const jobId = await createJob({
      type: JOB_TYPE.CHAT_FILES_CLEANUP,
      triggeredBy: 'system',
      params: { source },
    });
    if (jobId) markJobProcessing(jobId);
    try {
      const cleanup = await runChatFilesCleanup();
      chatFilesCleanup = {
        agingDeleted: cleanup.agingDeleted,
        softCapDeleted: cleanup.softCapDeleted,
        bytesReleased: cleanup.bytesReleased.toString(),
        errors: cleanup.errors,
      };
      if (jobId) markJobSuccess(jobId, chatFilesCleanup);
    } catch (err) {
      if (jobId) markJobFailed(jobId, err);
      billingLogger.error(
        { err: serializeError(err) },
        'chat-files cleanup failed'
      );
      // 不 rethrow —— 其他维护任务结果仍要返回
    }
  }

  // 字节配额对账（与转录对账同日触发：reconciliationRunId 非空即今天的每日窗口已开）。
  // 放在 chat 文件清理之后，反映清理后的真实附件总量；回写自愈 storageBytesUsed。
  let storageBytesReconciled = 0;
  if (reconciliationRunId) {
    const jobId = await createJob({
      type: JOB_TYPE.RECONCILIATION,
      triggeredBy: 'system',
      params: { source, kind: 'storage_bytes' },
    });
    if (jobId) markJobProcessing(jobId);
    try {
      const result = await reconcileStorageBytes();
      storageBytesReconciled = result.corrected;
      if (jobId) markJobSuccess(jobId, result);
    } catch (err) {
      if (jobId) markJobFailed(jobId, err);
      billingLogger.error(
        { err: serializeError(err) },
        'storage bytes reconciliation failed'
      );
      // 不 rethrow —— 其他维护任务结果仍要返回
    }
  }

  if (
    resetUsers > 0 ||
    reclaimedSessions > 0 ||
    reclaimedAsyncUploads > 0 ||
    reclaimedStaleJobs > 0 ||
    storageBytesReconciled > 0 ||
    reconciliationRunId ||
    (chatFilesCleanup &&
      (chatFilesCleanup.agingDeleted > 0 ||
        chatFilesCleanup.softCapDeleted > 0))
  ) {
    logSystemEvent(
      'billing.maintenance.completed',
      JSON.stringify({
        source: options?.source ?? 'manual',
        resetUsers,
        reclaimedSessions,
        reclaimedAsyncUploads,
        reclaimedStaleJobs,
        storageBytesReconciled,
        reconciliationRunId,
        chatFilesCleanup,
      })
    );
  }

  return {
    resetUsers,
    reclaimedSessions,
    reclaimedAsyncUploads,
    reclaimedStaleJobs,
    storageBytesReconciled,
    reconciliationRunId,
    chatFilesCleanup,
  };
}

async function reclaimStaleSessions(now: Date): Promise<number> {
  const candidates = await prisma.session.findMany({
    where: {
      status: { in: ['RECORDING', 'PAUSED', 'FINALIZING'] },
      // 异步上传转录是独立状态机，由 reclaimStaleAsyncUploads 负责，绝不能在这里
      // 被 finalizeSession（实时收尾逻辑）误处理。
      asyncTranscribeStatus: null,
      OR: [
        { updatedAt: { lte: new Date(now.getTime() - STALE_SESSION_THRESHOLD_MS) } },
        { serverStartedAt: { lte: new Date(now.getTime() - STALE_SESSION_THRESHOLD_MS) } },
      ],
    },
    select: {
      id: true,
      userId: true,
      updatedAt: true,
    },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });

  let reclaimedCount = 0;

  for (const session of candidates) {
    const isStale = await isSessionStale(session, now);
    if (!isStale) {
      continue;
    }

    try {
      const result = await finalizeSession({
        sessionId: session.id,
        actor: null,
        allowStatusPromotion: true,
        finalizeSource: 'system_auto_reclaim',
      });

      if (!result.alreadyCompleted) {
        reclaimedCount += 1;
      }
    } catch (error) {
      billingLogger.error(
        {
          sessionId: session.id,
          userId: session.userId,
          err: serializeError(error),
        },
        'Auto reclaim failed'
      );
      logSystemEvent(
        'billing.auto_reclaim.failed',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }
  }

  return reclaimedCount;
}

/**
 * 回收停滞的异步上传转录。
 *
 * 与实时 reclaimStaleSessions 互补：异步路径用 session.asyncTranscribeStatus 自己的
 * 状态机，且不应走 finalizeSession（那是实时收尾）。这里把卡在任一非终态、超过
 * STALE_ASYNC_THRESHOLD_MS 没更新的 session 标为 failed，让前端进度条停下、状态机解锁，
 * 并尽力清掉本地分片/合并/mp3 临时文件。
 *
 * 注意：Soniox 端可能残留文件（已上传但卡住的情况）。这里不耦合 Soniox，留给既有的
 * Soniox 清理路径兜底；本函数只负责把 DB 状态从僵尸态解出来 + 清本地盘。
 */
async function reclaimStaleAsyncUploads(now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - STALE_ASYNC_THRESHOLD_MS);
  const stuck = await prisma.session.findMany({
    where: {
      asyncTranscribeStatus: { in: ASYNC_RECLAIMABLE_STATUSES },
      updatedAt: { lte: threshold },
    },
    select: { id: true, userId: true },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });

  let reclaimedCount = 0;
  const thresholdHours = Math.round(STALE_ASYNC_THRESHOLD_MS / 3_600_000);

  for (const session of stuck) {
    // 原子 claim：再次校验仍处于卡住状态且确实超时，避免与正常 poll/cancel 竞争误标
    const claimed = await prisma.session.updateMany({
      where: {
        id: session.id,
        asyncTranscribeStatus: { in: ASYNC_RECLAIMABLE_STATUSES },
        updatedAt: { lte: threshold },
      },
      data: {
        asyncTranscribeStatus: 'failed',
        asyncTranscribeError: `自动回收：异步转录停滞超过 ${thresholdHours} 小时`,
      },
    });

    if (claimed.count !== 1) {
      continue;
    }
    reclaimedCount += 1;
    billingLogger.warn(
      { sessionId: session.id, userId: session.userId },
      'reclaimed stuck async upload transcription'
    );
    // 清本地临时文件，容忍失败
    await deleteAsyncUpload({ id: session.id }).catch(() => undefined);
  }

  return reclaimedCount;
}

async function isSessionStale(
  session: {
    id: string;
    userId: string;
    updatedAt: Date;
  },
  now: Date
): Promise<boolean> {
  const [recordingDraft, transcriptDraft] = await Promise.all([
    loadRecordingDraftManifest(session),
    loadTranscriptDraftManifest(session),
  ]);

  const lastActivityMs = Math.max(
    session.updatedAt.getTime(),
    recordingDraft?.updatedAt ?? 0,
    transcriptDraft?.updatedAt ?? 0
  );

  return now.getTime() - lastActivityMs >= STALE_SESSION_THRESHOLD_MS;
}

async function maybeRunDailyReconciliation(now: Date): Promise<string | null> {
  const todayUtc = now.toISOString().slice(0, 10);
  const lastRun = await prisma.siteSetting.findUnique({
    where: { key: RECONCILIATION_LAST_RUN_KEY },
    select: { value: true },
  });

  if (lastRun?.value === todayUtc) {
    return null;
  }

  const jobId = await createJob({ type: JOB_TYPE.RECONCILIATION, triggeredBy: 'system', params: { date: todayUtc } });
  if (jobId) markJobProcessing(jobId);

  try {
    const run = await runTranscriptionUsageReconciliation({
      triggeredBy: 'system',
      triggeredByName: 'Billing Maintenance',
      source: 'scheduler',
    });

    await prisma.siteSetting.upsert({
      where: { key: RECONCILIATION_LAST_RUN_KEY },
      create: { key: RECONCILIATION_LAST_RUN_KEY, value: todayUtc },
      update: { value: todayUtc },
    });

    if (jobId) markJobSuccess(jobId, { reconciliationRunId: run.id });
    return run.id;
  } catch (err) {
    if (jobId) markJobFailed(jobId, err);
    throw err;
  }
}
