import fs from 'fs/promises';
import path from 'path';
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
  settleAsyncReservation,
  settleFullReservation,
  settlePoolOnLimitChange,
} from '@/lib/quota';
import {
  resolveRoleQuotas,
  resolveRoleStorageBytesLimit,
} from '@/lib/userRoles';
import { runTranscriptionUsageReconciliation } from '@/lib/reconciliation';
import { getRedisClient } from '@/lib/redis';
import { sendExpiryReminderEmail } from '@/lib/email';
import { finalizeSession } from '@/lib/sessionFinalization';
import {
  runChatFilesCleanup,
  cleanupOrphanChatImageDirs,
} from '@/lib/jobs/chatFilesCleanupJob';
import { deleteAsyncUpload } from '@/lib/audio/asyncUploadChunkPersistence';
import { resolveSonioxConfigForSessionRegion } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
  getSonioxTranscription,
} from '@/lib/soniox/asyncFile';
import { finalizeAsyncTranscription } from '@/lib/audio/asyncTranscribeFinalize';
import { finalizeFullTranscription } from '@/lib/audio/fullTranscribeFinalize';
import { reclaimStaleInterpretSessions } from '@/lib/interpret/session';
import { reconcileSonioxStreamUsage } from '@/lib/soniox/usageReconciliation';

