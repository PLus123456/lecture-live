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
import {
  resolveRoleQuotas,
  resolveRoleStorageBytesLimit,
} from '@/lib/userRoles';
import { runTranscriptionUsageReconciliation } from '@/lib/reconciliation';
import { finalizeSession } from '@/lib/sessionFinalization';
import {
  runChatFilesCleanup,
  cleanupOrphanChatImageDirs,
} from '@/lib/jobs/chatFilesCleanupJob';
import { deleteAsyncUpload } from '@/lib/audio/asyncUploadChunkPersistence';
import { resolveSonioxRuntimeConfigAsync } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
  getSonioxTranscription,
} from '@/lib/soniox/asyncFile';
import { finalizeAsyncTranscription } from '@/lib/audio/asyncTranscribeFinalize';

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
  expiredRoleDowngrades: number;
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

  if (
    resetUsers > 0 ||
    expiredRoleDowngrades > 0 ||
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
        expiredRoleDowngrades,
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
    expiredRoleDowngrades,
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
      // 以下字段供「Soniox 已完成」时的共享 finalize 自动收尾 + 扣费复用
      targetLang: true,
      durationMs: true,
      recordingPath: true,
      title: true,
      courseName: true,
      createdAt: true,
      folders: { select: { folderId: true } },
    },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });

  let reclaimedCount = 0;
  const thresholdHours = Math.round(STALE_ASYNC_THRESHOLD_MS / 3_600_000);

  // Soniox 配置只解析一次（可能未配置：为 null 时退化到旧行为，仅标 failed + 清本地）
  const sonioxConfig = await resolveSonioxRuntimeConfigAsync({}).catch(() => null);

  for (const session of stuck) {
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
export async function expireRoleDowngrades(now: Date): Promise<number> {
  const candidates = await prisma.user.findMany({
    where: {
      roleExpiresAt: { lte: now },
      originalRole: { not: null },
    },
    select: { id: true, role: true, originalRole: true },
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
