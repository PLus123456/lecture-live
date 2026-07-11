/**
 * 异步上传转录的「共享收尾（finalize）」逻辑。
 *
 * 由两条路径复用，行为逐字一致，杜绝口径漂移 / 双扣：
 *   1. 前端轮询驱动：`src/app/api/sessions/[id]/async-transcribe-status/route.ts`
 *      —— 用户在线时，poll 到 Soniox completed 就地收尾。
 *   2. 回收兜底（cron）：`src/lib/billingMaintenance.ts` 的 reclaimStaleAsyncUploads
 *      —— 用户离线、前端不再 poll 时，回收路径查到 Soniox 已完成后自动收尾。
 *
 * 收尾口径（三处必须完全一致，改动即为红线）：
 *   - 拉 transcript → 转 segments → 落盘（persistSessionTranscriptArtifacts）
 *   - 计费：ceil(getBillableMinutes(durationMs) × async_upload_billing_multiplier) 分钟，
 *     倍率默认 0.8、可在 admin 设置；与对账侧口径一致。
 *   - 幂等：依赖两道条件原子 updateMany —
 *       (a) claim：WHERE asyncTranscribeStatus IN allowedClaimFrom → 'finalizing'
 *           抢到（count===1）才继续，否则交给对方（前端 poll / 回收）二选一执行；
 *       (b) finalize 守卫：WHERE asyncTranscribeStatus='finalizing' → 'completed'
 *           抢不到（收尾期间被 cancel）则不扣费、不跑 LLM，仅清 Soniox 资源。
 *     故对同一 session，扣费恰好执行一次（回收 vs 前端 poll 互斥，绝不双扣）。
 */
import type { Session } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { SonioxRuntimeConfig } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
  getSonioxTranscript,
} from '@/lib/soniox/asyncFile';
import {
  convertAsyncTokensToSegments,
  extractTranslationsByTokens,
} from '@/lib/soniox/asyncTranscriptConverter';
import { persistSessionTranscriptArtifacts } from '@/lib/sessionPersistence';
import { runBackgroundLLMTasks } from '@/lib/sessionFinalization';
import {
  deductTranscriptionMinutes,
  settleAsyncReservation,
} from '@/lib/quota';
import { getBillableMinutes } from '@/lib/billing';
import { getSiteSettings } from '@/lib/siteSettings';

/** finalize 只需要 session 的这些字段（route / reclaim 各自 select 需覆盖）。 */
export type FinalizableSession = Pick<
  Session,
  | 'id'
  | 'userId'
  | 'sonioxFileId'
  | 'sonioxTranscriptionId'
  | 'targetLang'
  | 'durationMs'
  | 'recordingPath'
  | 'title'
  | 'courseName'
  | 'createdAt'
> & {
  /** 后台 LLM 任务需要 folderIds；route 从 include.folders 映射，reclaim 单独查。 */
  folderIds: string[];
};

export type FinalizeAsyncResult =
  | {
      /** 抢锁失败：另一条路径已在收尾（或状态已变），调用方应读最新状态返回。 */
      outcome: 'claim_lost';
    }
  | {
      /** 收尾守卫失败：finalizing 期间会话被 cancel，未扣费、未跑 LLM，已清 Soniox 资源。 */
      outcome: 'canceled_during_finalize';
    }
  | {
      /** 收尾成功：已落盘、已按口径扣费、已触发后台 LLM、已清 Soniox 资源。 */
      outcome: 'completed';
      transcriptPath: string;
      summaryPath: string;
      segmentCount: number;
    };

/**
 * 收尾一份「Soniox 侧已 completed」的异步转录。**调用前提**：调用方已确认 Soniox job
 * 状态为 completed（本函数不再 poll Soniox 状态，只负责抢锁 + 拉 transcript + 落盘 + 扣费）。
 *
 * @param session          需收尾的会话（字段见 FinalizableSession）
 * @param sonioxConfig     Soniox 运行配置（用于拉 transcript / 清资源）
 * @param options.allowClaimFrom  claim 允许的起始状态集合。前端 poll 传 ['transcribing']；
 *   回收路径也传 ['transcribing']（僵尸态里只有 transcribing 才可能持有已完成的 Soniox 转录）。
 * @param options.onCompleted  收尾成功后的副作用钩子（如失效 API 缓存）。在扣费/后台任务之前调用，
 *   与原 route 行为一致（route 里 invalidateSessionsApiCache 紧跟 finalize 守卫成功之后）。
 *
 * 注意：本函数**会抛出**拉 transcript / 落盘阶段的错误（含瞬时/永久之分由调用方判定），
 * 抛出前不改动 DB 状态——调用方需在 catch 里按 'finalizing' 守卫回退 transcribing 或标 failed。
 */
