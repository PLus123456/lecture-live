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
 * P5-7：(b) 与扣费/预留结算在**同一事务**里提交，计费失败即整体回滚、退回 transcribing 重试，
 * 绝不出现「终态已落但净扣 0 且无复扣路径」。
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
import {
  deductTranscriptionMinutes,
  settleFullReservation,
} from '@/lib/quota';
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

  // ── finalize 守卫 + 计费：同一事务（P5-7）──
  // 守卫：finalizing → completed，抢不到（收尾期间被取消/重置）则不落地。
  // P1-17：**不再**在此清空 fullSonioxFileId/fullSonioxTranscriptionId —— 改到确认 Soniox DELETE 成功
  // （2xx/404）之后才清（见下方）。此前在 CAS 提交里就清了 ID，删失败即永久失去重试依据、资源孤儿。
  //
  // P5-7：**CAS 与计费必须同事务**。旧实现先单独提交终态（completed + billedAt），再另开事务扣费、
  // 且异常只 log 吞掉 → 计费一失败就净扣 0；两个调用点的 allowClaimFrom 都不含 'completed'，落终态后
  // 再无复扣路径。合并后任一步失败整体回滚：会话退回 transcribing（见下方 catch），交下一轮 poll /
  // cron 回收重收尾，幂等 claim 保证仍恰好扣一次。
  //
  // 锁序：触发路由是 Session FOR UPDATE → User update；旧的独立计费事务是 User update(deduct) →
  // Session FOR UPDATE(settleFullReservation)，同一 session 并发即成 InnoDB 死锁环（P5-7 最现实的
  // 失败原因）。合并后本事务第一条语句就是按主键 X 锁本 Session 行的 CAS，之后才动 User，环被打断。
  let canceledDuringFinalize = false;
  try {
    // 计费口径：ceil(getBillableMinutes(durationMs) × 异步倍率)，与异步上传转录同口径。
    const { async_upload_billing_multiplier } = await getSiteSettings();
    const billableMinutes = Math.ceil(
      getBillableMinutes(session.durationMs) * async_upload_billing_multiplier
    );
    canceledDuringFinalize = await prisma.$transaction(async (tx) => {
      const finalized = await tx.session.updateMany({
        where: { id: session.id, fullTranscribeStatus: 'finalizing' },
        data: {
          fullTranscribeStatus: 'completed',
          fullTranscriptPath: fullPath,
          // B7：置扣费时刻（仅记账时刻）。R4 下真正实扣在同一事务里 deduct + settleFullReservation。
          billedAt: new Date(),
        },
      });
      if (finalized.count !== 1) {
        // 守卫抢不到：不扣费、不结算预留，事务空提交，交下方分支处理。
        return true;
      }

      // R4：把入口预留（session.fullReservedMinutes，已计入 used）「转」为实扣——deduct 实际 +
      // settleFullReservation 释放预留 + 清预留列。net used = +预留(reserve) +实扣(deduct) −释放(settle)
      // = 实扣一笔，且不残留预留。settleFullReservation 用 FOR UPDATE 读**当前**列并原子释放：deduct
      // 内部 ensureQuotaWindow 若刚触发月度重置会顺带清列 → 此时 settle 读到 0、不重复释放，杜绝跨周期
      // 把已被重置隐式清除的预留再减一次（B1 审查 R1）。并发多路径经 settle 也仅释放一次。
      if (billableMinutes > 0) {
        // P5-5：带 sessionId → 同事务写 Session.billedMinutes 台账（完整版可重跑 N 次 = N 笔真实扣费，
        // 对账据此算 expected，重跑不再对账成「虚高 drift」）。
        await deductTranscriptionMinutes(session.userId, billableMinutes, tx, {
          sessionId: session.id,
        });
      }
      await settleFullReservation(session.id, tx);
      return false;
    });
  } catch (billingErr) {
    // P5-7：CAS+计费整体回滚（最现实的是死锁 / 事务超时）。此刻会话仍是 'finalizing'——退回
    // transcribing，让下一次前端 poll 或 cron 回收（allowClaimFrom 含 transcribing）重新收尾。
    // 带 WHERE 守卫：若事务其实已提交、只是响应丢失，状态已是 completed → 0 行、绝不回退终态。
    logger.error(
      { err: billingErr, sessionId: session.id },
      'full transcribe finalize+billing tx failed; rolled back to transcribing for retry'
    );
    await prisma.session
      .updateMany({
        where: { id: session.id, fullTranscribeStatus: 'finalizing' },
        data: { fullTranscribeStatus: 'transcribing' },
      })
      .catch(() => undefined);
    // 与「对方已抢先」同一语义：调用方读最新状态、交下一轮重试（绝不删 Soniox 资源）。
    return { outcome: 'claim_lost' };
  }

  if (canceledDuringFinalize) {
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

  // ── 清 Soniox 资源（P1-17：先删 transcription 再删 file；确认删除成功/404 才清 DB 外部 ID）──
  // 确认删除才清 ID → 删失败保留 ID，交 cron 兜底重扫（reclaimOrphanSonioxResources）重试，绝不永久孤儿。
  const txDeleted = await deleteSonioxTranscription(sonioxConfig, transcriptionId).catch(
    () => false
  );
  const fileDeleted = session.fullSonioxFileId
    ? await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(() => false)
    : true;
  if (txDeleted || fileDeleted) {
    await prisma.session
      .updateMany({
        where: { id: session.id },
        data: {
          ...(txDeleted ? { fullSonioxTranscriptionId: null } : {}),
          ...(fileDeleted ? { fullSonioxFileId: null } : {}),
        },
      })
      .catch(() => undefined);
  }

  return { outcome: 'completed', fullTranscriptPath: fullPath, segmentCount: segments.length };
}
