import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { deductTranscriptionMinutes } from '@/lib/quota';
import { getBillableMinutes } from '@/lib/billing';

/**
 * POST /api/interpret/deduct
 * 来回翻译结束后扣除使用时长。
 * Body: { durationMs: number }
 */
export async function POST(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json()) as { durationMs?: number };
  const durationMs = body.durationMs;
  if (typeof durationMs !== 'number' || durationMs <= 0) {
    return NextResponse.json({ error: 'Invalid durationMs' }, { status: 400 });
  }

  const billableMinutes = getBillableMinutes(durationMs);
  const snapshot = await deductTranscriptionMinutes(payload.id, billableMinutes);
  if (!snapshot) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json({ quotas: snapshot, deducted: billableMinutes });
}
