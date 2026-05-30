import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { deductTranscriptionMinutes } from '@/lib/quota';
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
 * 防止纯信前端上报少报省钱。本地翻译（translationMode='local'）成本为 0，不扣费。
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

  // 本地翻译不计费
  if (body.translationMode === 'local') {
    return NextResponse.json({ quotas: null, deducted: 0, skipped: 'local_translation' });
  }

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

  return NextResponse.json({ quotas: snapshot, deducted: billableMinutes });
}