export async function finalizeAsyncTranscription(
  session: FinalizableSession,
  sonioxConfig: SonioxRuntimeConfig,
  options: {
    allowClaimFrom: string[];
    onCompleted?: (session: FinalizableSession) => Promise<void> | void;
  }
): Promise<FinalizeAsyncResult> {
  const transcriptionId = session.sonioxTranscriptionId;
  if (!transcriptionId) {
    // 理论不可达（调用方已确认 Soniox completed 必有 transcriptionId），保守当作抢锁失败。
    return { outcome: 'claim_lost' };
  }

  // ── 条件原子 claim：WHERE asyncTranscribeStatus IN allowClaimFrom → 'finalizing' ──
  // 只有一个并发路径（前端 poll / 回收）能抢到，其它读到 'finalizing' 直接放弃。
  const claim = await prisma.session.updateMany({
    where: {
      id: session.id,
      asyncTranscribeStatus: { in: options.allowClaimFrom },
    },
    data: { asyncTranscribeStatus: 'finalizing' },
  });

  if (claim.count !== 1) {
    return { outcome: 'claim_lost' };
  }

  const transcript = await getSonioxTranscript(sonioxConfig, transcriptionId);
  const segments = convertAsyncTokensToSegments(transcript.tokens, {
    targetLang: session.targetLang,
  });
  const translations = extractTranslationsByTokens(transcript.tokens, segments);

  const bundle = {
    segments,
    summaries: [],
    translations,
  };
  const persisted = await persistSessionTranscriptArtifacts(session, bundle);

  // 完成写入必须带状态守卫（原 route U60 注释）：上面的 claim 把状态置 'finalizing'，但拉
  // transcript / 写盘期间用户仍可能取消（cancelAsyncUpload 的 setStatus 允许 finalizing→canceled）。
  // 条件 updateMany WHERE asyncTranscribeStatus='finalizing'：抢不到（已被取消）→ 不写库、不扣费。
  const finalized = await prisma.session.updateMany({
    where: { id: session.id, asyncTranscribeStatus: 'finalizing' },
    data: {
      asyncTranscribeStatus: 'completed',
      transcriptPath: persisted.transcript.path,
      summaryPath: persisted.summary.path,
      // 清掉 Soniox 引用 —— 文件已经删了/即将删
      sonioxFileId: null,
      sonioxTranscriptionId: null,
      status: 'COMPLETED',
    },
  });
  if (finalized.count !== 1) {
    // 收尾期间会话已被取消/改状态：不扣费、不跑后续 LLM，但仍尽力清 Soniox 资源，
    // 避免上传到 Soniox 的文件/transcription 泄漏。
    if (session.sonioxFileId) {
      await deleteSonioxFile(sonioxConfig, session.sonioxFileId).catch(
        () => undefined
      );
    }
    await deleteSonioxTranscription(sonioxConfig, transcriptionId).catch(
      () => undefined
    );
    return { outcome: 'canceled_during_finalize' };
  }

  // finalize 守卫成功之后立即执行的副作用（route：失效 sessions API 缓存）。
  if (options.onCompleted) {
    await options.onCompleted(session);
  }

  // 异步上传转录计费（批2 + B1）：上方 claim + 此处 finalize 守卫共同保证每个 session 仅有一个
  // 路径进到此分支且未被取消，故结算恰好执行一次（幂等无须额外锁）。按 ceil(分钟)×倍率 扣减，
  // 倍率默认 0.8、可在 admin 设置；与对账侧口径一致。计费失败不影响转录完成，留给对账兜底。
  //
  // B1：把入口预留（session.asyncReservedMinutes，已计入 used）「转」为实扣——同一事务里
  // deduct 实际 + release 预留 + 清预留列。used 净变化 = 实扣，且不残留预留。三步原子，避免
  // finalize 与预留结算脱节；即便本事务整体失败，预留仍留在列上，由 cron 兜底释放。
  try {
    const { async_upload_billing_multiplier } = await getSiteSettings();
    const billableMinutes = Math.ceil(
      getBillableMinutes(session.durationMs) * async_upload_billing_multiplier
    );
    await prisma.$transaction(async (tx) => {
      if (billableMinutes > 0) {
        await deductTranscriptionMinutes(session.userId, billableMinutes, tx);
      }
      // 把入口预留「转」为实扣：settleAsyncReservation 用 FOR UPDATE 读**当前**列并原子释放。
      // deduct 内部 ensureQuotaWindow 若刚触发月度重置会顺带清列 → 此时 settle 读到 0、不重复释放，
      // 杜绝跨周期把已被重置隐式清除的预留再减一次（审查 R1）。并发多路径经 settle 也仅释放一次。
      await settleAsyncReservation(session.id, tx);
    });
  } catch (billingErr) {
    logger.error(
      { err: billingErr, sessionId: session.id },
      'async upload billing settle failed (transcription already completed)'
    );
  }

  // fire-and-forget：runBackgroundLLMTasks 自带 try/catch，不阻塞响应
  void runBackgroundLLMTasks({
    sessionId: session.id,
    userId: session.userId,
    transcriptPath: persisted.transcript.path,
    summaryPath: persisted.summary.path,
    recordingPath: session.recordingPath,
    title: session.title,
    courseName: session.courseName ?? '',
    durationMs: session.durationMs,
    createdAt: session.createdAt,
    targetLang: session.targetLang || 'zh',
    folderIds: session.folderIds,
    bundle,
  });

  // 删 Soniox 上的资源（幂等，失败不抛）
  if (session.sonioxFileId) {
    await deleteSonioxFile(sonioxConfig, session.sonioxFileId).catch(
      () => undefined
    );
  }
  await deleteSonioxTranscription(sonioxConfig, transcriptionId).catch(
    () => undefined
  );

  return {
    outcome: 'completed',
    transcriptPath: persisted.transcript.path,
    summaryPath: persisted.summary.path,
    segmentCount: segments.length,
  };
}