const STALE_SESSION_THRESHOLD_MS = 4 * 60 * 60_000;
// FINALIZING 专项：已发起收尾但卡住的会话（前端崩/断网/服务端重启导致 finalize 没跑完）
// 不必等 4h —— 超此阈值即自动重试收尾，避免遮罩长期转圈、会话「收不了尾」。
const FINALIZING_STALE_THRESHOLD_MS = 10 * 60_000;
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
// 完整版补全转录（full* 状态机，独立于实时/异步上传）的停滞阈值。与异步上传同为 Soniox
// 异步文件任务（≤300 分钟文件），取相同的 6 小时保守阈值，避免误杀正常的长任务。
const STALE_FULL_TRANSCRIBE_THRESHOLD_MS = 6 * 60 * 60_000;
// full* 非终态（终态：completed/failed）。卡在任一态超阈值都应回收。
const FULL_TRANSCRIBE_RECLAIMABLE_STATUSES = [
  'pending',
  'transcoding',
  'transcribing',
  'finalizing',
];
// 与 fullTranscribeProcessor 的 TMP_ROOT 约定一致：回收硬崩残留的转码临时目录时兜底清理。
const FULL_TRANSCRIBE_TMP_ROOT = path.join(process.cwd(), 'data', 'full-transcribe-tmp');
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
  expiredRoleDowngrades: number;
  reclaimedSessions: number;
  reclaimedAsyncUploads: number;
  reclaimedFullTranscribes: number;
  reclaimedStaleJobs: number;
  releasedOrphanReservations: number;
  releasedOrphanFullReservations: number;
  cleanedOrphanSoniox: number;
  reclaimedInterpretSessions: number;
  sonioxUsageReconciliation: {
    regionsPolled: number;
    logsSeen: number;
    backfilled: number;
    lateCharged: number;
    orphanCharged: number;
    orphanRefunded: number;
  } | null;
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

  // 会员到期降级：roleExpiresAt 已过且有 originalRole 的用户回落原始角色。
  // 不为本步骤建独立 JobQueue 记录（JOB_TYPE 是其他单元领地、无现成的 role_downgrade 类型），
  // 失败仅 log 不 rethrow，避免拖垮其余维护步骤。
  let expiredRoleDowngrades = 0;
  try {
    expiredRoleDowngrades = await expireRoleDowngrades(now);
  } catch (err) {
    billingLogger.error(
      { err: serializeError(err) },
      'expired role downgrade failed'
    );
    // 不 rethrow —— 其他维护任务结果仍要返回
  }

  // 注：会员到期前提醒挪到本函数**末尾**执行（原本在这里）。它是整个维护循环里唯一
  // 依赖外部网络（SMTP）的步骤，一旦邮件服务商变慢/不可达，串行发信会把后面所有步骤
  // ——会话回收、异步上传回收、孤儿预留释放、Soniox 对账——一起拖住；而 triggerRun 的
  // in-flight 守卫会让 15 分钟定时器持续空跳，等于整套维护停摆。发提醒信是这里面最不
  // 紧急的事，必须排在最后，且自带时间预算。

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

  // 停滞的完整版补全转录回收（full* 状态机，独立于实时/异步上传，单独扫描）
  let reclaimedFullTranscribes = 0;
  {
    const jobId = await createJob({ type: JOB_TYPE.STALE_SESSION_RECLAIM, triggeredBy: 'system', params: { source, kind: 'full_transcribe' } });
    if (jobId) markJobProcessing(jobId);
    try {
      reclaimedFullTranscribes = await reclaimStaleFullTranscribes(now);
      if (jobId) markJobSuccess(jobId, { reclaimedFullTranscribes });
    } catch (err) {
      if (jobId) markJobFailed(jobId, err);
      throw err;
    }
  }

  // B1 兜底：释放已终态却仍残留在途预留的异步上传会话（防漏释放导致 transcriptionMinutesUsed 泄漏）。
  // 失败仅 log 不 rethrow，避免拖垮其余维护步骤。
  let releasedOrphanReservations = 0;
  try {
    releasedOrphanReservations = await releaseOrphanAsyncReservations(now);
  } catch (err) {
    billingLogger.error(
      { err: serializeError(err) },
      'release orphan async reservations failed'
    );
    // 不 rethrow —— 其他维护任务结果仍要返回
  }

  // R4 兜底：释放已终态(completed/failed)却仍残留在途预留的完整版补全转录会话（与 async 平行）。
  // 失败仅 log 不 rethrow，避免拖垮其余维护步骤。
  let releasedOrphanFullReservations = 0;
  try {
    releasedOrphanFullReservations = await releaseOrphanFullReservations(now);
  } catch (err) {
    billingLogger.error(
      { err: serializeError(err) },
      'release orphan full-transcribe reservations failed'
    );
    // 不 rethrow —— 其他维护任务结果仍要返回
  }

  // P1-17 兜底：重试删除终态会话上仍残留的 Soniox 外部资源（收尾/取消时 DELETE 未确认成功的孤儿）。
  // 用会话行 ID 列本身当 outbox，确认删除才清 ID。失败仅 log 不 rethrow。
  let cleanedOrphanSoniox = 0;
  try {
    cleanedOrphanSoniox = await reclaimOrphanSonioxResources(now);
  } catch (err) {
    billingLogger.error(
      { err: serializeError(err) },
      'reclaim orphan soniox resources failed'
    );
    // 不 rethrow —— 其他维护任务结果仍要返回
  }

  // R1-L3：Soniox usage-logs 对账——回填各 grant 的实测串流时长（actualMs）、结算孤儿 grant
  // （有用量转实扣/没用过退预扣）、迟到补扣。放在 interpret reclaim **之前**：让紧随其后的
  // interpret cron 能用上刚回填的精确时长（否则退回墙钟封顶口径）。失败仅 log 不 rethrow。
  let sonioxUsageReconciliation: BillingMaintenanceSummary['sonioxUsageReconciliation'] =
    null;
  try {
    sonioxUsageReconciliation = await reconcileSonioxStreamUsage(now);
  } catch (err) {
    billingLogger.error(
      { err: serializeError(err) },
      'soniox usage reconciliation failed'
    );
    // 不 rethrow —— 其他维护任务结果仍要返回
  }

  // B3 兜底：对超时仍未结算的同声传译会话按服务端墙钟兜底扣费（防「客户端不调 /deduct 白嫖」）。
  // 与 /deduct 经 settledAt 条件认领互斥，恰好扣一次。失败仅 log 不 rethrow。
  let reclaimedInterpretSessions = 0;
  try {
    reclaimedInterpretSessions = await reclaimStaleInterpretSessions(now);
  } catch (err) {
    billingLogger.error(
      { err: serializeError(err) },
      'reclaim stale interpret sessions failed'
    );
    // 不 rethrow —— 其他维护任务结果仍要返回
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

  // 本地孤儿聊天图片目录清理（best-effort，独立于上面的附件清理，失败不影响其它维护）。
  // 兜底删 Session 级联删对话 / B1 前删对话残留下来的 data/chatimages/<id>/ 目录。
  try {
    const orphanDirs = await cleanupOrphanChatImageDirs();
    if (orphanDirs > 0) {
      billingLogger.info({ orphanDirs }, 'orphan chat image dirs cleaned');
    }
  } catch (err) {
    billingLogger.warn(
      { err: serializeError(err) },
      'orphan chat image dir cleanup failed'
    );
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

  // 会员到期前提醒（best-effort，不 rethrow）。排在所有回收/对账之后：见前文注释。
  try {
    await sendExpiryReminders(now);
  } catch (err) {
    billingLogger.error({ err: serializeError(err) }, 'expiry reminder failed');
  }

  if (
    resetUsers > 0 ||
    expiredRoleDowngrades > 0 ||
    reclaimedSessions > 0 ||
    reclaimedAsyncUploads > 0 ||
    reclaimedFullTranscribes > 0 ||
    reclaimedStaleJobs > 0 ||
    releasedOrphanReservations > 0 ||
    releasedOrphanFullReservations > 0 ||
    cleanedOrphanSoniox > 0 ||
    reclaimedInterpretSessions > 0 ||
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
        expiredRoleDowngrades,
        reclaimedSessions,
        reclaimedAsyncUploads,
        reclaimedFullTranscribes,
        reclaimedStaleJobs,
        releasedOrphanReservations,
        releasedOrphanFullReservations,
        cleanedOrphanSoniox,
        reclaimedInterpretSessions,
        sonioxUsageReconciliation,
        storageBytesReconciled,
        reconciliationRunId,
        chatFilesCleanup,
      })
    );
  }

  return {
    resetUsers,
    expiredRoleDowngrades,
    reclaimedSessions,
    reclaimedAsyncUploads,
    reclaimedFullTranscribes,
    reclaimedStaleJobs,
    releasedOrphanReservations,
    releasedOrphanFullReservations,
    cleanedOrphanSoniox,
    reclaimedInterpretSessions,
    sonioxUsageReconciliation,
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
        // FINALIZING 专项短阈值：已发起收尾但卡住的会话超 10min 就纳入候选（下面 isSessionStale 复核）。
        {
          status: 'FINALIZING',
          updatedAt: { lte: new Date(now.getTime() - FINALIZING_STALE_THRESHOLD_MS) },
        },
      ],
    },
    select: {
      id: true,
      userId: true,
      status: true,
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
 * U23（数据丢失防护）：对卡在 transcribing / finalizing 且仍持有 sonioxTranscriptionId 的会话，
 * 标 failed 前先向 Soniox 查一次真实状态——绝不盲目丢弃一份 Soniox 侧可能早已完成/仍在跑的转录。
 * （finalizing 也纳入：收尾中途崩溃会把会话留在 finalizing、而 Soniox 侧可能已 completed。）
 *   - Soniox 仍在 queued/processing：转录本身没坏、还在跑，**不标 failed**，只 bump updatedAt
 *     让本轮跳过，等 Soniox 真正完成后再收尾。
 *   - Soniox 已 completed（v3-R6 后半）：用户离线、前端不再 poll → 回收路径**自动收尾并按相同
 *     口径扣费**，不再干等前端。复用共享 finalizeAsyncTranscription（与 status-route 同一份
 *     「拉 transcript+落盘+扣费」口径）+ 同一道幂等 claim（WHERE asyncTranscribeStatus IN
 *     ['transcribing'] → 'finalizing'）：抢到才收尾，抢不到（并发前端 poll 已在收尾）就跳过。
 *     二选一执行、绝不双扣。收尾抛错（拉 transcript/落盘瞬时故障）不在回收侧标 failed，留待重试。
 *   - Soniox 报 error 或 404（transcription 不存在）：确属失败，标 failed。
 * 其余非 transcribing 的僵尸态（合并/转码/上传阶段卡死）无 Soniox 转录产物可救，直接标 failed。
 *
 * U7：真正标 failed 时，best-effort 删除 Soniox 上残留的 file + transcription（释放 Soniox
 * 侧配额），不再只删本地盘就把 Soniox 资源泄漏给"cron 兜底"（本函数即该兜底路径）。
 */
async function reclaimStaleAsyncUploads(now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - STALE_ASYNC_THRESHOLD_MS);
  const stuck = await prisma.session.findMany({
    where: {
      asyncTranscribeStatus: { in: ASYNC_RECLAIMABLE_STATUSES },
      updatedAt: { lte: threshold },
    },
    select: {
      id: true,
      userId: true,
      asyncTranscribeStatus: true,
      sonioxFileId: true,
      sonioxTranscriptionId: true,
      // P1-16：按任务已固定的 region 解析 Soniox 配置（poll/delete 都用它），绝不落回可变默认 region。
      sonioxRegion: true,
      // 以下字段供「Soniox 已完成」时的共享 finalize 自动收尾 + 扣费复用
      targetLang: true,
      durationMs: true,
      recordingPath: true,
      title: true,
      titleAutoGenerated: true,
      courseName: true,
      createdAt: true,
      folders: { select: { folderId: true } },
    },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });

  let reclaimedCount = 0;
  const thresholdHours = Math.round(STALE_ASYNC_THRESHOLD_MS / 3_600_000);

  for (const session of stuck) {
    // P1-16：per-session 按其固定 region 解析配置（未配置 → null 退化到「仅标 failed + 清本地」）。
    const sonioxConfig = await resolveSonioxConfigForSessionRegion(
      session.sonioxRegion
    ).catch(() => null);
    // U23 + v3-R6：transcribing / finalizing + 有 transcriptionId → 先查 Soniox，salvage 还没
    // 坏的转录。finalizing 也纳入：前端 poll 或上一轮回收在收尾中途崩溃/抛错（拉 transcript 前）
    // 会把会话留在 finalizing，而 Soniox 侧转录可能早已 completed；若只救 transcribing，这类会
    // 落到下方被标 failed 丢弃已完成转录。故一并 poll、completed 就走共享 finalize 收尾。
    const salvageable =
      session.asyncTranscribeStatus === 'transcribing' ||
      session.asyncTranscribeStatus === 'finalizing';
    if (salvageable && session.sonioxTranscriptionId && sonioxConfig) {
      let job;
      try {
        job = await getSonioxTranscription(
          sonioxConfig,
          session.sonioxTranscriptionId
        );
      } catch (err) {
        // Soniox 查询失败（网络抖动/超时）：本轮先不动它，避免因一次查询失败误杀；
        // 下个维护周期再试。注意 transcription 不存在时 getSonioxTranscription 抛 HTTP 404，
        // 会走到这里——保守起见不当作"确认失败"，仍留待下轮或前端 poll 处理。
        billingLogger.warn(
          {
            sessionId: session.id,
            userId: session.userId,
            err: serializeError(err),
          },
          'soniox status check failed during reclaim; skipping this round'
        );
        continue;
      }

      if (job.status === 'queued' || job.status === 'processing') {
        // 转录仍在跑。不丢弃、不标 failed——回写同值触发 @updatedAt 自动刷新，让本轮之后不再
        // 立刻被当僵尸重扫；等 Soniox 真正 completed 后由本函数（或前端 poll）收尾。
        // 用当前实际状态做 WHERE + 同值写（transcribing 或 finalizing），保守只在状态未变时刷新。
        const currentStatus = session.asyncTranscribeStatus;
        await prisma.session
          .updateMany({
            where: {
              id: session.id,
              asyncTranscribeStatus: currentStatus,
            },
            data: { asyncTranscribeStatus: currentStatus },
          })
          .catch(() => undefined);
        billingLogger.info(
          {
            sessionId: session.id,
            userId: session.userId,
            sonioxStatus: job.status,
          },
          'stuck async session still processing on Soniox; left for later finalization'
        );
        continue;
      }

      if (job.status === 'completed') {
        // U23 后半（v3-R6）：Soniox 已完成、但用户离线前端不再 poll → 回收路径自动收尾并按
        // 相同口径扣费，而不是干等前端。复用共享 finalizeAsyncTranscription（与 status-route
        // 同一份「拉 transcript+落盘+扣费」口径）+ 同一道幂等 claim。allowClaimFrom 含 transcribing
        // 与 finalizing：finalizing 覆盖「收尾中途崩溃、Soniox 已完成」的残留会话，避免其被误标
        // failed 丢弃已完成转录。claim 抢到才收尾；即便并发前端 poll 也在 finalizing，最终的单次
        // 执行由 finalize 守卫（WHERE ='finalizing' → 'completed' 只一个 count===1）保证，绝不双扣。
        try {
          const result = await finalizeAsyncTranscription(
            {
              id: session.id,
              userId: session.userId,
              sonioxFileId: session.sonioxFileId,
              sonioxTranscriptionId: session.sonioxTranscriptionId,
              targetLang: session.targetLang,
              durationMs: session.durationMs,
              recordingPath: session.recordingPath,
              title: session.title,
              titleAutoGenerated: session.titleAutoGenerated,
              courseName: session.courseName,
              createdAt: session.createdAt,
              folderIds: session.folders.map((f) => f.folderId),
            },
            sonioxConfig,
            { allowClaimFrom: ['transcribing', 'finalizing'] }
          );

          if (result.outcome === 'completed') {
            reclaimedCount += 1;
            billingLogger.info(
              {
                sessionId: session.id,
                userId: session.userId,
                segmentCount: result.segmentCount,
              },
              'reclaim auto-finalized completed async transcription'
            );
          } else {
            // claim_lost（前端 poll 抢先）/ canceled_during_finalize：不重复处理，交给对方。
            billingLogger.info(
              {
                sessionId: session.id,
                userId: session.userId,
                outcome: result.outcome,
              },
              'reclaim skipped async finalize (handled elsewhere or canceled)'
            );
          }
        } catch (finalizeErr) {
          // 拉 transcript / 落盘 阶段抛错（含瞬时网络故障）：不在回收侧标 failed，保守留待
          // 下一维护周期或前端 poll 重试。此时状态可能已被 claim 置 'finalizing'——若确属瞬时，
          // 前端 poll 会读到 finalizing 而放弃；下轮回收因 updatedAt 已刷新而暂不重扫，最终由
          // 前端 status-route 的瞬时/永久错误处理路径收敛。绝不误标 failed 丢弃已完成转录。
          billingLogger.error(
            {
              sessionId: session.id,
              userId: session.userId,
              err: serializeError(finalizeErr),
            },
            'reclaim auto-finalize failed; left for retry'
          );
        }
        continue;
      }
      // job.status === 'error' → 落到下方标 failed + 清 Soniox
    }

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
    // U7：best-effort 清 Soniox 上残留的 file + transcription（幂等，失败不抛）
    if (sonioxConfig) {
      if (session.sonioxFileId) {
        await deleteSonioxFile(sonioxConfig, session.sonioxFileId).catch(
          () => undefined
        );
      }
      if (session.sonioxTranscriptionId) {
        await deleteSonioxTranscription(
          sonioxConfig,
          session.sonioxTranscriptionId
        ).catch(() => undefined);
      }
    }
  }

  return reclaimedCount;
}

