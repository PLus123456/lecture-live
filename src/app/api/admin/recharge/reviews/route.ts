import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  applyPaymentReviewAction,
  listPaymentReviewQueue,
  PaymentReviewAdminError,
  type PaymentReviewAction,
} from '@/lib/payment/adminReview';
import { writeSecurityAudit } from '@/lib/securityAudit';

const ACTIONS = new Set<PaymentReviewAction>([
  'resolve_review',
  'resolve_debt',
  'waive_debt',
  'release_hold',
  'resolve_legacy_refund',
  'resolve_reversal_review',
  'resolve_terminal_order_review',
  'quarantine_stripe_namespace',
  'acknowledge_partial_reversal',
  'map_and_retry_webhook',
  'dismiss_webhook',
]);

export async function GET(req: Request) {
  const { user, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:reviews:list',
    limit: 60,
  });
  if (response || !user) return response!;

  const rawLimit = Number(new URL(req.url).searchParams.get('limit') ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  try {
    const queue = await listPaymentReviewQueue(limit);
    await writeSecurityAudit(req, {
      event: 'payment-review.list',
      operator: { id: user.id, email: user.email, role: user.role },
      target: { type: 'payment_review_queue' },
      reason: 'admin_review_queue',
      outcome: 'SUCCESS',
      metadata: {
        limit: Math.min(100, Math.max(1, Math.trunc(limit))),
        counts: Object.fromEntries(
          Object.entries(queue).map(([key, rows]) => [key, rows.length])
        ),
      },
    });
    return NextResponse.json(queue);
  } catch (err) {
    console.error('支付复核队列读取失败:', err);
    return NextResponse.json({ error: '支付复核队列暂时不可用' }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const { user, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:reviews:resolve',
    limit: 20,
  });
  if (response || !user) return response!;

  let body: { action?: string; id?: string; orderId?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  }
  if (!body.action || !ACTIONS.has(body.action as PaymentReviewAction)) {
    return NextResponse.json({ error: '未知处置动作' }, { status: 400 });
  }

  try {
    const result = await applyPaymentReviewAction(
      req,
      { id: user.id, email: user.email, role: user.role },
      {
        action: body.action as PaymentReviewAction,
        id: body.id ?? '',
        orderId: body.orderId,
        reason: body.reason ?? '',
      }
    );
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    if (err instanceof PaymentReviewAdminError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('支付复核处置失败:', err);
    // Audit persistence is part of the transaction. Any failure reaches here and rolls the
    // mutation back; expose service-unavailable rather than pretending a partial success.
    return NextResponse.json({ error: '支付复核处置暂时不可用' }, { status: 503 });
  }
}
