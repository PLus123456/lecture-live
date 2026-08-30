import 'server-only';

import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { writeSecurityAudit } from '@/lib/securityAudit';
import { handlePaymentReversal } from '@/lib/payment/refundHandling';
import { creditPaidOrder } from '@/lib/wallet';
import {
  claimWebhookEvent,
  linkPaymentProviderObjects,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  type PersistedWebhookEvent,
} from '@/lib/payment/webhookInbox';
import {
  isPaymentProviderName,
  type PaymentObjectRef,
  type PaymentProviderMode,
} from '@/lib/payment/types';

type Tx = Prisma.TransactionClient;

export type PaymentReviewAction =
  | 'resolve_review'
  | 'resolve_debt'
  | 'waive_debt'
  | 'release_hold'
  | 'resolve_legacy_refund'
  | 'resolve_reversal_review'
  | 'resolve_terminal_order_review'
  | 'quarantine_stripe_namespace'
  | 'acknowledge_partial_reversal'
  | 'map_and_retry_webhook'
  | 'dismiss_webhook';

export interface PaymentReviewOperator {
  id: string;
  email?: string | null;
  role?: string | null;
}

export interface PaymentReviewActionInput {
  action: PaymentReviewAction;
  id: string;
  reason: string;
  orderId?: string;
}

export class PaymentReviewAdminError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'PaymentReviewAdminError';
  }
}

interface DiscoveryRow {
  userId: string | null;
  sourceOrderId?: string | null;
}

interface ReviewRow {
  id: string;
  userId: string | null;
  orderId: string | null;
  webhookEventId: string | null;
  reason: string;
  status: string;
}

interface DebtRow {
  id: string;
  userId: string;
  sourceOrderId: string;
  amountCents: number;
  recoveredCents: number;
  reason: string;
  status: string;
}

interface HoldRow {
  id: string;
  userId: string;
  sourceOrderId: string | null;
  debtId: string | null;
  reason: string;
  status: string;
}

interface OrderRow {
  id: string;
  userId: string;
  status: string;
  refundedAt: Date | string | null;
  fulfillmentStatus: string;
  reviewReason: string | null;
}

interface MappingOrderRow extends OrderRow {
  provider: string;
  providerMode: string;
  providerAccount: string;
  outTradeNo: string;
  providerRef: string | null;
  providerCheckoutSessionRef: string | null;
  amountCents: number;
  currency: string;
}

interface NamespaceOrderRow extends MappingOrderRow {
  providerChargeRef: string | null;
}

interface MappingWebhookRow {
  id: string;
  provider: string;
  providerMode: string;
  providerAccount: string;
  eventId: string;
  eventType: string;
  status: PersistedWebhookEvent['status'];
  attempts: number | bigint;
  payloadSha256: string;
  payloadJson: string;
  updatedAt: Date | string;
}

const STALE_WEBHOOK_PROCESSING_MS = 5 * 60_000;
const STALE_WEBHOOK_RECEIVED_MS = 60_000;

function boundedReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length < 3 || normalized.length > 1000) {
    throw new PaymentReviewAdminError(
      '必须提供 3-1000 字符的处置原因',
      'REASON_REQUIRED',
      400
    );
  }
  return normalized;
}

function boundedId(id: string): string {
  const normalized = id.trim();
  if (!normalized || normalized.length > 191) {
    throw new PaymentReviewAdminError('处置对象 id 无效', 'INVALID_ID', 400);
  }
  return normalized;
}

async function discoverTarget(
  action: PaymentReviewAction,
  id: string,
  orderId?: string
): Promise<{ userId: string; sourceOrderId: string | null }> {
  let rows: DiscoveryRow[];
  if (action === 'resolve_review') {
    rows = await prisma.$queryRaw<DiscoveryRow[]>`
      SELECT COALESCE(review.userId, paymentOrder.userId) AS userId
      FROM PaymentReviewCase review
      LEFT JOIN PaymentOrder paymentOrder ON paymentOrder.id = review.orderId
      WHERE review.id = ${id}
      LIMIT 1
    `;
  } else if (action === 'resolve_debt' || action === 'waive_debt') {
    rows = await prisma.$queryRaw<DiscoveryRow[]>`
      SELECT userId FROM PaymentDebt WHERE id = ${id} LIMIT 1
    `;
  } else if (action === 'release_hold') {
    rows = await prisma.$queryRaw<DiscoveryRow[]>`
      SELECT userId, sourceOrderId FROM PaymentAccountHold WHERE id = ${id} LIMIT 1
    `;
  } else if (
    action === 'resolve_legacy_refund' ||
    action === 'resolve_reversal_review' ||
    action === 'resolve_terminal_order_review' ||
    action === 'quarantine_stripe_namespace'
  ) {
    rows = await prisma.$queryRaw<DiscoveryRow[]>`
      SELECT userId FROM PaymentOrder WHERE id = ${id} LIMIT 1
    `;
  } else if (action === 'acknowledge_partial_reversal') {
    rows = await prisma.$queryRaw<DiscoveryRow[]>`
      SELECT COALESCE(review.userId, paymentOrder.userId) AS userId,
             paymentOrder.id AS sourceOrderId
      FROM PaymentWebhookEvent event
      JOIN PaymentReviewCase review ON review.webhookEventId = event.id
      LEFT JOIN PaymentOrder paymentOrder ON paymentOrder.id = review.orderId
      WHERE event.id = ${id} AND review.status = 'open'
      ORDER BY review.id LIMIT 1
    `;
  } else {
    const selectedOrderId = boundedId(orderId ?? '');
    rows = await prisma.$queryRaw<DiscoveryRow[]>`
      SELECT userId FROM PaymentOrder WHERE id = ${selectedOrderId} LIMIT 1
    `;
  }
  const userId = rows[0]?.userId?.trim();
  if (!userId) {
    throw new PaymentReviewAdminError('处置对象不存在', 'NOT_FOUND', 404);
  }
  return { userId, sourceOrderId: rows[0]?.sourceOrderId ?? null };
}