// B1 兜底扫描的陈旧门槛：只清「已终态一段时间」的残留预留，避免与刚 completed 的在途
// finalize 结算(release 预留)赛跑重复释放。用 updatedAt 判定（finalize 结算会 bump updatedAt）。
const ASYNC_RESERVATION_SWEEP_STALE_MS = 30 * 60_000;

/**
 * B1 兜底：释放「已终态却仍残留在途预留（asyncReservedMinutes>0）」的异步上传会话。
 *
 * 正常路径：finalize 把预留「转」为实扣并清列；cancel/删会话 inline 释放。但若某终态转移未清
 * 预留（failed 由 status-route / reclaim / processor 标记时不 inline 释放、或 finalize 结算事务
 * 整体失败留下残留），预留会永久占着 transcriptionMinutesUsed → 额度泄漏。这里扫
 * 「asyncReservedMinutes>0 且已终态(failed/canceled/completed) 且 updatedAt 超 30min」的会话，
 * 条件原子认领后释放，兜住所有未 inline 释放的路径。30min 陈旧门槛避免与刚 completed 的
 * finalize 结算(同样 release 预留)赛跑重复释放。
 */
export async function releaseOrphanAsyncReservations(now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - ASYNC_RESERVATION_SWEEP_STALE_MS);
  const TERMINAL = ['failed', 'canceled', 'completed'];
  const stuck = await prisma.session.findMany({
    where: {
      asyncReservedMinutes: { gt: 0 },
      asyncTranscribeStatus: { in: TERMINAL },
      updatedAt: { lte: staleBefore },
    },
    select: { id: true, userId: true, asyncReservedMinutes: true },
    take: 500,
    orderBy: { updatedAt: 'asc' },
  });

  let releasedCount = 0;
  for (const s of stuck) {
    // 统一走 settleAsyncReservation（FOR UPDATE 读当前列 → 清零 + 释放，同一事务原子、恰好一次）。
    // 与 finalize 结算 / 删会话 / re-init 顶替 的释放互斥：并发多路径只有一个读到 >0 并释放。
    const released = await settleAsyncReservation(s.id).catch(() => 0);
    if (released > 0) {
      releasedCount += 1;
      billingLogger.info(
        { sessionId: s.id, userId: s.userId, minutes: released },
        'released orphan async upload reservation'
      );
    }
  }
  return releasedCount;
}

