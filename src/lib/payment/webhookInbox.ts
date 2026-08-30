import 'server-only';

import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type {
  CallbackResult,
  PaymentObjectRef,
  PaymentProviderName,
  PaymentProviderMode,
} from '@/lib/payment/types';

const MAX_NORMALIZED_PAYLOAD_BYTES = 16 * 1024;
const MAX_REVIEW_DETAIL_BYTES = 8 * 1024;
const MAX_OBJECT_REFS = 16;
const STALE_PROCESSING_MS = 5 * 60_000;

type Db = Prisma.TransactionClient | typeof prisma;

export interface WebhookIdentity {
  provider: PaymentProviderName;
  providerMode: PaymentProviderMode;
  providerAccount: string;
  eventId: string;
  eventType: string;
}

export interface PersistedWebhookEvent extends WebhookIdentity {
  id: string;
  status: 'received' | 'processing' | 'processed' | 'review' | 'failed';
  attempts: number;
  payloadSha256: string;
}

interface WebhookRow {
  id: string;
  provider: PaymentProviderName;
  providerMode: PaymentProviderMode;
  providerAccount: string;
  eventId: string;
  eventType: string;
  status: PersistedWebhookEvent['status'];
  attempts: number | bigint;
  payloadSha256: string;
}

interface OrderReferenceRow {
  id: string;
  outTradeNo: string;
  userId: string;
  provider: string;
  providerMode: string;
  providerAccount: string;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedString(value: unknown, max: number, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (normalized || fallback).slice(0, max);
}

function normalizedObjectRefs(refs: PaymentObjectRef[] | undefined): PaymentObjectRef[] {
  const seen = new Set<string>();
  const out: PaymentObjectRef[] = [];
  for (const ref of refs ?? []) {
    const objectType = boundedString(ref.objectType, 64, 'unknown');
    const objectId = boundedString(ref.objectId, 191, '');
    if (!objectId) continue;
    const key = `${objectType}\0${objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ objectType, objectId });
    if (out.length >= MAX_OBJECT_REFS) break;
  }
  return out;
}

/**
 * Build a stable provider-scoped identity after signature verification. The fallback event id
 * is only a SHA-256 of the raw delivery source; raw request bodies and signature headers never
 * enter the database.
 */
export function normalizeVerifiedWebhook(
  provider: PaymentProviderName,
  result: CallbackResult,
  rawFingerprintSource: string
): { identity: WebhookIdentity; payloadJson: string; payloadSha256: string } {
  const refs = normalizedObjectRefs(result.objectRefs);
  const providerMode = result.providerMode ?? (provider === 'sandbox' ? 'sandbox' : 'unknown');
  const providerAccount = boundedString(result.providerAccount, 191, 'default');
  const eventType = boundedString(
    result.eventType ?? result.rawStatus,
    191,
    result.reversal ? 'reversal' : result.paid ? 'payment' : 'acknowledged'
  );
  const fallbackEventId = sha256(`${provider}\0${rawFingerprintSource}`);
  const eventId = boundedString(result.eventId, 191, fallbackEventId);
  const payload = {
    outTradeNo: boundedString(result.outTradeNo, 191, '') || undefined,
    paid: result.paid,
    amountCents:
      typeof result.amountCents === 'number' && Number.isFinite(result.amountCents)
        ? Math.round(result.amountCents)
        : undefined,
    currency: boundedString(result.currency, 8, '') || undefined,
    reversal: result.reversal === true || undefined,
    reversalAmountCents:
      typeof result.reversalAmountCents === 'number' &&
      Number.isSafeInteger(result.reversalAmountCents) &&
      result.reversalAmountCents >= 0
        ? result.reversalAmountCents
        : undefined,
    fullReversal:
      typeof result.fullReversal === 'boolean' ? result.fullReversal : undefined,
    reversalState:
      result.reversalState === 'pending' ||
      result.reversalState === 'withdrawn' ||
      result.reversalState === 'reinstated'
        ? result.reversalState
        : undefined,
    acknowledged: result.acknowledged === true || undefined,
    providerRef: boundedString(result.providerRef, 191, '') || undefined,
    rawStatus: boundedString(result.rawStatus, 191, '') || undefined,
    occurredAt:
      result.occurredAt instanceof Date && Number.isFinite(result.occurredAt.getTime())
        ? result.occurredAt.toISOString()
        : undefined,
    objectRefs: refs,
  };
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_NORMALIZED_PAYLOAD_BYTES) {
    throw new Error('normalized payment webhook payload exceeds 16KiB');
  }
  return {
    identity: { provider, providerMode, providerAccount, eventId, eventType },
    payloadJson,
    payloadSha256: sha256(payloadJson),
  };
}

/** Persist a verified delivery before any success ACK. Duplicate identities are immutable. */
export async function persistVerifiedWebhookEvent(input: {
  provider: PaymentProviderName;
  result: CallbackResult;
  rawFingerprintSource: string;
}): Promise<PersistedWebhookEvent> {
  const normalized = normalizeVerifiedWebhook(
    input.provider,
    input.result,
    input.rawFingerprintSource
  );
  const refs = normalizedObjectRefs(input.result.objectRefs);
  const primary = refs[0];
  const id = crypto.randomUUID();
  const outTradeNo = boundedString(input.result.outTradeNo, 191, '') || null;

  await prisma.$executeRaw`
    INSERT IGNORE INTO PaymentWebhookEvent (
      id, provider, providerMode, providerAccount, eventId, eventType,
      objectType, objectId, outTradeNo, payloadJson, payloadSha256,
      status, attempts, receivedAt, updatedAt
    ) VALUES (
      ${id}, ${normalized.identity.provider}, ${normalized.identity.providerMode},
      ${normalized.identity.providerAccount}, ${normalized.identity.eventId},
      ${normalized.identity.eventType}, ${primary?.objectType ?? null},
      ${primary?.objectId ?? null}, ${outTradeNo}, ${normalized.payloadJson},
      ${normalized.payloadSha256}, 'received', 0, NOW(3), NOW(3)
    )
  `;
  const rows = await prisma.$queryRaw<WebhookRow[]>`
    SELECT id, provider, providerMode, providerAccount, eventId, eventType,
           status, attempts, payloadSha256
    FROM PaymentWebhookEvent
    WHERE provider = ${normalized.identity.provider}
      AND providerMode = ${normalized.identity.providerMode}
      AND providerAccount = ${normalized.identity.providerAccount}
      AND eventId = ${normalized.identity.eventId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error('payment webhook inbox insert did not persist');
  if (row.payloadSha256 !== normalized.payloadSha256) {
    throw new Error('payment webhook identity collision with different payload');
  }
  return {
    id: row.id,
    provider: row.provider,
    providerMode: row.providerMode,
    providerAccount: row.providerAccount,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: Number(row.attempts),
    payloadSha256: row.payloadSha256,
  };
}

/** Exactly one worker may process a delivery; a crashed claim becomes reclaimable after 5 min. */
export async function claimWebhookEvent(event: PersistedWebhookEvent): Promise<boolean> {
  if (event.status === 'processed') return false;
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const changed = await prisma.$executeRaw`
    UPDATE PaymentWebhookEvent
    SET status = 'processing', attempts = attempts + 1, lastError = NULL, updatedAt = NOW(3)
    WHERE id = ${event.id}
      AND (
        status IN ('received', 'review', 'failed')
        OR (status = 'processing' AND updatedAt < ${staleBefore})
      )
  `;
  return Number(changed) === 1;
}

export async function markWebhookEventProcessed(eventId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE PaymentWebhookEvent
    SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
    WHERE id = ${eventId} AND status = 'processing'
  `;
}

export async function markWebhookEventFailed(
  eventId: string,
  error: unknown,
  status: 'review' | 'failed' = 'failed'
): Promise<void> {
  const message = boundedString(error instanceof Error ? error.message : String(error), 4096, 'unknown');
  await prisma.$executeRaw`
    UPDATE PaymentWebhookEvent
    SET status = ${status}, lastError = ${message}, updatedAt = NOW(3)
    WHERE id = ${eventId} AND status = 'processing'
  `;
}

/**
 * Close only the pending hold/cases for one Stripe Refund or Dispute after a signed terminal
 * update. Lock order is PaymentOrder -> User -> WebhookEvent -> ReviewCase -> AccountHold, matching
 * callback/admin reversal paths. A won dispute or failed/canceled refund processes the current
 * event; a succeeded refund/lost dispute leaves it processing for the normal clawback first.
 */
export async function settleStripePendingReversal(input: {
  orderId: string;
  userId: string;
  currentEventId: string;
  providerMode: PaymentProviderMode;
  providerAccount: string;
  objectType: 'refund' | 'dispute';
  objectId: string;
  terminalState: 'withdrawn' | 'reinstated';
}): Promise<void> {
  const holdReason = `stripe_pending_reversal:${boundedString(input.objectId, 150, '')}`;
  if (!input.objectId || holdReason.endsWith(':')) {
    throw new Error('Stripe terminal reversal update has no source object id');
  }
  await prisma.$transaction(async (tx) => {
    const orders = await tx.$queryRaw<Array<{ id: string; userId: string }>>`
      SELECT id, userId FROM PaymentOrder WHERE id = ${input.orderId} FOR UPDATE
    `;
    if (!orders[0] || orders[0].userId !== input.userId) {
      throw new Error('Stripe terminal reversal order changed');
    }
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM User WHERE id = ${input.userId} FOR UPDATE
    `;
    if (!users[0]) throw new Error('Stripe terminal reversal user is missing');

    const lockedEvents = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentWebhookEvent
      WHERE provider = 'stripe'
        AND providerMode = ${input.providerMode}
        AND providerAccount = ${input.providerAccount}
        AND objectType = ${input.objectType}
        AND objectId = ${input.objectId}
        AND (
          id = ${input.currentEventId}
          OR JSON_UNQUOTE(JSON_EXTRACT(payloadJson, '$.reversalState')) = 'pending'
        )
      ORDER BY id FOR UPDATE
    `;
    if (!lockedEvents.some((event) => event.id === input.currentEventId)) {
      throw new Error('Stripe terminal reversal inbox event changed');
    }
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT review.id FROM PaymentReviewCase review
      JOIN PaymentWebhookEvent event ON event.id = review.webhookEventId
      WHERE event.provider = 'stripe'
        AND event.providerMode = ${input.providerMode}
        AND event.providerAccount = ${input.providerAccount}
        AND event.objectType = ${input.objectType}
        AND event.objectId = ${input.objectId}
        AND JSON_UNQUOTE(JSON_EXTRACT(event.payloadJson, '$.reversalState')) = 'pending'
        AND review.status = 'open'
      ORDER BY review.id FOR UPDATE
    `;
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM PaymentAccountHold
      WHERE sourceOrderId = ${input.orderId} AND reason = ${holdReason}
      ORDER BY id FOR UPDATE
    `;
    await tx.$executeRaw`
      UPDATE PaymentReviewCase review
      JOIN PaymentWebhookEvent event ON event.id = review.webhookEventId
      SET review.status = 'resolved', review.resolvedAt = NOW(3), review.updatedAt = NOW(3)
      WHERE event.provider = 'stripe'
        AND event.providerMode = ${input.providerMode}
        AND event.providerAccount = ${input.providerAccount}
        AND event.objectType = ${input.objectType}
        AND event.objectId = ${input.objectId}
        AND JSON_UNQUOTE(JSON_EXTRACT(event.payloadJson, '$.reversalState')) = 'pending'
        AND review.status = 'open'
    `;
    await tx.$executeRaw`
      UPDATE PaymentWebhookEvent
      SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
      WHERE provider = 'stripe'
        AND providerMode = ${input.providerMode}
        AND providerAccount = ${input.providerAccount}
        AND objectType = ${input.objectType}
        AND objectId = ${input.objectId}
        AND JSON_UNQUOTE(JSON_EXTRACT(payloadJson, '$.reversalState')) = 'pending'
        AND status IN ('received', 'processing', 'review', 'failed')
    `;
    await tx.$executeRaw`
      UPDATE PaymentAccountHold
      SET status = 'released', releasedAt = NOW(3), updatedAt = NOW(3)
      WHERE sourceOrderId = ${input.orderId} AND reason = ${holdReason} AND status = 'active'
    `;
    if (input.terminalState === 'reinstated') {
      await tx.$executeRaw`
        UPDATE PaymentWebhookEvent
        SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
        WHERE id = ${input.currentEventId} AND status = 'processing'
      `;
    }
  });
}

/**
 * Insert immutable provider object mappings. A provider object already attached to another order
 * is a hard conflict; overwriting it would turn a refund/dispute into a cross-user reversal.
 */
export async function linkPaymentProviderObjects(input: {
  provider: PaymentProviderName;
  providerMode: PaymentProviderMode;
  providerAccount: string;
  orderId: string;
  eventId?: string;
  objectRefs?: PaymentObjectRef[];
  db?: Db;
}): Promise<void> {
  if (!input.db) {
    // All refs from one verified event are one correlation fact. If a later Charge/PI ref
    // conflicts, rolling back the earlier inserts prevents a permanently split mapping.
    return prisma.$transaction((tx) =>
      linkPaymentProviderObjects({ ...input, db: tx })
    );
  }
  const db = input.db ?? prisma;
  // Every caller uses PaymentOrder -> provider-object lock order. Sorting the unique object
  // keys also makes PI/Charge and Charge/PI deliveries acquire unique-index locks identically.
  const orderRows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM PaymentOrder WHERE id = ${input.orderId} FOR UPDATE
  `;
  if (!orderRows[0]) throw new Error('payment order does not exist for provider object mapping');
  const refs = normalizedObjectRefs(input.objectRefs).sort((left, right) =>
    `${left.objectType}\0${left.objectId}`.localeCompare(
      `${right.objectType}\0${right.objectId}`
    )
  );
  const providerAccount = boundedString(input.providerAccount, 191, 'default');
  for (const ref of refs) {
    const id = crypto.randomUUID();
    await db.$executeRaw`
      INSERT IGNORE INTO PaymentProviderObject (
        id, provider, providerMode, providerAccount, objectType, objectId,
        orderId, firstEventId, createdAt, lastSeenAt
      ) VALUES (
        ${id}, ${input.provider}, ${input.providerMode}, ${providerAccount},
        ${ref.objectType}, ${ref.objectId}, ${input.orderId}, ${input.eventId ?? null},
        NOW(3), NOW(3)
      )
    `;
    const mapped = await db.$queryRaw<Array<{ orderId: string }>>`
      SELECT orderId FROM PaymentProviderObject
      WHERE provider = ${input.provider}
        AND providerMode = ${input.providerMode}
        AND providerAccount = ${providerAccount}
        AND objectType = ${ref.objectType}
        AND objectId = ${ref.objectId}
      LIMIT 1
    `;
    if (!mapped[0] || mapped[0].orderId !== input.orderId) {
      throw new Error(`provider object ${ref.objectType}:${ref.objectId} maps to another order`);
    }
    await db.$executeRaw`
      UPDATE PaymentProviderObject SET lastSeenAt = NOW(3)
      WHERE provider = ${input.provider}
        AND providerMode = ${input.providerMode}
        AND providerAccount = ${providerAccount}
        AND objectType = ${ref.objectType}
        AND objectId = ${ref.objectId}
        AND orderId = ${input.orderId}
    `;

    if (input.provider === 'stripe') {
      if (ref.objectType === 'checkout_session') {
        await db.$executeRaw`
          UPDATE PaymentOrder
          SET providerCheckoutSessionRef = COALESCE(providerCheckoutSessionRef, ${ref.objectId})
          WHERE id = ${input.orderId}
        `;
      } else if (ref.objectType === 'payment_intent') {
        await db.$executeRaw`
          UPDATE PaymentOrder
          SET providerPaymentIntentRef = COALESCE(providerPaymentIntentRef, ${ref.objectId})
          WHERE id = ${input.orderId}
        `;
      } else if (ref.objectType === 'charge') {
        await db.$executeRaw`
          UPDATE PaymentOrder
          SET providerChargeRef = COALESCE(providerChargeRef, ${ref.objectId})
          WHERE id = ${input.orderId}
        `;
      }
    }
  }
}

/** Resolve by our signed metadata first, then by exact provider object namespace. */
export async function resolvePaymentOrderReference(input: {
  provider: PaymentProviderName;
  providerMode: PaymentProviderMode;
  providerAccount: string;
  outTradeNo?: string;
  objectRefs?: PaymentObjectRef[];
  db?: Db;
}): Promise<OrderReferenceRow | null> {
  const db = input.db ?? prisma;
  const providerAccount = boundedString(input.providerAccount, 191, 'default');
  const outTradeNo = boundedString(input.outTradeNo, 191, '');
  if (outTradeNo) {
    let direct = await db.$queryRaw<OrderReferenceRow[]>`
      SELECT id, outTradeNo, userId, provider, providerMode, providerAccount
      FROM PaymentOrder
      WHERE outTradeNo = ${outTradeNo}
        AND provider = ${input.provider}
        AND providerMode = ${input.providerMode}
        AND providerAccount = ${providerAccount}
      LIMIT 1
    `;
    if (direct[0]) return direct[0];

    // Compatibility for orders created before providerMode/providerAccount existed. A verified
    // callback's signed outTradeNo may bind that one globally-unique legacy order exactly once.
    // The conditional UPDATE is the arbitration point: concurrent events from another mode/account
    // cannot retarget an order after the first namespace wins. Unknown-mode callbacks never promote.
    // This deployment does not support Stripe Connect. An arbitrary signed `acct_*` event must
    // not be allowed to adopt a legacy default-account order, even when its outTradeNo happens
    // to match. Other providers derive `providerAccount` from the configured app/mch id; Stripe
    // legacy promotion is therefore deliberately limited to the configured platform account.
    const mayPromoteLegacy =
      input.providerMode !== 'unknown' &&
      (input.provider !== 'stripe' || providerAccount === 'default');
    if (mayPromoteLegacy) {
      await db.$executeRaw`
        UPDATE PaymentOrder
        SET providerMode = ${input.providerMode}, providerAccount = ${providerAccount}
        WHERE outTradeNo = ${outTradeNo}
          AND provider = ${input.provider}
          AND providerMode = 'unknown'
          AND providerAccount = 'default'
      `;
      direct = await db.$queryRaw<OrderReferenceRow[]>`
        SELECT id, outTradeNo, userId, provider, providerMode, providerAccount
        FROM PaymentOrder
        WHERE outTradeNo = ${outTradeNo}
          AND provider = ${input.provider}
          AND providerMode = ${input.providerMode}
          AND providerAccount = ${providerAccount}
        LIMIT 1
      `;
      if (direct[0]) return direct[0];
    }
  }

  const orderIds = new Set<string>();
  for (const ref of normalizedObjectRefs(input.objectRefs)) {
    const rows = await db.$queryRaw<Array<{ orderId: string }>>`
      SELECT orderId FROM PaymentProviderObject
      WHERE provider = ${input.provider}
        AND providerMode = ${input.providerMode}
        AND providerAccount = ${providerAccount}
        AND objectType = ${ref.objectType}
        AND objectId = ${ref.objectId}
      LIMIT 1
    `;
    if (rows[0]) orderIds.add(rows[0].orderId);
  }
  if (orderIds.size !== 1) return null;
  const [orderId] = orderIds;
  const rows = await db.$queryRaw<OrderReferenceRow[]>`
    SELECT id, outTradeNo, userId, provider, providerMode, providerAccount
    FROM PaymentOrder
    WHERE id = ${orderId}
      AND provider = ${input.provider}
      AND providerMode = ${input.providerMode}
      AND providerAccount = ${providerAccount}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function openPaymentReviewCase(input: {
  reason: string;
  event: PersistedWebhookEvent;
  orderId?: string;
  userId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const detailJson = input.detail ? JSON.stringify(input.detail) : null;
  if (detailJson && Buffer.byteLength(detailJson, 'utf8') > MAX_REVIEW_DETAIL_BYTES) {
    throw new Error('payment review detail exceeds 8KiB');
  }
  const reason = boundedString(input.reason, 191, 'payment_review');
  const dedupeKey = sha256(`${input.event.id}\0${reason}\0${input.orderId ?? ''}`);
  await prisma.$executeRaw`
    INSERT INTO PaymentReviewCase (
      id, dedupeKey, userId, orderId, webhookEventId, reason, detailJson,
      status, createdAt, updatedAt
    ) VALUES (
      ${crypto.randomUUID()}, ${dedupeKey}, ${input.userId ?? null}, ${input.orderId ?? null},
      ${input.event.id}, ${reason}, ${detailJson}, 'open', NOW(3), NOW(3)
    )
    ON DUPLICATE KEY UPDATE updatedAt = NOW(3)
  `;
}
