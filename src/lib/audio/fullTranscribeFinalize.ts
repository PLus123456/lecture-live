/**
 * 完整版补全转录的「收尾（finalize）」+ 计费逻辑。
 *
 * 与 asyncTranscribeFinalize（上传文件转录）**平行且独立**：用一套独立的 full* 字段
 * （fullTranscribeStatus / fullTranscriptPath / fullSonioxTranscriptionId …），产出一份
 * 「独立并列」的完整转录，**绝不覆盖**实时录音的 transcriptPath / recordingPath / status。
 *
 * 幂等 & 计费（关键，不可漂移）：靠两道条件原子 updateMany —
 *   (a) claim：WHERE fullTranscribeStatus='transcribing' → 'finalizing'，抢到(count===1)才继续；
 *   (b) finalize 守卫：WHERE fullTranscribeStatus='finalizing' → 'completed'，抢不到则不扣费。
 * 故对同一 session，补全转录的扣费恰好执行一次（前端 poll 与 cron 回收互斥，绝不双扣）。
 * 计费口径：ceil(getBillableMinutes(durationMs) × async_upload_billing_multiplier)，与异步上传
 * 转录同口径（倍率默认 0.8、admin 可配）。
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
import {
  persistArtifact,
  readArtifactFromReference,
} from '@/lib/sessionPersistence';
import { deductTranscriptionMinutes } from '@/lib/quota';
import { getBillableMinutes } from '@/lib/billing';
import { getSiteSettings } from '@/lib/siteSettings';

export interface FullTranscriptBundle {
  segments: unknown[];
  summaries: unknown[];
  translations: Record<string, string>;
}

/**
 * 落盘完整版补全转录 bundle。
 *
 * 阶段C：走 sessionPersistence 的 persistArtifact（'full-transcripts' category），与实时
 * 转录/摘要/报告同一套 category + Cloudreve 存储系统 —— Cloudreve 已配置则上传远程并返回
 * 远程路径，否则落本地 data/full-transcripts/{id}.json 并返回 `local:` 引用。返回值写回
 * fullTranscriptPath；与实时 transcriptPath 完全分离，绝不互相覆盖。
 */
export async function persistFullTranscript(
  session: Pick<Session, 'id' | 'userId'>,
  bundle: FullTranscriptBundle
): Promise<string> {
  const result = await persistArtifact(
    session,
    'full-transcripts',
    JSON.stringify(bundle, null, 2)
  );
  return result.path;
}

/**
 * 读取完整版补全转录 bundle（回放页「完整版」视图 + 读取端点 GET full-transcript 用）。
 *
 * 阶段C：走 sessionPersistence 的 readArtifactFromReference —— 统一兼容 `local:` 引用（含
 * 阶段B 落的老数据）与 Cloudreve 远程路径；fullTranscriptPath 为空时回退按 sessionId 约定的
 * 本地候选（兼容文件已落盘但 path 尚未写回 DB 的边缘态）。找不到 / JSON 损坏 → null
 * （调用方降级为空）。字段做防御性归一，绝不抛。
 */
export async function loadFullTranscript(
  session: Pick<Session, 'id' | 'userId' | 'fullTranscriptPath'>
): Promise<FullTranscriptBundle | null> {
  const buffer = await readArtifactFromReference(
    session,
    'full-transcripts',
    session.fullTranscriptPath
  );
  if (!buffer) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Partial<FullTranscriptBundle>;
  const translations =
    record.translations && typeof record.translations === 'object' && !Array.isArray(record.translations)
      ? Object.fromEntries(
          Object.entries(record.translations as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string'
          ) as [string, string][]
        )
      : {};

  return {
    segments: Array.isArray(record.segments) ? record.segments : [],
    summaries: Array.isArray(record.summaries) ? record.summaries : [],
    translations,
  };
}

export type FinalizableFullSession = Pick<
  Session,
  'id' | 'userId' | 'fullSonioxFileId' | 'fullSonioxTranscriptionId' | 'targetLang' | 'durationMs'
>;

export type FinalizeFullResult =
  | { outcome: 'claim_lost' }
  | { outcome: 'canceled_during_finalize' }
  | { outcome: 'completed'; fullTranscriptPath: string; segmentCount: number };

/**
 * 收尾一份「Soniox 侧已 completed」的完整版补全转录。调用前提：调用方已确认 Soniox job completed。
 * 不 poll Soniox 状态，只抢锁 + 拉 transcript + 落 fullTranscriptPath + 扣费。
 */
