import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  deductTranscriptionMinutes,
  recordInterpretUsage,
  getQuotaSnapshot,
} from '@/lib/quota';
import { claimInterpretSessionForDeduct } from '@/lib/interpret/session';
import { getBillableMinutes } from '@/lib/billing';
import { logSystemEvent } from '@/lib/auditLog';
import { logger } from '@/lib/logger';
import {
  consumeInterpretAnchor,
  resolveBillableInterpretMs,
} from '@/lib/interpret/anchor';
import type { TranslationMode } from '@/types/transcript';

const interpretLogger = logger.child({ component: 'interpret-deduct' });

/**
 * POST /api/interpret/deduct
 * 来回翻译结束后扣除使用时长。
 * Body: { durationMs?: number, translationMode?: TranslationMode, anchorId?: string }
 *
 * 计费以服务端时长锚点（/api/interpret/start 建立）为权威，前端 durationMs 仅在容差内被采纳，
 * 防止纯信前端上报少报省钱。
 *
 * 安全（U14）：不再信任客户端上报的 translationMode='local' 直接免单。同声传译无论
 * 前端选什么翻译模式，转录一路恒经 Soniox（后端不观测翻译落地方式），成本恒发生；
 * 若信任客户端把 'local' 短路成 0，任意用户改一个请求字段即可零成本无限刷同传。
 * 因此这里恒按服务端时长锚点扣 transcription_minutes（body.translationMode 仅保留为
 * 类型契约，不再参与计费决策）。
 */
export async function POST(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json()) as {
    durationMs?: number;
    translationMode?: TranslationMode;
    anchorId?: string;
  };

  const now = Date.now();
  const frontendMs =
    typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
      ? body.durationMs
      : 0;

  // 消费服务端锚点（一次性，读取后即删，防重复扣）
  const anchorStartedAt =
    typeof body.anchorId === 'string'
      ? await consumeInterpretAnchor(payload.id, body.anchorId)
      : null;

  // 无锚点且前端也没报有效时长：保持旧行为返回 400
  if (anchorStartedAt === null && frontendMs <= 0) {
    return NextResponse.json({ error: 'Invalid durationMs' }, { status: 400 });
  }

  const { effectiveMs, mismatch, anchored } = resolveBillableInterpretMs({
    frontendMs,
    anchorStartedAt,
    now,
  });

  if (mismatch && anchorStartedAt !== null) {
    // 检测到前端明显少报，已按服务端墙钟扣费，记审计
    logSystemEvent(
      'interpret.duration_mismatch',
      JSON.stringify({
        userId: payload.id,
        frontendMs,
        serverElapsedMs: now - anchorStartedAt,
        effectiveMs,
      })
    );
  } else if (!anchored) {
    // 降级路径：Redis 不可用 / 老客户端不带 anchorId / 锚点过期，只能信任前端时长
    interpretLogger.warn(
      { userId: payload.id, frontendMs },
      'interpret deduct without server anchor; trusting client durationMs'
    );
  }

  const billableMinutes = getBillableMinutes(effectiveMs);
  const anchorIdForClaim =
    typeof body.anchorId === 'string' ? body.anchorId : null;

  // B3：把「认领会话 + 扣费 + 记台账 + 回填实扣」放进**一个事务**原子提交。任一步失败整体回滚 →
  // 会话保持未结算(settledAt=null)、由 cron 兜底，杜绝「已结算却没扣费」的静默免单（审查 R2/R7）。
  // 认领分支（与 cron 兜底经 settledAt 条件认领互斥，恰好扣一次）：
  //  - already_settled：cron 已兜底扣费并结算 → 跳过扣费（防双扣）。
  //  - no_record 且**降级(无 anchorId)**：无法可靠匹配本场、cron 可能已兜底 → 跳过扣费，避免
  //    「cron 已扣 + 这里再扣」双扣（审查 R4）。锚点存在时的 no_record（会话早于部署/边缘）仍正常扣费兜底。
  //  - claimed / no_record(有 anchorId)：正常扣费；claimed 情形回填 billedMinutes（审计）。
  let result: { charged: boolean; snapshot: Awaited<ReturnType<typeof deductTranscriptionMinutes>> };
  try {
    result = await prisma.$transaction(async (tx) => {
      const claim = await claimInterpretSessionForDeduct(
        payload.id,
        anchorIdForClaim,
        // R1-C Finding 1：传入本流锚点起点（Redis 消费得到），供 anchorId 落空时精确回退认领 mint 补建的
        // 本流 null-anchor 锚点、且只认 startedAt >= 本起点者，杜绝误结算并发/上一场锚点。
        anchorStartedAt,
        tx
      );

      const skip =
        claim.outcome === 'already_settled' ||
        (claim.outcome === 'no_record' && anchorIdForClaim === null) ||
        billableMinutes <= 0;
      if (skip) {
        return { charged: false, snapshot: null };
      }

      const snapshot = await deductTranscriptionMinutes(
        payload.id,
        billableMinutes,
        tx
      );
      if (!snapshot) {
        // 用户不存在：回滚整个事务（含认领），会话留给 cron。
        throw new Error('interpret deduct: user not found');
      }
      // ADMIN 恒不扣费（snapshot.role==='ADMIN' 即 deduct 短路未 increment），不记台账。
      // 台账与扣费同事务：口径 billedMinutes 与实扣一字一致，供对账计入 expected。
      if (snapshot.role !== 'ADMIN') {
        await recordInterpretUsage(payload.id, billableMinutes, effectiveMs, tx);
      }
      if (claim.sessionId) {
        await tx.interpretSession.update({
          where: { id: claim.sessionId },
          data: { billedMinutes: billableMinutes },
        });
      }
      return { charged: true, snapshot };
    });
  } catch (err) {
    interpretLogger.error(
      {
        userId: payload.id,
        message: err instanceof Error ? err.message : String(err),
      },
      'interpret deduct transaction failed; session left unsettled for cron'
    );
    return NextResponse.json({ error: 'Deduct failed' }, { status: 500 });
  }

  if (!result.charged) {
    // 未扣费（已结算 / 降级无记录 / 不足 1 分钟）：返回当前配额快照。
    const snap = await getQuotaSnapshot(payload.id);
    return NextResponse.json({ quotas: snap, deducted: 0 });
  }
  return NextResponse.json({ quotas: result.snapshot, deducted: billableMinutes });
}