// R4 兜底扫描的陈旧门槛：与 async 同口径——只清「已终态一段时间」的残留预留，避免与刚 completed 的
// 在途 finalize 结算(release 预留)赛跑重复释放。用 updatedAt 判定（finalize 结算会 bump updatedAt）。
const FULL_RESERVATION_SWEEP_STALE_MS = 30 * 60_000;

/**
 * R4 兜底：释放「已终态却仍残留在途预留（fullReservedMinutes>0）」的完整版补全转录会话（与 B1 的
 * releaseOrphanAsyncReservations 平行）。
 *
 * 正常路径：finalize 把预留「转」为实扣并清列；删会话 inline 释放。但若某终态转移未清预留（processor/
 * reclaim 标 failed 时不 inline 释放、或 finalize 结算事务整体失败留下残留），预留会永久占着
 * transcriptionMinutesUsed → 额度泄漏。这里扫「fullReservedMinutes>0 且已终态(failed/completed)
 * 且 updatedAt 超 30min」的会话，统一走 settleFullReservation 条件原子认领后释放，兜住所有未 inline
 * 释放的路径。30min 陈旧门槛避免与刚 completed 的 finalize 结算(同样 release 预留)赛跑重复释放。
 *
 * 完整版状态机的终态是 completed / failed（无 canceled，无用户取消路径）。
 */
