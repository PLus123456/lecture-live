import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { deductTranscriptionMinutes, recordInterpretUsage } from '@/lib/quota';
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
  if (billableMinutes <= 0) {
    return NextResponse.json({ quotas: null, deducted: 0 });
  }

  const snapshot = await deductTranscriptionMinutes(payload.id, billableMinutes);
  if (!snapshot) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // 已成功扣费 → 记一笔同传用量台账，让对账把 interpret 分钟计入 expected（消除虚报 drift）。
  // billedMinutes 与本次实扣分钟（billableMinutes）一字一致；口径与 deduct 侧完全相同。
  // ADMIN 恒不扣费（snapshot.role==='ADMIN' 即 deduct 短路未 increment），故不记账。
  // 台账失败不回滚扣费、也不阻塞响应：扣费已成功落库是权威；台账仅为对账辅助，best-effort 记录。
  if (snapshot.role !== 'ADMIN') {
    try {
      await recordInterpretUsage(payload.id, billableMinutes, effectiveMs);
    } catch (err) {
      interpretLogger.warn(
        {
          userId: payload.id,
          billedMinutes: billableMinutes,
          message: err instanceof Error ? err.message : String(err),
        },
        'failed to record interpret usage ledger; deduction already applied'
      );
    }
  }

  return NextResponse.json({ quotas: snapshot, deducted: billableMinutes });
}