export async function finalizeFullTranscription(
  session: FinalizableFullSession,
  sonioxConfig: SonioxRuntimeConfig,
  options?: { allowClaimFrom?: string[] }
): Promise<FinalizeFullResult> {
  const transcriptionId = session.fullSonioxTranscriptionId;
  if (!transcriptionId) {
    return { outcome: 'claim_lost' };
  }

  // ── 条件原子 claim：transcribing → finalizing ──
  // allowClaimFrom：前端 poll 默认只从 transcribing 抢；cron 回收兜底可传 ['transcribing','finalizing']
  // 以复收「收尾中途崩溃」的 finalizing 僵尸（幂等仍由下方 finalize 守卫保证，扣费恰好一次）。
  // 同时刷新 fullTranscribeStartedAt：把「刚发起、在途」的 finalize 与「6h 前发起、已崩」的 finalizing
  // 僵尸区分开——否则 cron 回收会把刚被 claim 的在途 finalize 误当僵尸处理，与其 finalize 守卫赛跑，
  // 把它逼进 canceled_during_finalize 误删 Soniox 转录、致会话永久卡死（回归红线）。
  const allowClaimFrom = options?.allowClaimFrom ?? ['transcribing'];
  const claim = await prisma.session.updateMany({
    where: { id: session.id, fullTranscribeStatus: { in: allowClaimFrom } },
    data: { fullTranscribeStatus: 'finalizing', fullTranscribeStartedAt: new Date() },
  });
  if (claim.count !== 1) {
    return { outcome: 'claim_lost' };
  }

  const transcript = await getSonioxTranscript(sonioxConfig, transcriptionId);
  const segments = convertAsyncTokensToSegments(transcript.tokens, {
    targetLang: session.targetLang,
  });
  const translations = extractTranslationsByTokens(transcript.tokens, segments);
  const bundle = { segments, summaries: [] as unknown[], translations };

  // 落盘到独立的 full-transcripts（**不碰** transcriptPath / recordingPath / status）。
  // session 含 userId，Cloudreve 已配置时按 userId 归属上传远程。
  const fullPath = await persistFullTranscript(session, bundle);

  // finalize 守卫：finalizing → completed，抢不到（收尾期间被取消/重置）则不扣费。
  const finalized = await prisma.session.updateMany({
    where: { id: session.id, fullTranscribeStatus: 'finalizing' },
    data: {
      fullTranscribeStatus: 'completed',
      fullTranscriptPath: fullPath,
      fullSonioxFileId: null,
      fullSonioxTranscriptionId: null,
    },
  });
  if (finalized.count !== 1) {
    // 守卫抢不到：收尾期间状态已不是 finalizing。**关键：此处绝不删 Soniox 资源。**
    // 完整版转录没有「用户取消」路径，故 finalizing 被抢走只可能是两种情形，删 Soniox 都是错的：
    //  (1) 另一条 finalize（前端 poll / cron 回收）先赢了守卫 → 它已落盘、会自行清 Soniox，
    //      这里再删是多余；
    //  (2) 前端 poll 的 catch 把 finalizing 盲目回退成 transcribing（可能撞到本条并发 finalize）
    //      → 转录仍需要，若这里删了 Soniox transcription，后续 salvage 会 getSoniox 404、
    //      会话永久卡在 transcribing 且转录被销毁（回归红线）。保留 Soniox → 交由下一轮 poll/
    //      cron 重新 salvage 收尾。任一路径最终都会清 Soniox（completed）或删会话时清（delete 路由）。
    return { outcome: 'canceled_during_finalize' };
  }

  // ── 计费（额外按异步倍率扣，与异步上传转录同口径）──
  // claim + finalize 守卫共同保证仅一个路径进到此分支且未被取消，故恰好扣一次。
  // 计费失败不影响转录完成，留给对账兜底。
  try {
    const { async_upload_billing_multiplier } = await getSiteSettings();
    const billableMinutes = Math.ceil(
      getBillableMinutes(session.durationMs) * async_upload_billing_multiplier
    );
    if (billableMinutes > 0) {
      await deductTranscriptionMinutes(session.userId, billableMinutes);
    }
  } catch (billingErr) {
    logger.error(
      { err: billingErr, sessionId: session.id },
      'full transcribe billing deduct failed (transcription already completed)'
    );
  }

  // 清 Soniox 资源（幂等，失败不抛）
  if (session.fullSonioxFileId) {
    await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(() => undefined);
  }
  await deleteSonioxTranscription(sonioxConfig, transcriptionId).catch(() => undefined);

  return { outcome: 'completed', fullTranscriptPath: fullPath, segmentCount: segments.length };
}