export async function releaseOrphanFullReservations(now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - FULL_RESERVATION_SWEEP_STALE_MS);
  const TERMINAL = ['failed', 'completed'];
  const stuck = await prisma.session.findMany({
    where: {
      fullReservedMinutes: { gt: 0 },
      fullTranscribeStatus: { in: TERMINAL },
      updatedAt: { lte: staleBefore },
    },
    select: { id: true, userId: true, fullReservedMinutes: true },
    take: 500,
    orderBy: { updatedAt: 'asc' },
  });

  let releasedCount = 0;
  for (const s of stuck) {
    // settleFullReservation（FOR UPDATE 读当前列 → 清零 + 释放，恰好一次），与 finalize 结算 / 删会话 /
    // 并发触发顶替 的释放互斥：并发多路径只有一个读到 >0 并释放。
    const released = await settleFullReservation(s.id).catch(() => 0);
    if (released > 0) {
      releasedCount += 1;
      billingLogger.info(
        { sessionId: s.id, userId: s.userId, minutes: released },
        'released orphan full-transcribe reservation'
      );
    }
  }
  return releasedCount;
}

// P1-17 cleanup outbox 的陈旧门槛：只重试「已终态一段时间」仍残留外部 ID 的会话，避开刚收尾的在途结算。
const ORPHAN_SONIOX_SWEEP_STALE_MS = 30 * 60_000;

/**
 * P1-17 cleanup outbox（兜底重试）：终态会话若仍残留 Soniox 外部 ID（async 的 sonioxFileId/
 * sonioxTranscriptionId 或完整版的 fullSonioxFileId/fullSonioxTranscriptionId），说明收尾/取消时
 * DELETE 未确认成功（网络故障 / 非 2xx）。收尾/取消侧已改为「确认删除才清 ID」，故残留 ID 本身即
 * tombstone/outbox（无须新表）。这里按 per-session 固定 region 重试删除（**先 transcription 再
 * file**，P1-17），确认删除(2xx/404)才清对应 ID。updatedAt 超 30min 才扫，避开刚收尾的在途结算。
 */
export async function reclaimOrphanSonioxResources(now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - ORPHAN_SONIOX_SWEEP_STALE_MS);
  let cleaned = 0;

  const clearOne = async (
    sessionId: string,
    region: string | null,
    transcriptionId: string | null,
    fileId: string | null,
    idFields: { tx: string; file: string }
  ): Promise<boolean> => {
    const config = await resolveSonioxConfigForSessionRegion(region).catch(() => null);
    if (!config) return false;
    let didClear = false;
    // 先删 transcription 再删 file（P1-17）。
    if (transcriptionId) {
      const ok = await deleteSonioxTranscription(config, transcriptionId).catch(() => false);
      if (ok) {
        await prisma.session
          .updateMany({ where: { id: sessionId }, data: { [idFields.tx]: null } })
          .catch(() => undefined);
        didClear = true;
      }
    }
    if (fileId) {
      const ok = await deleteSonioxFile(config, fileId).catch(() => false);
      if (ok) {
        await prisma.session
          .updateMany({ where: { id: sessionId }, data: { [idFields.file]: null } })
          .catch(() => undefined);
        didClear = true;
      }
    }
    return didClear;
  };

  // ── async 上传：终态 + 残留 async Soniox ID ──
  const asyncStuck = await prisma.session.findMany({
    where: {
      asyncTranscribeStatus: { in: ['completed', 'canceled', 'failed'] },
      OR: [{ sonioxFileId: { not: null } }, { sonioxTranscriptionId: { not: null } }],
      updatedAt: { lte: staleBefore },
    },
    select: { id: true, sonioxFileId: true, sonioxTranscriptionId: true, sonioxRegion: true },
    take: 200,
    orderBy: { updatedAt: 'asc' },
  });
  for (const s of asyncStuck) {
    const did = await clearOne(s.id, s.sonioxRegion, s.sonioxTranscriptionId, s.sonioxFileId, {
      tx: 'sonioxTranscriptionId',
      file: 'sonioxFileId',
    });
    if (did) cleaned += 1;
  }

  // ── 完整版补全：终态 + 残留 full Soniox ID ──
  const fullStuck = await prisma.session.findMany({
    where: {
      fullTranscribeStatus: { in: ['completed', 'failed'] },
      OR: [{ fullSonioxFileId: { not: null } }, { fullSonioxTranscriptionId: { not: null } }],
      updatedAt: { lte: staleBefore },
    },
    select: {
      id: true,
      fullSonioxFileId: true,
      fullSonioxTranscriptionId: true,
      sonioxRegion: true,
    },
    take: 200,
    orderBy: { updatedAt: 'asc' },
  });
  for (const s of fullStuck) {
    const did = await clearOne(
      s.id,
      s.sonioxRegion,
      s.fullSonioxTranscriptionId,
      s.fullSonioxFileId,
      { tx: 'fullSonioxTranscriptionId', file: 'fullSonioxFileId' }
    );
    if (did) cleaned += 1;
  }

  return cleaned;
}

/**
 * 回收停滞的完整版补全转录（cron 兜底，防僵尸）。
 *
 * 完整版转录用独立的 full* 状态机（fullTranscribeStatus / fullTranscribeStartedAt /
 * fullSonioxFileId / fullSonioxTranscriptionId / fullTranscriptPath），与实时收尾
 * （reclaimStaleSessions）、异步上传（reclaimStaleAsyncUploads）都不同，单独扫描。停滞成因：
 * 用户触发后离线不再 poll，而 GET full-transcribe-status（前端 poll 驱动收尾）没人调，转录就
 * 永远停在 transcribing —— Soniox 侧可能早已完成却没人收尾。
 *
 * 处理（按 fullTranscribeStartedAt 超阈值筛选，per-session 分支）：
 *   - transcribing / finalizing（持有或曾持有 Soniox 转录任务，可能已完成）：查 Soniox 真实状态
 *     后 salvage。与 reclaimStaleAsyncUploads 同构 —— finalizing 僵尸（收尾中途崩溃、用户已离线）
 *     也走 salvage、经 allowClaimFrom=['transcribing','finalizing'] **复收到 completed**，而不是
 *     盲目回退 transcribing（回退会与「刚发起、在途」的 finalize 赛跑，把它逼进
 *     canceled_during_finalize 误删 Soniox 转录，致会话永久卡死）。
 *       · queued/processing：还在跑，不标 failed，bump fullTranscribeStartedAt 避免本轮后重扫；
 *       · completed：复用共享 finalizeFullTranscription 收尾并按相同口径扣费。其原子 claim +
 *         finalize 守卫与前端 poll 互斥——扣费恰好一次、绝不双扣；
 *       · error：落到下方标 failed + 清 Soniox。
 *       · 无 transcriptionId / Soniox 未配置（含 resolveSoniox 瞬时抛错被吞成 null）：**保守跳过**，
 *         绝不误标 failed 丢弃可能已完成的转录，留待下轮或配置恢复。
 *   - pending / transcoding 僵尸（后台管线在 Soniox 建任务前就崩，无转录产物可救）：原子 claim
 *     再校验后标 failed，best-effort 清本地转码临时目录 + Soniox 残留 file/transcription。
 *
 * 幂等/防赛跑关键：finalizeFullTranscription 的 claim 会刷新 fullTranscribeStartedAt，故一个刚被
 * claim 的在途 finalize 不会满足本函数「startedAt 超阈值」的僵尸判定，不会被误处理。
 */