async function resolveTerminalOrderReview(
  tx: Tx,
  req: Request,
  operator: PaymentReviewOperator,
  id: string,
  discoveredUserId: string,
  reason: string
): Promise<Record<string, unknown>> {
  // Keep the global payment mutation lock order: PaymentOrder -> User -> review rows.
  const rows = await tx.$queryRaw<OrderRow[]>`
    SELECT id, userId, status, refundedAt, fulfillmentStatus, reviewReason
    FROM PaymentOrder WHERE id = ${id} FOR UPDATE
  `;
  const order = rows[0];
  if (!order || order.userId !== discoveredUserId) {
    throw new PaymentReviewAdminError('订单不存在或归属已变化', 'NOT_FOUND', 404);
  }
  await lockUser(tx, order.userId);
  if (
    order.status !== 'refunded' ||
    !order.refundedAt ||
    order.fulfillmentStatus !== 'reversed'
  ) {
    throw new PaymentReviewAdminError(
      '只有已确认退款且权益已终态反向的订单可以关闭复核项',
      'ORDER_NOT_TERMINALLY_REVERSED',
      409
    );
  }
  const cases = await tx.$queryRaw<ReviewRow[]>`
    SELECT review.id, review.userId, review.orderId, review.webhookEventId,
           review.reason, review.status
    FROM PaymentReviewCase review
    WHERE review.orderId = ${id} AND review.status = 'open'
    ORDER BY review.id
  `;
  if (cases.length === 0) {
    throw new PaymentReviewAdminError('订单没有待关闭的复核项', 'NO_OPEN_REVIEW', 409);
  }
  const webhookIds = [
    ...new Set(cases.map((item) => item.webhookEventId).filter(Boolean)),
  ] as string[];
  // Mapping/retry uses Order -> User -> Event -> Case. Preserve that exact order here.
  for (const webhookId of webhookIds.sort()) {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentWebhookEvent WHERE id = ${webhookId} FOR UPDATE
    `;
  }
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM PaymentReviewCase
    WHERE orderId = ${id} AND status = 'open'
    ORDER BY id FOR UPDATE
  `;
  for (const webhookId of webhookIds) {
    await tx.$executeRaw`
      UPDATE PaymentWebhookEvent
      SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
      WHERE id = ${webhookId} AND status IN ('received', 'review', 'failed')
    `;
  }
  await tx.$executeRaw`
    UPDATE PaymentReviewCase
    SET status = 'resolved', resolvedAt = NOW(3), updatedAt = NOW(3)
    WHERE orderId = ${id} AND status = 'open'
  `;
  // This durable, reason-bound marker prevents the idempotent legacy remediation from
  // reopening a deliberately closed, provably terminal refund on the next deployment.
  await tx.$executeRaw`
    UPDATE PaymentOrder
    SET reviewReason = 'terminal_refund_review_resolved', fulfillmentError = NULL
    WHERE id = ${id} AND status = 'refunded'
      AND refundedAt IS NOT NULL AND fulfillmentStatus = 'reversed'
  `;
  const after = {
    ...order,
    reviewReason: 'terminal_refund_review_resolved',
    resolvedReviewIds: cases.map((item) => item.id),
    processedWebhookIds: webhookIds,
  };
  await auditAction(
    tx,
    req,
    operator,
    'resolve_terminal_order_review',
    id,
    order.userId,
    reason,
    { order, openReviewIds: cases.map((item) => item.id) },
    after
  );
  return after;
}

function parseRetryPayload(payloadJson: string): {
  kind: 'paid' | 'reversal';
  outTradeNo?: string;
  providerRef?: string;
  rawStatus?: string;
  amountCents?: number;
  currency?: string;
  occurredAt?: Date;
  reversalAmountCents?: number;
  fullReversal?: boolean;
  reversalState?: 'pending' | 'withdrawn' | 'reinstated';
  objectRefs: PaymentObjectRef[];
} {
  if (Buffer.byteLength(payloadJson, 'utf8') > 16 * 1024) {
    throw new PaymentReviewAdminError(
      'Webhook 归一化载荷超出安全上限',
      'INVALID_WEBHOOK_PAYLOAD',
      409
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    throw new PaymentReviewAdminError(
      'Webhook 归一化载荷损坏',
      'INVALID_WEBHOOK_PAYLOAD',
      409
    );
  }
  const paid = payload.paid === true;
  const reversal = payload.reversal === true;
  if (paid === reversal) {
    throw new PaymentReviewAdminError(
      '只有明确 paid 或 reversal 的事件允许人工映射重试',
      'NOT_A_RETRYABLE_PAYMENT_EVENT',
      409
    );
  }
  const seen = new Set<string>();
  const objectRefs: PaymentObjectRef[] = [];
  for (const candidate of Array.isArray(payload.objectRefs)
    ? payload.objectRefs.slice(0, 16)
    : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const ref = candidate as Record<string, unknown>;
    const objectType = typeof ref.objectType === 'string' ? ref.objectType.trim() : '';
    const objectId = typeof ref.objectId === 'string' ? ref.objectId.trim() : '';
    if (!objectType || objectType.length > 64 || !objectId || objectId.length > 191) continue;
    const key = `${objectType}\0${objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    objectRefs.push({ objectType, objectId });
  }
  if (objectRefs.length === 0) {
    throw new PaymentReviewAdminError(
      'Webhook 没有可映射的网关对象引用',
      'MISSING_PROVIDER_OBJECTS',
      409
    );
  }
  return {
    kind: reversal ? 'reversal' : 'paid',
    outTradeNo:
      typeof payload.outTradeNo === 'string' && payload.outTradeNo.trim()
        ? payload.outTradeNo.trim().slice(0, 191)
        : undefined,
    providerRef:
      typeof payload.providerRef === 'string' ? payload.providerRef.slice(0, 191) : undefined,
    rawStatus:
      typeof payload.rawStatus === 'string' ? payload.rawStatus.slice(0, 191) : undefined,
    amountCents:
      typeof payload.amountCents === 'number' && Number.isSafeInteger(payload.amountCents)
        ? payload.amountCents
        : undefined,
    currency:
      typeof payload.currency === 'string' ? payload.currency.slice(0, 8) : undefined,
    occurredAt:
      typeof payload.occurredAt === 'string' &&
      Number.isFinite(new Date(payload.occurredAt).getTime())
        ? new Date(payload.occurredAt)
        : undefined,
    reversalAmountCents:
      typeof payload.reversalAmountCents === 'number' &&
      Number.isSafeInteger(payload.reversalAmountCents) &&
      payload.reversalAmountCents > 0
        ? payload.reversalAmountCents
        : undefined,
    fullReversal:
      typeof payload.fullReversal === 'boolean' ? payload.fullReversal : undefined,
    reversalState:
      payload.reversalState === 'pending' ||
      payload.reversalState === 'withdrawn' ||
      payload.reversalState === 'reinstated'
        ? payload.reversalState
        : undefined,
    objectRefs,
  };
}

async function lockUser(tx: Tx, userId: string): Promise<void> {
  const users = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM User WHERE id = ${userId} FOR UPDATE
  `;
  if (!users[0]) {
    throw new PaymentReviewAdminError('关联用户不存在', 'USER_NOT_FOUND', 409);
  }
}

async function ensureNoOpenDebt(tx: Tx, userId: string): Promise<void> {
  const debts = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM PaymentDebt
    WHERE userId = ${userId} AND status = 'open'
    ORDER BY id
    LIMIT 1
    FOR UPDATE
  `;
  if (debts[0]) {
    throw new PaymentReviewAdminError(
      '仍有未结清债务，不能解除账户冻结',
      'OPEN_DEBT_REMAINS',
      409
    );
  }
}

async function auditAction(
  tx: Tx,
  req: Request,
  operator: PaymentReviewOperator,
  action: PaymentReviewAction,
  id: string,
  userId: string,
  reason: string,
  before: unknown,
  after: unknown
): Promise<void> {
  await writeSecurityAudit(
    req,
    {
      event: `payment-review.${action.replaceAll('_', '-')}`,
      operator,
      target: { type: 'payment_review_control', id, ownerId: userId },
      before,
      after,
      reason,
      outcome: 'SUCCESS',
    },
    tx
  );
}

async function resolveReview(
  tx: Tx,
  req: Request,
  operator: PaymentReviewOperator,
  id: string,
  userId: string,
  reason: string
): Promise<Record<string, unknown>> {
  await lockUser(tx, userId);
  const rows = await tx.$queryRaw<ReviewRow[]>`
    SELECT id, userId, orderId, webhookEventId, reason, status
    FROM PaymentReviewCase WHERE id = ${id} FOR UPDATE
  `;
  const review = rows[0];
  if (!review || (review.userId && review.userId !== userId)) {
    throw new PaymentReviewAdminError('复核项不存在或归属已变化', 'NOT_FOUND', 404);
  }
  if (review.status !== 'open') {
    throw new PaymentReviewAdminError('复核项已处置', 'ALREADY_RESOLVED', 409);
  }
  if (review.webhookEventId || review.orderId) {
    throw new PaymentReviewAdminError(
      '关联支付事件必须使用映射重试、事件忽略或历史退款处置动作',
      'USE_SPECIFIC_PAYMENT_ACTION',
      409
    );
  }
  await tx.$executeRaw`
    UPDATE PaymentReviewCase
    SET status = 'resolved', resolvedAt = NOW(3), updatedAt = NOW(3)
    WHERE id = ${id} AND status = 'open'
  `;
  const after = { ...review, status: 'resolved' };
  await auditAction(tx, req, operator, 'resolve_review', id, userId, reason, review, after);
  return after;
}

async function settleDebt(
  tx: Tx,
  req: Request,
  operator: PaymentReviewOperator,
  action: 'resolve_debt' | 'waive_debt',
  id: string,
  userId: string,
  reason: string
): Promise<Record<string, unknown>> {
  await lockUser(tx, userId);
  const rows = await tx.$queryRaw<DebtRow[]>`
    SELECT id, userId, sourceOrderId, amountCents, recoveredCents, reason, status
    FROM PaymentDebt WHERE id = ${id} FOR UPDATE
  `;
  const debt = rows[0];
  if (!debt || debt.userId !== userId) {
    throw new PaymentReviewAdminError('债务不存在或归属已变化', 'NOT_FOUND', 404);
  }
  if (debt.status !== 'open') {
    throw new PaymentReviewAdminError('债务已处置', 'ALREADY_RESOLVED', 409);
  }
  const nextStatus = action === 'waive_debt' ? 'waived' : 'resolved';
  const recoveredCents =
    action === 'resolve_debt' ? Number(debt.amountCents) : Number(debt.recoveredCents);
  await tx.$executeRaw`
    UPDATE PaymentDebt
    SET status = ${nextStatus}, recoveredCents = ${recoveredCents},
        resolvedAt = NOW(3), updatedAt = NOW(3)
    WHERE id = ${id} AND status = 'open'
  `;
  // Deliberately do not release a hold here. A separate release action rechecks every open debt
  // and review row under the same User lock, so a single waived debt cannot accidentally unfreeze
  // an account that still has another unresolved chargeback.
  const after = { ...debt, status: nextStatus, recoveredCents };
  await auditAction(tx, req, operator, action, id, userId, reason, debt, after);
  return after;
}

async function releaseHold(
  tx: Tx,
  req: Request,
  operator: PaymentReviewOperator,
  id: string,
  userId: string,
  expectedSourceOrderId: string | null,
  reason: string
): Promise<Record<string, unknown>> {
  let lockedOrder: { fulfillmentStatus: string } | undefined;
  if (expectedSourceOrderId) {
    const orders = await tx.$queryRaw<Array<{ fulfillmentStatus: string }>>`
      SELECT fulfillmentStatus FROM PaymentOrder
      WHERE id = ${expectedSourceOrderId} FOR UPDATE
    `;
    lockedOrder = orders[0];
    if (!lockedOrder) {
      throw new PaymentReviewAdminError(
        '关联订单不存在，不能解除账户冻结',
        'ORDER_NOT_FOUND',
        409
      );
    }
  }
  await lockUser(tx, userId);
  const rows = await tx.$queryRaw<HoldRow[]>`
    SELECT id, userId, sourceOrderId, debtId, reason, status
    FROM PaymentAccountHold WHERE id = ${id} FOR UPDATE
  `;
  const hold = rows[0];
  if (!hold || hold.userId !== userId) {
    throw new PaymentReviewAdminError('冻结记录不存在或归属已变化', 'NOT_FOUND', 404);
  }
  if (hold.sourceOrderId !== expectedSourceOrderId) {
    throw new PaymentReviewAdminError(
      '冻结记录关联订单已变化',
      'HOLD_TARGET_CHANGED',
      409
    );
  }
  if (hold.status !== 'active') {
    throw new PaymentReviewAdminError('冻结记录已解除', 'ALREADY_RELEASED', 409);
  }
  await ensureNoOpenDebt(tx, userId);
  if (hold.sourceOrderId) {
    if (lockedOrder?.fulfillmentStatus === 'review') {
      throw new PaymentReviewAdminError(
        '关联订单仍待复核，不能解除账户冻结',
        'ORDER_REVIEW_REMAINS',
        409
      );
    }
    const reviews = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentReviewCase
      WHERE orderId = ${hold.sourceOrderId} AND status = 'open'
      ORDER BY id
      LIMIT 1
      FOR UPDATE
    `;
    if (reviews[0]) {
      throw new PaymentReviewAdminError(
        '关联复核项仍未处置，不能解除账户冻结',
        'OPEN_REVIEW_REMAINS',
        409
      );
    }
  }
  await tx.$executeRaw`
    UPDATE PaymentAccountHold
    SET status = 'released', releasedAt = NOW(3), updatedAt = NOW(3)
    WHERE id = ${id} AND status = 'active'
  `;
  const after = { ...hold, status: 'released' };
  await auditAction(tx, req, operator, 'release_hold', id, userId, reason, hold, after);
  return after;
}

async function resolveLegacyRefund(
  tx: Tx,
  req: Request,
  operator: PaymentReviewOperator,
  id: string,
  discoveredUserId: string,
  reason: string,
  action: 'resolve_legacy_refund' | 'resolve_reversal_review'
): Promise<Record<string, unknown>> {
  // Reversal/fulfillment uses PaymentOrder -> User globally. Preserve that lock order here, then
  // lock debt/hold/review rows only after both roots are held.
  const rows = await tx.$queryRaw<OrderRow[]>`
    SELECT id, userId, status, refundedAt, fulfillmentStatus, reviewReason
    FROM PaymentOrder WHERE id = ${id} FOR UPDATE
  `;
  const order = rows[0];
  if (!order || order.userId !== discoveredUserId) {
    throw new PaymentReviewAdminError('订单不存在或归属已变化', 'NOT_FOUND', 404);
  }
  await lockUser(tx, order.userId);
  const resolvableReasons = new Set([
    'legacy_refund_unresolved',
    'reversal_provenance_unresolved',
    'stripe_namespace_unverified',
  ]);
  if (
    order.fulfillmentStatus !== 'review' ||
    !order.reviewReason ||
    !resolvableReasons.has(order.reviewReason) ||
    (order.status !== 'refunded' && !order.refundedAt)
  ) {
    throw new PaymentReviewAdminError(
      '订单不处于历史退款人工复核状态',
      'NOT_LEGACY_REFUND_REVIEW',
      409
    );
  }
  await ensureNoOpenDebt(tx, order.userId);
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM PaymentAccountHold
    WHERE sourceOrderId = ${id} AND status = 'active'
    ORDER BY id
    FOR UPDATE
  `;
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM PaymentReviewCase
    WHERE orderId = ${id} AND status = 'open'
    ORDER BY id
    FOR UPDATE
  `;
  const manualMarker =
    order.reviewReason === 'legacy_refund_unresolved'
      ? 'legacy_refund_manually_resolved'
      : 'reversal_review_manually_resolved';
  await tx.$executeRaw`
    UPDATE PaymentOrder
    SET fulfillmentStatus = 'reversed', reviewReason = ${manualMarker},
        fulfillmentError = NULL
    WHERE id = ${id} AND fulfillmentStatus = 'review'
      AND reviewReason = ${order.reviewReason}
  `;
  await tx.$executeRaw`
    UPDATE PaymentReviewCase
    SET status = 'resolved', resolvedAt = NOW(3), updatedAt = NOW(3)
    WHERE orderId = ${id} AND status = 'open'
  `;
  await tx.$executeRaw`
    UPDATE PaymentAccountHold
    SET status = 'released', releasedAt = NOW(3), updatedAt = NOW(3)
    WHERE sourceOrderId = ${id} AND status = 'active'
      AND reason IN (
        'legacy_refund_unresolved', 'legacy_source_unresolved',
        'funding_provenance_invalid', 'chargeback_unrecovered',
        'stripe_namespace_unverified'
      )
  `;
  const after = {
    ...order,
    fulfillmentStatus: 'reversed',
    reviewReason: manualMarker,
  };
  await auditAction(
    tx,
    req,
    operator,
    action,
    id,
    order.userId,
    reason,
    order,
    after
  );
  return after;
}

function isProviderMode(value: string): value is PaymentProviderMode {
  return ['live', 'test', 'sandbox', 'unknown'].includes(value);
}

async function dismissWebhook(
  req: Request,
  operator: PaymentReviewOperator,
  eventId: string,
  reason: string
): Promise<Record<string, unknown>> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<MappingWebhookRow[]>`
      SELECT id, provider, providerMode, providerAccount, eventId, eventType,
             status, attempts, payloadSha256, payloadJson, updatedAt
      FROM PaymentWebhookEvent WHERE id = ${eventId} FOR UPDATE
    `;
    const event = rows[0];
    if (!event) {
      throw new PaymentReviewAdminError('Webhook 事件不存在', 'NOT_FOUND', 404);
    }
    if (!['review', 'failed'].includes(event.status)) {
      throw new PaymentReviewAdminError(
        'Webhook 不处于可忽略状态',
        'WEBHOOK_NOT_DISMISSIBLE',
        409
      );
    }
    const actualPayloadSha256 = crypto
      .createHash('sha256')
      .update(event.payloadJson, 'utf8')
      .digest('hex');
    if (actualPayloadSha256 !== event.payloadSha256) {
      throw new PaymentReviewAdminError(
        'Webhook 归一化载荷哈希不匹配',
        'WEBHOOK_PAYLOAD_TAMPERED',
        409
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    } catch {
      throw new PaymentReviewAdminError(
        'Webhook 归一化载荷损坏',
        'INVALID_WEBHOOK_PAYLOAD',
        409
      );
    }
    if (payload.paid === true || payload.reversal === true) {
      throw new PaymentReviewAdminError(
        '有资金影响的事件不能忽略，必须映射并重试',
        'VALUE_EVENT_CANNOT_BE_DISMISSED',
        409
      );
    }
    const cases = await tx.$queryRaw<
      Array<{ id: string; userId: string | null; orderId: string | null }>
    >`
      SELECT id, userId, orderId FROM PaymentReviewCase
      WHERE webhookEventId = ${event.id} AND status = 'open'
      ORDER BY id FOR UPDATE
    `;
    const ownerIds = [...new Set(cases.map((item) => item.userId).filter(Boolean))] as string[];
    // No User mutation occurs in dismiss. Do not lock User after Event/ReviewCase: mapping uses
    // PaymentOrder -> User -> Event and the inverse would create a deadlock cycle.
    await tx.$executeRaw`
      UPDATE PaymentWebhookEvent
      SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
      WHERE id = ${event.id} AND status IN ('review', 'failed')
    `;
    await tx.$executeRaw`
      UPDATE PaymentReviewCase
      SET status = 'dismissed', resolvedAt = NOW(3), updatedAt = NOW(3)
      WHERE webhookEventId = ${event.id} AND status = 'open'
    `;
    await writeSecurityAudit(
      req,
      {
        event: 'payment-review.dismiss-webhook',
        operator,
        target: {
          type: 'payment_webhook_event',
          id: event.id,
          ownerId: ownerIds.length === 1 ? ownerIds[0] : null,
        },
        before: { status: event.status, openReviewIds: cases.map((item) => item.id) },
        after: { status: 'processed', reviewStatus: 'dismissed' },
        reason,
        outcome: 'SUCCESS',
        metadata: { eventType: event.eventType },
      },
      tx
    );
    return { webhookEventId: event.id, status: 'processed', reviews: 'dismissed' };
  });
}

