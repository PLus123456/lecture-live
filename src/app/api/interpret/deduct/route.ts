import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  deductTranscriptionMinutes,
  recordInterpretUsage,
  getQuotaSnapshot,
} from '@/lib/quota';
import { claimInterpretSessionForDeduct } from '@/lib/interpret/session';
import { settleStreamGrants } from '@/lib/soniox/streamGrant';
import { getBillableMinutes } from '@/lib/billing';
import { logSystemEvent } from '@/lib/auditLog';
import { logger } from '@/lib/logger';
import {
  ANCHOR_ID_RE,
  MAX_INTERPRET_DURATION_MS,
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

  // P6-7：按用户限流（口径对齐 temporary-key 的 12/min）。诚实客户端每场只调一次；这里是
  // 「结算锚点 + 释放整场 mint 预扣」的写入点，脚本刷 start→mint→deduct 循环时它是闸门之一。
  const rateLimited = await enforceRateLimit(req, {
    scope: 'interpret:deduct:user',
    limit: 12,
    windowMs: 60_000,
    key: `user:${payload.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // L30：畸形 JSON 不能变成未捕获异常返回 500 —— 那是客户端错误，语义上必须是 400。
  let body: {
    durationMs?: number;
    translationMode?: TranslationMode;
    anchorId?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const now = Date.now();
  const frontendMs =
    typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
      ? body.durationMs
      : 0;

  // L30：anchorId 是本服务用 randomUUID 生成的，格式固定。此前不做任何校验就直接拿去查 DB
  // （consumeInterpretAnchor 内部有同款正则，但 claimInterpretSessionForDeduct 的 DB 查询之前
  // 一道都没有）。这里在入口收窄。
  // **刻意 400 而不是「当没带 anchorId 处理」**：后者会把畸形输入悄悄改道到「降级盲认领最旧
  // 未结算锚点」那条路径上去 —— 换了一条完全不同的结算语义，是比不校验更糟的惊喜。真实客户端
  // 只会送 null 或一个 randomUUID，送出畸形值的必然是坏掉/改装的客户端，明确拒绝即可
  // （本场锚点原地不动，交给 cron 按实测兜底）。
  const rawAnchorId = typeof body.anchorId === 'string' ? body.anchorId : null;
  if (rawAnchorId !== null && !ANCHOR_ID_RE.test(rawAnchorId)) {
    return NextResponse.json({ error: 'Invalid anchorId' }, { status: 400 });
  }
  const anchorIdForClaim = rawAnchorId;

  // 消费服务端锚点（一次性，读取后即删，防重复扣）
  const anchorStartedAt = anchorIdForClaim
    ? await consumeInterpretAnchor(payload.id, anchorIdForClaim)
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

  // B3：把「认领会话 + 扣费 + 记台账 + 回填实扣」放进**一个事务**原子提交。任一步失败整体回滚 →
  // 会话保持未结算(settledAt=null)、由 cron 兜底，杜绝「已结算却没扣费」的静默免单（审查 R2/R7）。
  // 认领分支（与 cron 兜底经 settledAt 条件认领互斥，恰好扣一次）：
  //  - already_settled：cron 已兜底扣费并结算 → 跳过扣费（防双扣）。
  //  - no_record 且**降级(无 anchorId)**：无法可靠匹配本场、cron 可能已兜底 → 跳过扣费，避免
  //    「cron 已扣 + 这里再扣」双扣（审查 R4）。锚点存在时的 no_record（会话早于部署/边缘）仍正常扣费兜底。
  //  - claimed / no_record(有 anchorId)：正常扣费；claimed 情形回填 billedMinutes（审计）。
  let result: {
    charged: boolean;
    billableMinutes: number;
    snapshot: Awaited<ReturnType<typeof deductTranscriptionMinutes>>;
  };
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

      // R1-L2：认领成功即结算本场锚点关联的全部未结 stream grants（释放 mint 预扣），与实扣
      // 同事务——预扣是占位，净效果=billableMinutes（billable=0 的空场也要释放，不留悬挂预扣）。
      // already_settled 时 cron 已连锚点带 grants 一并结算；no_record 无锚点行、grants 无键可循，
      // 留给 usage cron 孤儿兜底。
      let settledActualMs = 0;
      if (claim.outcome === 'claimed' && claim.sessionId) {
        const settled = await settleStreamGrants(
          { interpretSessionId: claim.sessionId },
          'interpret_deduct',
          tx
        );
        settledActualMs = Math.max(0, settled.actualMsTotal);
      }

      // P3-8：降级路径（不带 anchorId）由 claimInterpretSessionForDeduct 按 {userId, settledAt:null}
      // + startedAt asc **盲认领最旧**未结算锚点，上面这一步随即释放该场**全部** mint 预扣 ——
      // `{durationMs:1}` 就能把串了 N 小时的场一分钟结掉。这里用被结算 grants 的 Soniox 实测量做
      // 下限：它是本路径下唯一不可伪造的服务端口径。实测尚未回填时收益仍归零 —— 迟到的 usage-log
      // 会经 usageReconciliation 的差额补扣补上（P1-2，同一机制）。
      const chargeMs = Math.min(
        anchored ? effectiveMs : Math.max(effectiveMs, settledActualMs),
        MAX_INTERPRET_DURATION_MS
      );
      const billableMinutes = getBillableMinutes(chargeMs);

      const skip =
        claim.outcome === 'already_settled' ||
        (claim.outcome === 'no_record' && anchorIdForClaim === null) ||
        billableMinutes <= 0;

      // M8：`no_record + 有 anchorId` 是「正常扣费兜底」路径，可它没有任何幂等闸 ——
      // settledAt CAS 互斥的前提是有行可认领，而这条路径的成因恰恰是**没有行**（/start 落
      // InterpretSession 是 best-effort，DB 一抖就只 warn 吞错，锚点却已返给客户端）。于是
      // 同一 anchorId 重复 POST（前端超时重试 / 双击）会被扣两次。
      // 一次性扣费凭据：就地把这条缺失的锚点行补上，settledAt 直接置位=已结算。它与扣费**同
      // 事务**提交（同生共死，不需要任何补偿逻辑），此后同一 anchorId 的 deduct 会在
      // claimInterpretSessionForDeduct 里按 anchorId 命中它 → already_settled → 跳过扣费。
      // 无论本次是否真扣到钱都要写（billableMinutes=0 的空场同样要占住这个 anchorId，否则
      // 重试时客户端换一个更大的 durationMs 就能把降级路径再走一遍）。
      // 顺带补上了原本完全缺失的审计行。
      if (claim.outcome === 'no_record' && anchorIdForClaim !== null) {
        await tx.interpretSession.create({
          data: {
            userId: payload.id,
            anchorId: anchorIdForClaim,
            startedAt:
              anchorStartedAt != null
                ? new Date(anchorStartedAt)
                : new Date(now - chargeMs),
            settledAt: new Date(now),
            settledBy: 'deduct_no_record',
            billedMinutes: skip ? 0 : billableMinutes,
          },
        });
      }

      if (skip) {
        return { charged: false, billableMinutes: 0, snapshot: null };
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
        await recordInterpretUsage(payload.id, billableMinutes, chargeMs, tx);
      }
      if (claim.sessionId) {
        await tx.interpretSession.update({
          where: { id: claim.sessionId },
          data: { billedMinutes: billableMinutes },
        });
      }
      return { charged: true, billableMinutes, snapshot };
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
  return NextResponse.json({
    quotas: result.snapshot,
    deducted: result.billableMinutes,
  });
}