export async function reclaimStaleFullTranscribes(now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - STALE_FULL_TRANSCRIBE_THRESHOLD_MS);
  const stuck = await prisma.session.findMany({
    where: {
      fullTranscribeStatus: { in: FULL_TRANSCRIBE_RECLAIMABLE_STATUSES },
      fullTranscribeStartedAt: { lte: threshold },
    },
    select: {
      id: true,
      userId: true,
      fullTranscribeStatus: true,
      fullSonioxFileId: true,
      fullSonioxTranscriptionId: true,
      // P1-16：按任务已固定的 region 解析 Soniox 配置。
      sonioxRegion: true,
      // 以下字段供「Soniox 已完成」时的共享 finalize 自动收尾 + 扣费复用
      targetLang: true,
      durationMs: true,
    },
    take: 100,
    orderBy: { fullTranscribeStartedAt: 'asc' },
  });

  let reclaimedCount = 0;
  const thresholdHours = Math.round(STALE_FULL_TRANSCRIBE_THRESHOLD_MS / 3_600_000);

  for (const session of stuck) {
    const status = session.fullTranscribeStatus;
    // P1-16：per-session 按其固定 region 解析配置（未配置 → null 退化到「仅标僵尸 failed」）。
    const sonioxConfig = await resolveSonioxConfigForSessionRegion(
      session.sonioxRegion
    ).catch(() => null);

    // transcribing / finalizing：持有（或曾持有）Soniox 转录任务，可能已完成 → 查 Soniox 真实状态
    // 后 salvage。finalizing 僵尸不再盲目回退 transcribing（会与在途 finalize 赛跑），而是与
    // transcribing 一起走 salvage、经 allowClaimFrom 复收到 completed。
    const salvageable = status === 'transcribing' || status === 'finalizing';
    if (salvageable) {
      // 需 Soniox 才能判定真实进度：无 transcriptionId 或 Soniox 未配置（含 resolveSoniox 瞬时抛错
      // 被 .catch(()=>null) 吞掉）→ 保守跳过，绝不误标 failed 丢弃可能已完成的转录，留待下轮/配置恢复。
      if (!session.fullSonioxTranscriptionId || !sonioxConfig) {
        billingLogger.warn(
          { sessionId: session.id, userId: session.userId, status },
          'stuck full-transcribe not pollable (no soniox config / transcriptionId); skipping this round'
        );
        continue;
      }

      let job;
      try {
        job = await getSonioxTranscription(
          sonioxConfig,
          session.fullSonioxTranscriptionId
        );
      } catch (err) {
        // Soniox 查询失败（网络抖动/超时，或 transcription 不存在返回 404）：本轮先不动它，
        // 保守不误标 failed，下个维护周期或前端 poll 再处理。
        billingLogger.warn(
          { sessionId: session.id, userId: session.userId, err: serializeError(err) },
          'soniox status check failed during full-transcribe reclaim; skipping this round'
        );
        continue;
      }

      if (job.status === 'queued' || job.status === 'processing') {
        // 转录仍在跑：不丢弃、不标 failed。bump fullTranscribeStartedAt=now，让本轮之后不再
        // 立刻被当僵尸重扫；等 Soniox 真正 completed 后由本函数（或前端 poll）收尾。
        await prisma.session
          .updateMany({
            where: { id: session.id, fullTranscribeStatus: status },
            data: { fullTranscribeStartedAt: now },
          })
          .catch(() => undefined);
        billingLogger.info(
          { sessionId: session.id, userId: session.userId, sonioxStatus: job.status },
          'stuck full-transcribe still processing on Soniox; left for later finalization'
        );
        continue;
      }

      if (job.status === 'completed') {
        // Soniox 已完成、用户离线前端不再 poll → 回收路径自动收尾并按相同口径扣费。复用共享
        // finalizeFullTranscription（与 full-transcribe-status 路由同一份「claim + 拉 transcript +
        // 落盘 + 扣费」口径）。allowClaimFrom 含 transcribing 与 finalizing：finalizing 覆盖「收尾
        // 中途崩溃、Soniox 已完成」的残留会话，直接复收到 completed。即便并发前端 poll 也在收尾，
        // 最终单次执行由 finalize 守卫(finalizing→completed 只一个 count===1)保证，扣费恰好一次、
        // 绝不双扣。
        try {
          const result = await finalizeFullTranscription(session, sonioxConfig, {
            allowClaimFrom: ['transcribing', 'finalizing'],
          });
          if (result.outcome === 'completed') {
            reclaimedCount += 1;
            billingLogger.info(
              {
                sessionId: session.id,
                userId: session.userId,
                segmentCount: result.segmentCount,
              },
              'reclaim auto-finalized completed full transcription'
            );
          } else {
            // claim_lost（前端 poll 抢先）/ canceled_during_finalize：交给对方，不重复处理。
            billingLogger.info(
              {
                sessionId: session.id,
                userId: session.userId,
                outcome: result.outcome,
              },
              'reclaim skipped full-transcribe finalize (handled elsewhere or canceled)'
            );
          }
        } catch (finalizeErr) {
          // 拉 transcript / 落盘瞬时故障：不在回收侧标 failed，留待重试。claim 已把状态置 finalizing
          // 并刷新 startedAt，下一轮回收超阈值后经 allowClaimFrom(含 finalizing) 再次 salvage 收尾。
          billingLogger.error(
            {
              sessionId: session.id,
              userId: session.userId,
              err: serializeError(finalizeErr),
            },
            'reclaim full-transcribe auto-finalize failed; left for retry'
          );
        }
        continue;
      }
      // job.status === 'error' → 落到下方标 failed + 清 Soniox
    }

    // 其余：pending / transcoding 僵尸（无 Soniox 转录产物可救），或 salvageable 但 Soniox 明确报
    // error —— 原子 claim 再校验仍卡住且超时后标 failed。startedAt 由 in-flight finalize 的 claim
    // 刷新，故绝不误标刚发起收尾的会话。
    const claimed = await prisma.session
      .updateMany({
        where: {
          id: session.id,
          fullTranscribeStatus: { in: ['pending', 'transcoding', 'transcribing', 'finalizing'] },
          fullTranscribeStartedAt: { lte: threshold },
        },
        data: {
          fullTranscribeStatus: 'failed',
          fullTranscribeError: `自动回收：完整版转录停滞超过 ${thresholdHours} 小时`,
        },
      })
      .catch(() => ({ count: 0 }));

    if (claimed.count !== 1) {
      continue;
    }
    reclaimedCount += 1;
    billingLogger.warn(
      { sessionId: session.id, userId: session.userId },
      'reclaimed stuck full transcription'
    );
    // R4：僵尸标 failed（抢到，恰好一次）→ 释放入口持有的转录分钟预留，避免额度泄漏。
    // settleFullReservation（FOR UPDATE 读 fullReservedMinutes 当前列并原子释放）与 finalize 结算 /
    // 删会话 / cron releaseOrphanFullReservations 互斥，恰好释放一次。
    await settleFullReservation(session.id).catch(() => undefined);

    // best-effort 清本地转码临时目录（processFullTranscribe 正常自清，此处兜底硬崩残留）。
    await fs
      .rm(
        path.join(
          FULL_TRANSCRIBE_TMP_ROOT,
          session.id.replace(/[^a-zA-Z0-9_-]/g, '')
        ),
        { recursive: true, force: true }
      )
      .catch(() => undefined);

    // best-effort 清 Soniox 上残留的 file + transcription（幂等，失败不抛）。
    if (sonioxConfig) {
      if (session.fullSonioxFileId) {
        await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(
          () => undefined
        );
      }
      if (session.fullSonioxTranscriptionId) {
        await deleteSonioxTranscription(
          sonioxConfig,
          session.fullSonioxTranscriptionId
        ).catch(() => undefined);
      }
    }
  }

  return reclaimedCount;
}