async function mapAndRetryWebhook(
  req: Request,
  operator: PaymentReviewOperator,
  eventId: string,
  selectedOrderId: string,
  discoveredUserId: string,
  reason: string
): Promise<Record<string, unknown>> {
  const mapped = await prisma.$transaction(async (tx) => {
    const orderRows = await tx.$queryRaw<MappingOrderRow[]>`
      SELECT id, userId, provider, providerMode, providerAccount, outTradeNo,
             providerRef, providerCheckoutSessionRef, amountCents, currency,
             status, refundedAt,
             fulfillmentStatus, reviewReason
      FROM PaymentOrder WHERE id = ${selectedOrderId} FOR UPDATE
    `;
    const order = orderRows[0];
    if (!order || order.userId !== discoveredUserId) {
      throw new PaymentReviewAdminError('订单不存在或归属已变化', 'NOT_FOUND', 404);
    }
    await lockUser(tx, order.userId);
    const eventRows = await tx.$queryRaw<MappingWebhookRow[]>`
      SELECT id, provider, providerMode, providerAccount, eventId, eventType,
             status, attempts, payloadSha256, payloadJson, updatedAt
      FROM PaymentWebhookEvent WHERE id = ${eventId} FOR UPDATE
    `;
    const event = eventRows[0];
    if (!event) {
      throw new PaymentReviewAdminError('Webhook 事件不存在', 'NOT_FOUND', 404);
    }
    const eventUpdatedAt = new Date(event.updatedAt);
    const staleProcessing =
      event.status === 'processing' &&
      Number.isFinite(eventUpdatedAt.getTime()) &&
      eventUpdatedAt.getTime() < Date.now() - STALE_WEBHOOK_PROCESSING_MS;
    const staleReceived =
      event.status === 'received' &&
      Number.isFinite(eventUpdatedAt.getTime()) &&
      eventUpdatedAt.getTime() < Date.now() - STALE_WEBHOOK_RECEIVED_MS;
    if (
      !['review', 'failed'].includes(event.status) &&
      !staleProcessing &&
      !staleReceived
    ) {
      throw new PaymentReviewAdminError(
        'Webhook 不处于可人工重试状态',
        'WEBHOOK_NOT_RETRYABLE',
        409
      );
    }
    if (!isPaymentProviderName(event.provider) || !isProviderMode(event.providerMode)) {
      throw new PaymentReviewAdminError(
        'Webhook 网关命名空间无效',
        'INVALID_PROVIDER_NAMESPACE',
        409
      );
    }
    if (event.provider !== order.provider) {
      throw new PaymentReviewAdminError(
        'Webhook 与订单支付渠道不一致',
        'PROVIDER_MISMATCH',
        409
      );
    }
    const actualPayloadSha256 = crypto
      .createHash('sha256')
      .update(event.payloadJson, 'utf8')
      .digest('hex');
    if (actualPayloadSha256 !== event.payloadSha256) {
      throw new PaymentReviewAdminError(
        'Webhook 归一化载荷哈希不匹配',
        'WEBHOOK_PAYLOAD_TAMPERED',
        409
      );
    }
    const payload = parseRetryPayload(event.payloadJson);
    if (payload.outTradeNo && payload.outTradeNo !== order.outTradeNo) {
      throw new PaymentReviewAdminError(
        'Webhook 签名订单号与所选订单不一致',
        'OUT_TRADE_NO_MISMATCH',
        409
      );
    }
    const providerAccount = event.providerAccount.trim() || 'default';
    if (event.provider === 'stripe' && providerAccount !== 'default') {
      throw new PaymentReviewAdminError(
        '当前部署未启用 Stripe Connect，拒绝非 default 账户映射',
        'STRIPE_CONNECT_UNSUPPORTED',
        409
      );
    }
    if (
      payload.kind === 'paid' &&
      event.provider !== 'sandbox' &&
      (!Number.isSafeInteger(payload.amountCents) ||
        (payload.amountCents ?? 0) < 0 ||
        !payload.currency ||
        !payload.occurredAt)
    ) {
      throw new PaymentReviewAdminError(
        'Paid 事件缺少金额、币种或发生时间，不能安全重放',
        'INCOMPLETE_PAID_EVIDENCE',
        409
      );
    }
    if (
      payload.kind === 'reversal' &&
      payload.currency &&
      payload.currency.toUpperCase() !== order.currency.trim().toUpperCase()
    ) {
      throw new PaymentReviewAdminError(
        '反向事件币种与所选订单不一致',
        'REVERSAL_CURRENCY_MISMATCH',
        409
      );
    }
    if (
      payload.kind === 'paid' &&
      (payload.amountCents !== Number(order.amountCents) ||
        payload.currency!.toUpperCase() !== order.currency.trim().toUpperCase())
    ) {
      throw new PaymentReviewAdminError(
        'Paid 事件金额或币种与所选订单不一致',
        'PAYMENT_AMOUNT_MISMATCH',
        409
      );
    }
    let orderMode = order.providerMode;
    let orderAccount = order.providerAccount;
    if (orderMode === 'unknown' && orderAccount === 'default') {
      await tx.$executeRaw`
        UPDATE PaymentOrder
        SET providerMode = ${event.providerMode}, providerAccount = ${providerAccount}
        WHERE id = ${order.id} AND providerMode = 'unknown' AND providerAccount = 'default'
      `;
      orderMode = event.providerMode;
      orderAccount = providerAccount;
    }
    if (orderMode !== event.providerMode || orderAccount !== providerAccount) {
      throw new PaymentReviewAdminError(
        'Webhook 与订单 live/test/account 命名空间不一致',
        'PROVIDER_NAMESPACE_MISMATCH',
        409
      );
    }
    await linkPaymentProviderObjects({
      provider: event.provider,
      providerMode: event.providerMode,
      providerAccount,
      orderId: order.id,
      eventId: event.eventId,
      objectRefs: payload.objectRefs,
      db: tx,
    });
    await tx.$executeRaw`
      UPDATE PaymentWebhookEvent
      SET outTradeNo = ${order.outTradeNo}, status = 'review',
          lastError = 'administrator mapped provider objects for retry', updatedAt = NOW(3)
      WHERE id = ${event.id}
        AND (
          status IN ('review', 'failed')
          OR (status = 'processing' AND updatedAt < ${new Date(Date.now() - STALE_WEBHOOK_PROCESSING_MS)})
          OR (status = 'received' AND updatedAt < ${new Date(Date.now() - STALE_WEBHOOK_RECEIVED_MS)})
        )
    `;
    await tx.$executeRaw`
      UPDATE PaymentReviewCase
      SET orderId = ${order.id}, userId = ${order.userId}, updatedAt = NOW(3)
      WHERE webhookEventId = ${event.id} AND status = 'open'
    `;
    await auditAction(
      tx,
      req,
      operator,
      'map_and_retry_webhook',
      event.id,
      order.userId,
      reason,
      {
        orderId: null,
        provider: event.provider,
        providerMode: event.providerMode,
        providerAccount,
        objectRefs: payload.objectRefs,
      },
      {
        orderId: order.id,
        outTradeNo: order.outTradeNo,
        legacyCheckoutSessionRef:
          order.providerCheckoutSessionRef ?? order.providerRef,
        objectRefs: payload.objectRefs,
      }
    );
    return {
      order: { ...order, providerMode: orderMode, providerAccount: orderAccount },
      event: {
        id: event.id,
        provider: event.provider,
        providerMode: event.providerMode,
        providerAccount,
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'review',
        attempts: Number(event.attempts),
        payloadSha256: event.payloadSha256,
      } satisfies PersistedWebhookEvent,
      payload,
    };
  });

  // The mapping has already committed with an in-transaction SUCCESS audit. Persist a separate
  // ATTEMPTED record before the reversal mutation so an audit outage can stop the retry and a
  // post-mutation outage can never erase who initiated it.
  await writeSecurityAudit(req, {
    event: 'payment-review.retry-webhook',
    operator,
    target: {
      type: 'payment_webhook_event',
      id: mapped.event.id,
      ownerId: mapped.order.userId,
    },
    reason,
    outcome: 'ATTEMPTED',
    metadata: { orderId: mapped.order.id, eventType: mapped.event.eventType },
  });

  if (!(await claimWebhookEvent(mapped.event))) {
    throw new PaymentReviewAdminError(
      'Webhook 正由其他 worker 处理，请稍后重试',
      'WEBHOOK_CLAIMED',
      409
    );
  }
  let handled = false;
  let fullyResolved = false;
  let retryOutcome: string;
  if (mapped.payload.kind === 'reversal') {
    const stripeLifecycleRef = mapped.payload.objectRefs.find(
      (ref) => ref.objectType === 'refund' || ref.objectType === 'dispute'
    );
    const reversal = await handlePaymentReversal({
      outTradeNo: mapped.order.outTradeNo,
      provider: mapped.event.provider,
      rawStatus: mapped.payload.rawStatus ?? mapped.event.eventType,
      providerRef: mapped.payload.providerRef,
      reversalAmountCents: mapped.payload.reversalAmountCents,
      fullReversal: mapped.payload.fullReversal,
      reversalState: mapped.payload.reversalState,
      providerMode: mapped.event.providerMode,
      providerAccount: mapped.event.providerAccount,
      sourceObjectType: stripeLifecycleRef?.objectType as
        | 'refund'
        | 'dispute'
        | undefined,
      sourceObjectId: stripeLifecycleRef?.objectId,
      occurredAt: mapped.payload.occurredAt,
      currency: mapped.payload.currency,
    });
    handled = reversal.handled;
    fullyResolved = reversal.handled;
    retryOutcome = reversal.outcome;
  } else {
    try {
      const credit = await creditPaidOrder(
        mapped.order.outTradeNo,
        mapped.payload.providerRef,
        mapped.event.provider,
        mapped.payload.amountCents,
        mapped.payload.currency,
        mapped.payload.occurredAt
      );
      handled = credit.ok || credit.acknowledged === true;
      fullyResolved = credit.ok;
      retryOutcome = credit.ok ? 'credited' : credit.status ?? 'payment_review';
    } catch (err) {
      await markWebhookEventFailed(mapped.event.id, err, 'review');
      await writeSecurityAudit(req, {
        event: 'payment-review.retry-webhook',
        operator,
        target: {
          type: 'payment_webhook_event',
          id: mapped.event.id,
          ownerId: mapped.order.userId,
        },
        reason,
        outcome: 'FAILED',
        metadata: {
          orderId: mapped.order.id,
          errorType: err instanceof Error ? err.name : 'unknown',
        },
      });
      throw new PaymentReviewAdminError(
        'Paid 事件重放失败，已保留人工复核',
        'WEBHOOK_RETRY_FAILED',
        503
      );
    }
  }
  if (!handled) {
    await markWebhookEventFailed(
      mapped.event.id,
      `manual retry outcome=${retryOutcome}`,
      'review'
    );
    await writeSecurityAudit(req, {
      event: 'payment-review.retry-webhook',
      operator,
      target: {
        type: 'payment_webhook_event',
        id: mapped.event.id,
        ownerId: mapped.order.userId,
      },
      reason,
      outcome: 'FAILED',
      metadata: { orderId: mapped.order.id, outcome: retryOutcome },
    });
    throw new PaymentReviewAdminError(
      '支付事件仍需人工复核，未成功重放',
      'WEBHOOK_RETRY_REVIEW',
      409
    );
  }
  await markWebhookEventProcessed(mapped.event.id);
  await prisma.$transaction(async (tx) => {
    const orders = await tx.$queryRaw<Array<{ id: string; userId: string }>>`
      SELECT id, userId FROM PaymentOrder WHERE id = ${mapped.order.id} FOR UPDATE
    `;
    if (!orders[0] || orders[0].userId !== mapped.order.userId) {
      throw new Error('mapped payment order disappeared after reversal');
    }
    await lockUser(tx, mapped.order.userId);
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentReviewCase
      WHERE webhookEventId = ${mapped.event.id} AND status = 'open'
      ORDER BY id FOR UPDATE
    `;
    if (fullyResolved) {
      await tx.$executeRaw`
        UPDATE PaymentReviewCase
        SET status = 'resolved', resolvedAt = NOW(3), updatedAt = NOW(3)
        WHERE webhookEventId = ${mapped.event.id} AND status = 'open'
      `;
    } else {
      await tx.$executeRaw`
        UPDATE PaymentReviewCase
        SET reason = ${retryOutcome.slice(0, 191)}, updatedAt = NOW(3)
        WHERE webhookEventId = ${mapped.event.id} AND status = 'open'
      `;
    }
    await writeSecurityAudit(
      req,
      {
        event: 'payment-review.retry-webhook',
        operator,
        target: {
          type: 'payment_webhook_event',
          id: mapped.event.id,
          ownerId: mapped.order.userId,
        },
        reason,
        outcome: fullyResolved ? 'SUCCESS' : 'PARTIAL',
        metadata: { orderId: mapped.order.id, outcome: retryOutcome },
      },
      tx
    );
  });
  return {
    webhookEventId: mapped.event.id,
    orderId: mapped.order.id,
    mappedObjectRefs: mapped.payload.objectRefs,
    outcome: retryOutcome,
  };
}

async function acknowledgePartialReversal(
  req: Request,
  operator: PaymentReviewOperator,
  eventId: string,
  expectedOrderId: string,
  discoveredUserId: string,
  reason: string
): Promise<Record<string, unknown>> {
  return prisma.$transaction(async (tx) => {
    // Match the callback/admin mapping order: PaymentOrder -> User -> Event -> Case/Hold.
    const orders = await tx.$queryRaw<MappingOrderRow[]>`
      SELECT id, userId, provider, providerMode, providerAccount, outTradeNo,
             providerRef, providerCheckoutSessionRef, amountCents, currency,
             status, refundedAt, fulfillmentStatus, reviewReason
      FROM PaymentOrder WHERE id = ${expectedOrderId} FOR UPDATE
    `;
    const order = orders[0];
    if (!order || order.userId !== discoveredUserId) {
      throw new PaymentReviewAdminError('部分退款关联订单不存在', 'NOT_FOUND', 404);
    }
    await lockUser(tx, order.userId);
    const events = await tx.$queryRaw<MappingWebhookRow[]>`
      SELECT id, provider, providerMode, providerAccount, eventId, eventType,
             status, attempts, payloadSha256, payloadJson, updatedAt
      FROM PaymentWebhookEvent WHERE id = ${eventId} FOR UPDATE
    `;
    const event = events[0];
    if (!event || !['review', 'failed'].includes(event.status)) {
      throw new PaymentReviewAdminError(
        '部分退款事件不处于人工复核状态',
        'PARTIAL_REVERSAL_NOT_REVIEWABLE',
        409
      );
    }
    const actualHash = crypto.createHash('sha256').update(event.payloadJson, 'utf8').digest('hex');
    if (actualHash !== event.payloadSha256) {
      throw new PaymentReviewAdminError(
        'Webhook 归一化载荷校验失败',
        'WEBHOOK_PAYLOAD_TAMPERED',
        409
      );
    }
    const payload = parseRetryPayload(event.payloadJson);
    if (payload.kind !== 'reversal') {
      throw new PaymentReviewAdminError(
        '只有反向事件可执行部分退款确认',
        'NOT_A_PARTIAL_REVERSAL',
        409
      );
    }
    if (payload.reversalState === 'pending') {
      throw new PaymentReviewAdminError(
        '待定退款/争议必须等待 Stripe 终态，不能人工标记为部分退款完成',
        'PENDING_REVERSAL_NOT_ACKNOWLEDGEABLE',
        409
      );
    }
    if (payload.outTradeNo && payload.outTradeNo !== order.outTradeNo) {
      throw new PaymentReviewAdminError(
        'Webhook 订单号与所选订单不一致',
        'OUT_TRADE_NO_MISMATCH',
        409
      );
    }
    if (
      payload.currency &&
      payload.currency.trim().toUpperCase() !== order.currency.trim().toUpperCase()
    ) {
      throw new PaymentReviewAdminError(
        '部分退款币种与订单不一致',
        'REVERSAL_CURRENCY_MISMATCH',
        409
      );
    }
    if (
      payload.reversalAmountCents !== undefined &&
      payload.reversalAmountCents > order.amountCents
    ) {
      throw new PaymentReviewAdminError(
        '部分退款金额超过订单金额',
        'REVERSAL_AMOUNT_INVALID',
        409
      );
    }
    const provablyFull =
      payload.fullReversal === true &&
      payload.reversalAmountCents === order.amountCents &&
      Boolean(payload.currency);
    if (provablyFull) {
      throw new PaymentReviewAdminError(
        '完整退款必须走映射重试并自动追缴权益',
        'USE_FULL_REVERSAL_RETRY',
        409
      );
    }
    const cases = await tx.$queryRaw<ReviewRow[]>`
      SELECT id, userId, orderId, webhookEventId, reason, status
      FROM PaymentReviewCase
      WHERE webhookEventId = ${eventId} AND status = 'open'
      ORDER BY id FOR UPDATE
    `;
    if (!cases.some((item) => item.orderId === order.id)) {
      throw new PaymentReviewAdminError(
        '部分退款复核项未绑定所选订单',
        'PARTIAL_REVERSAL_ORDER_MISMATCH',
        409
      );
    }
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentAccountHold
      WHERE sourceOrderId = ${order.id} AND status = 'active'
      ORDER BY id FOR UPDATE
    `;
    await tx.$executeRaw`
      UPDATE PaymentWebhookEvent
      SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
      WHERE id = ${eventId} AND status IN ('review', 'failed')
    `;
    await tx.$executeRaw`
      UPDATE PaymentReviewCase
      SET status = 'resolved', resolvedAt = NOW(3), updatedAt = NOW(3)
      WHERE webhookEventId = ${eventId} AND status = 'open'
    `;
    // Keep the account frozen until a separate, audited release_hold explicitly waives the
    // unsupported proportional clawback. Rename imported/runtime holds so finalization can
    // distinguish a deliberate terminal quarantine from an unreviewed import.
    await tx.$executeRaw`
      UPDATE PaymentAccountHold
      SET reason = 'partial_reversal_acknowledged', updatedAt = NOW(3)
      WHERE sourceOrderId = ${order.id} AND status = 'active'
        AND reason IN ('partial_reversal_unsupported', 'historical_stripe_reversal_import')
    `;
    await auditAction(
      tx,
      req,
      operator,
      'acknowledge_partial_reversal',
      eventId,
      order.userId,
      reason,
      { event, order, reviewIds: cases.map((item) => item.id) },
      {
        eventStatus: 'processed',
        reviewStatus: 'resolved',
        holdStatus: 'active',
        holdReason: 'partial_reversal_acknowledged',
      }
    );
    return {
      webhookEventId: eventId,
      orderId: order.id,
      status: 'processed',
      accountHold: 'active',
      disposition: 'partial_reversal_acknowledged',
    };
  });
}