/**
 * 会员到期降级。
 *
 * 扫描 roleExpiresAt 已过期且 originalRole 非空的用户，把 role 回落到 originalRole，
 * 清空 originalRole / roleExpiresAt，按目标角色同步配额上限（transcriptionMinutesLimit /
 * storageHoursLimit / allowedModels / storageBytesLimit），并自增 tokenVersion 把在线会话踢下线。
 *
 * 不写时也是幂等：每个用户用条件原子 update（再校验 roleExpiresAt<=now 且 originalRole 非空），
 * 与 admin 端"续费/改角色"并发时不会误降级已被延期的用户。usage（已用量）不动，留给配额周期重置。
 */
/**
 * 会员到期前提醒：扫描未来 REMINDER_WINDOW_DAYS 天内到期的临时会员，各发一封续订提醒。
 * 用 Redis 去重（每用户每到期日最多提醒一次），故仅在 Redis 可用时执行——否则 15 分钟一轮会重复轰炸。
 * 发信本身受用户「到期提醒」偏好约束（isCategoryEnabledForUser）。best-effort，任何异常上抛给调用方吞掉。
 */
const EXPIRY_REMINDER_WINDOW_DAYS = 7;
/** 同时在途的发信数。SMTP 侧不是无限并发，取小值即可把 500 人的串行墙压掉两个数量级。 */
const EXPIRY_REMINDER_CONCURRENCY = 5;
/**
 * 单轮发提醒的总时间预算。超预算即停止派发、剩下的留给下一轮（15 分钟后）——
 * 没抢到去重键的用户不会被标记，所以下一轮会原样重新捞到，7 天窗口内足够发完。
 * 有了它，即便 SMTP 完全不可达，维护循环也只会多花这点时间，不会拖成小时级停摆。
 */
const EXPIRY_REMINDER_BUDGET_MS = 2 * 60_000;
export async function sendExpiryReminders(
  now: Date,
  /** 仅供测试注入；生产调用不传，用上面的常量。 */
  opts?: { concurrency?: number; budgetMs?: number }
): Promise<number> {
  const concurrency = Math.max(1, opts?.concurrency ?? EXPIRY_REMINDER_CONCURRENCY);
  const budgetMs = Math.max(1, opts?.budgetMs ?? EXPIRY_REMINDER_BUDGET_MS);

  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') return 0; // 无 Redis 无法去重，跳过

  const windowEnd = new Date(now.getTime() + EXPIRY_REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await prisma.user.findMany({
    where: {
      roleExpiresAt: { gt: now, lte: windowEnd },
      originalRole: { not: null }, // 仅临时会员（到期会降级的）
      status: 1,
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      emailPreferences: true,
      role: true,
      roleExpiresAt: true,
    },
    take: 500,
    orderBy: { roleExpiresAt: 'asc' },
  });

  let sent = 0;
  let failed = 0;
  let cursor = 0;
  let budgetExhausted = false;
  const deadline = Date.now() + budgetMs;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline) {
        budgetExhausted = true;
        return;
      }
      const index = cursor++;
      if (index >= candidates.length) return;
      const user = candidates[index];
      if (!user.roleExpiresAt) continue;

      const expiryDay = user.roleExpiresAt.toISOString().slice(0, 10); // YYYY-MM-DD
      const dedupKey = `email:expiry-reminded:${user.id}:${expiryDay}`;
      try {
        // SET NX：抢到才发，保证每用户每到期日仅一封。TTL 覆盖提醒窗口 + 余量。
        const won = await redis.set(
          dedupKey,
          '1',
          'EX',
          (EXPIRY_REMINDER_WINDOW_DAYS + 2) * 86400,
          'NX'
        );
        if (won !== 'OK') continue;

        const daysLeft = Math.max(
          1,
          Math.ceil((user.roleExpiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
        );
        const result = await sendExpiryReminderEmail(user, {
          planName: user.role,
          expiresLabel: user.roleExpiresAt.toLocaleDateString('zh-CN'),
          daysLeft,
        });

        // 去重键是发之前抢的，发失败就得还回去：否则一次瞬时 SMTP 故障会让这批用户
        // 在整个到期窗口内永远收不到提醒（TTL 9 天 > 7 天窗口），会员就这么静默过期了。
        // 用户主动关闭该分类（ok:true + skipped:preference）不算失败，保留占位。
        if (!result.ok) {
          await redis.del(dedupKey).catch(() => undefined);
          failed += 1;
          billingLogger.warn(
            { userId: user.id, error: result.error },
            'expiry reminder delivery failed, dedup key released for retry'
          );
          continue;
        }
        // sendExpiryReminderEmail 对失败是返回 ok:false 而非抛错，所以这里必须看返回值：
        // 原先无条件 sent += 1，SMTP 全挂时也会报告"已发 N 封"。
        if (result.error !== 'skipped:preference') sent += 1;
      } catch (err) {
        failed += 1;
        await redis.del(dedupKey).catch(() => undefined);
        billingLogger.warn(
          { err: serializeError(err), userId: user.id },
          'expiry reminder send failed for user'
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker())
  );

  if (budgetExhausted) {
    // 不静默截断：剩下的没抢去重键，下一轮会重新捞到。
    billingLogger.warn(
      { processed: Math.min(cursor, candidates.length), total: candidates.length, sent, failed },
      'expiry reminder time budget exhausted, remainder deferred to next maintenance run'
    );
  }
  return sent;
}

export async function expireRoleDowngrades(now: Date): Promise<number> {
  const candidates = await prisma.user.findMany({
    where: {
      roleExpiresAt: { lte: now },
      originalRole: { not: null },
    },
    select: {
      id: true,
      role: true,
      originalRole: true,
      transcriptionMinutesLimit: true,
      purchasedMinutesBalance: true,
    },
    take: 500,
    orderBy: { roleExpiresAt: 'asc' },
  });

  let downgraded = 0;

  for (const user of candidates) {
    const targetRole = user.originalRole;
    if (!targetRole) {
      continue;
    }

    // U46：到期降级回落目标角色配额时，从 SiteSetting.group_config_<role> 解析（缺失回落默认），
    // 与 admin 用户组配置一致，避免降级后停留在硬编码默认值而无视 admin 的自定义。
    const [quotas, storageBytesLimit] = await Promise.all([
      resolveRoleQuotas(targetRole),
      resolveRoleStorageBytesLimit(targetRole),
    ]);

    // 条件原子降级：再次确认仍过期且 originalRole 未被清空（避免与 admin 续费竞争误降级）
    const result = await prisma.user.updateMany({
      where: {
        id: user.id,
        roleExpiresAt: { lte: now },
        originalRole: { not: null },
      },
      data: {
        role: targetRole,
        originalRole: null,
        roleExpiresAt: null,
        // 到期同时清掉自定义组绑定：否则用户 role/配额已回落系统角色，customGroupId 却仍指向
        // 旧自定义组 → resolveUserFeatureFlags 仍读组的能力开关、UI 徽章仍显示组名，与已重置的
        // 配额列不一致（漂移）。回落目标是系统角色，本就不应保留自定义组归属。
        customGroupId: null,
        transcriptionMinutesLimit: quotas.transcriptionMinutesLimit,
        storageHoursLimit: quotas.storageHoursLimit,
        allowedModels: quotas.allowedModels,
        storageBytesLimit,
        // 自增 tokenVersion 让旧 JWT 失效，把降级用户踢下线（下次请求按新角色重新签发）
        tokenVersion: { increment: 1 },
      },
    });

    if (result.count !== 1) {
      continue;
    }
    downgraded += 1;
    // 充值系统（Model A）：降级把 limit 调低而不动 used。用捕获的旧上限按旧口径结算持池用户的时长池
    //（并整周期重置），仅在降级已成功后执行、且仅对持池用户，避免误扣未真正降级的用户。
    if (user.purchasedMinutesBalance > 0) {
      await settlePoolOnLimitChange(
        user.id,
        user.transcriptionMinutesLimit,
        quotas.transcriptionMinutesLimit
      );
    }
    billingLogger.info(
      { userId: user.id, from: user.role, to: targetRole },
      'expired membership downgraded to original role'
    );
  }

  return downgraded;
}

async function isSessionStale(
  session: {
    id: string;
    userId: string;
    status: string;
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

  // FINALIZING（已发起收尾）用短阈值自愈重试；RECORDING/PAUSED 仍按 4h 判定长期无活动。
  const threshold =
    session.status === 'FINALIZING'
      ? FINALIZING_STALE_THRESHOLD_MS
      : STALE_SESSION_THRESHOLD_MS;

  return now.getTime() - lastActivityMs >= threshold;
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