async function quarantineStripeNamespace(
  req: Request,
  operator: PaymentReviewOperator,
  orderId: string,
  discoveredUserId: string,
  reason: string
): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRaw<NamespaceOrderRow[]>`
    SELECT id, userId, provider, providerMode, providerAccount, outTradeNo,
           providerRef, providerCheckoutSessionRef, providerChargeRef,
           amountCents, currency, status, refundedAt, fulfillmentStatus, reviewReason
    FROM PaymentOrder WHERE id = ${orderId} LIMIT 1
  `;
  const order = rows[0];
  if (!order || order.userId !== discoveredUserId || order.provider !== 'stripe') {
    throw new PaymentReviewAdminError('Stripe 隔离订单不存在', 'NOT_FOUND', 404);
  }
  if (
    order.providerMode === 'live' &&
    order.providerAccount === 'default' &&
    order.reviewReason !== 'stripe_namespace_unverified'
  ) {
    throw new PaymentReviewAdminError(
      '订单不处于 Stripe namespace 隔离状态',
      'NOT_NAMESPACE_QUARANTINED',
      409
    );
  }
  const reversal = await handlePaymentReversal({
    outTradeNo: order.outTradeNo,
    provider: 'stripe',
    rawStatus: 'admin.stripe_namespace_quarantine',
    providerRef: order.providerChargeRef ?? order.providerRef ?? undefined,
    reversalAmountCents: order.amountCents,
    fullReversal: true,
    currency: order.currency,
  });
  if (!['reversed', 'already'].includes(reversal.outcome)) {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<OrderRow[]>`
        SELECT id, userId, status, refundedAt, fulfillmentStatus, reviewReason
        FROM PaymentOrder WHERE id = ${order.id} FOR UPDATE
      `;
      if (!locked[0] || locked[0].userId !== order.userId) {
        throw new PaymentReviewAdminError('隔离订单归属已变化', 'NOT_FOUND', 404);
      }
      await lockUser(tx, order.userId);
      await auditAction(
        tx,
        req,
        operator,
        'quarantine_stripe_namespace',
        order.id,
        order.userId,
        reason,
        order,
        { ...locked[0], reversalOutcome: reversal.outcome, requiresManualRecovery: true }
      );
    });
    return {
      orderId: order.id,
      outcome: reversal.outcome,
      requiresDebtResolution: true,
    };
  }
  return prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<OrderRow[]>`
      SELECT id, userId, status, refundedAt, fulfillmentStatus, reviewReason
      FROM PaymentOrder WHERE id = ${order.id} FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (
      !locked ||
      locked.userId !== order.userId ||
      locked.status !== 'refunded' ||
      locked.fulfillmentStatus !== 'reversed'
    ) {
      throw new PaymentReviewAdminError(
        'Stripe 隔离订单尚未完整撤销权益',
        'NAMESPACE_REVERSAL_INCOMPLETE',
        409
      );
    }
    await lockUser(tx, order.userId);
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentReviewCase
      WHERE orderId = ${order.id} AND status = 'open'
      ORDER BY id FOR UPDATE
    `;
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentAccountHold
      WHERE sourceOrderId = ${order.id} AND status = 'active'
      ORDER BY id FOR UPDATE
    `;
    await tx.$executeRaw`
      UPDATE PaymentReviewCase
      SET status = 'resolved', resolvedAt = NOW(3), updatedAt = NOW(3)
      WHERE orderId = ${order.id} AND status = 'open'
        AND reason = 'stripe_namespace_unverified'
    `;
    await tx.$executeRaw`
      UPDATE PaymentAccountHold
      SET status = 'released', releasedAt = NOW(3), updatedAt = NOW(3)
      WHERE sourceOrderId = ${order.id} AND status = 'active'
        AND reason = 'stripe_namespace_unverified'
    `;
    await tx.$executeRaw`
      UPDATE PaymentOrder
      SET reviewReason = 'stripe_namespace_quarantine_terminal', fulfillmentError = NULL
      WHERE id = ${order.id} AND status = 'refunded' AND fulfillmentStatus = 'reversed'
    `;
    const after = {
      ...locked,
      reviewReason: 'stripe_namespace_quarantine_terminal',
      namespaceDisposition: 'terminal_quarantine',
    };
    await auditAction(
      tx,
      req,
      operator,
      'quarantine_stripe_namespace',
      order.id,
      order.userId,
      reason,
      order,
      after
    );
    return after;
  });
}

export async function applyPaymentReviewAction(
  req: Request,
  operator: PaymentReviewOperator,
  input: PaymentReviewActionInput
): Promise<Record<string, unknown>> {
  const id = boundedId(input.id);
  const reason = boundedReason(input.reason);
  if (input.action === 'dismiss_webhook') {
    return dismissWebhook(req, operator, id, reason);
  }
  const orderId =
    input.action === 'map_and_retry_webhook' ? boundedId(input.orderId ?? '') : undefined;
  const discovery = await discoverTarget(input.action, id, orderId);
  const userId = discovery.userId;
  if (input.action === 'map_and_retry_webhook') {
    return mapAndRetryWebhook(req, operator, id, orderId!, userId, reason);
  }
  if (input.action === 'acknowledge_partial_reversal') {
    return acknowledgePartialReversal(
      req,
      operator,
      id,
      boundedId(discovery.sourceOrderId ?? ''),
      userId,
      reason
    );
  }
  if (input.action === 'quarantine_stripe_namespace') {
    return quarantineStripeNamespace(req, operator, id, userId, reason);
  }
  return prisma.$transaction(async (tx) => {
    if (input.action === 'resolve_review') {
      return resolveReview(tx, req, operator, id, userId, reason);
    }
    if (input.action === 'resolve_debt' || input.action === 'waive_debt') {
      return settleDebt(tx, req, operator, input.action, id, userId, reason);
    }
    if (input.action === 'release_hold') {
      return releaseHold(
        tx,
        req,
        operator,
        id,
        userId,
        discovery.sourceOrderId,
        reason
      );
    }
    if (input.action === 'resolve_terminal_order_review') {
      return resolveTerminalOrderReview(tx, req, operator, id, userId, reason);
    }
    return resolveLegacyRefund(
      tx,
      req,
      operator,
      id,
      userId,
      reason,
      input.action === 'resolve_reversal_review'
        ? 'resolve_reversal_review'
        : 'resolve_legacy_refund'
    );
  });
}

export async function listPaymentReviewQueue(limit = 50): Promise<{
  reviews: unknown[];
  debts: unknown[];
  holds: unknown[];
  orders: unknown[];
  webhooks: unknown[];
}> {
  const take = Math.min(100, Math.max(1, Math.trunc(limit)));
  const [reviews, debts, holds, orders, webhooks] = await Promise.all([
    prisma.$queryRaw<unknown[]>`
      SELECT id, userId, orderId, webhookEventId, reason, detailJson,
             status, createdAt, updatedAt
      FROM PaymentReviewCase WHERE status = 'open'
      ORDER BY createdAt ASC, id ASC LIMIT ${take}
    `,
    prisma.$queryRaw<unknown[]>`
      SELECT id, userId, sourceOrderId, sourceLotId, amountCents, recoveredCents,
             reason, status, createdAt, updatedAt
      FROM PaymentDebt WHERE status = 'open'
      ORDER BY createdAt ASC, id ASC LIMIT ${take}
    `,
    prisma.$queryRaw<unknown[]>`
      SELECT id, userId, sourceOrderId, debtId, reason, status, createdAt, updatedAt
      FROM PaymentAccountHold WHERE status = 'active'
      ORDER BY createdAt ASC, id ASC LIMIT ${take}
    `,
    prisma.$queryRaw<unknown[]>`
      SELECT id, userId, provider, providerMode, providerAccount, outTradeNo, status,
             providerRef, providerCheckoutSessionRef, providerPaymentIntentRef,
             providerChargeRef, fulfillmentStatus, reviewReason, fulfillmentError, createdAt
      FROM PaymentOrder
      WHERE fulfillmentStatus = 'review' OR status = 'late_paid'
      ORDER BY createdAt ASC, id ASC LIMIT ${take}
    `,
    prisma.$queryRaw<unknown[]>`
      SELECT id, provider, providerMode, providerAccount, eventId, eventType,
             objectType, objectId, outTradeNo, status, attempts, lastError, receivedAt, updatedAt
      FROM PaymentWebhookEvent
      WHERE status IN ('review', 'failed')
         OR (status = 'processing' AND updatedAt < DATE_SUB(NOW(3), INTERVAL 5 MINUTE))
         OR (status = 'received' AND updatedAt < DATE_SUB(NOW(3), INTERVAL 1 MINUTE))
      ORDER BY receivedAt ASC, id ASC LIMIT ${take}
    `,
  ]);
  return { reviews, debts, holds, orders, webhooks };
}
