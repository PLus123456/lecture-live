import { createHash, randomUUID } from 'node:crypto';
import { detectStripeKeyMode } from './stripe-key-mode.mjs';

export const STRIPE_HISTORY_RECONCILIATION_MARKER =
  'payment_stripe_history_reconciliation_v1';
export const STRIPE_HISTORY_CONFIRMATION =
  'IMPORT_HISTORICAL_STRIPE_REVERSALS';
export const STRIPE_HISTORY_FINALIZE_CONFIRMATION =
  'FINALIZE_REVIEWED_STRIPE_HISTORY';

const API_BASE = 'https://api.stripe.com/v1';
const MAX_NORMALIZED_PAYLOAD_BYTES = 16 * 1024;
const MAX_DETAIL_BYTES = 8 * 1024;
const PAGE_SIZE = 100;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedString(value, max = 191) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function objectId(value) {
  if (typeof value === 'string') return boundedString(value);
  if (value && typeof value === 'object') return boundedString(value.id);
  return '';
}

function metadataOrderNumber(value) {
  if (!value || typeof value !== 'object') return '';
  return boundedString(value.out_trade_no ?? value.outTradeNo);
}

function addRef(refs, objectType, objectIdValue) {
  const type = boundedString(objectType, 64);
  const id = boundedString(objectIdValue);
  if (!type || !id) return;
  refs.set(`${type}\0${id}`, { objectType: type, objectId: id });
}

function normalizedRefs(refs) {
  return [...refs.values()]
    .sort((left, right) =>
      `${left.objectType}\0${left.objectId}`.localeCompare(
        `${right.objectType}\0${right.objectId}`
      )
    )
    .slice(0, 16);
}

function assertLiveObject(object, label) {
  if (object?.livemode === false) {
    throw new Error(`Stripe history scan refused non-live ${label}`);
  }
}

async function stripeGet(pathname, params, secretKey, fetchImpl) {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = new Error(`Stripe API ${pathname} returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(`Stripe API ${pathname} returned invalid JSON`);
  }
  return json;
}

async function listStripeCollection(
  pathname,
  { sinceEpoch, throughEpoch, maxItems, secretKey, fetchImpl }
) {
  const out = [];
  let startingAfter = '';
  for (;;) {
    const page = await stripeGet(
      pathname,
      {
        'created[gte]': sinceEpoch,
        'created[lte]': throughEpoch,
        limit: PAGE_SIZE,
        starting_after: startingAfter,
      },
      secretKey,
      fetchImpl
    );
    if (!page || !Array.isArray(page.data)) {
      throw new Error(`Stripe API ${pathname} returned an invalid list`);
    }
    if (out.length + page.data.length > maxItems) {
      throw new Error(
        `Stripe history scan limit ${maxItems} reached for ${pathname}; rerun with a larger --max-items`
      );
    }
    out.push(...page.data);
    if (page.has_more !== true) break;
    const next = boundedString(page.data.at(-1)?.id);
    if (!next || next === startingAfter) {
      throw new Error(`Stripe API ${pathname} pagination did not advance`);
    }
    startingAfter = next;
  }
  return out;
}

function firstOrderNumber(values) {
  const unique = [...new Set(values.map((value) => boundedString(value)).filter(Boolean))];
  return { value: unique.length === 1 ? unique[0] : '', conflict: unique.length > 1 };
}

async function enrichHistoricalObject(kind, source, context) {
  const { secretKey, fetchImpl, cache } = context;
  const sourceId = boundedString(source?.id);
  if (!sourceId) throw new Error(`Stripe ${kind} record has no id`);
  assertLiveObject(source, `${kind} ${sourceId}`);

  let charge = typeof source.charge === 'object' ? source.charge : null;
  const chargeId = objectId(source.charge);
  if (chargeId && !charge) {
    if (!cache.charges.has(chargeId)) {
      cache.charges.set(
        chargeId,
        stripeGet(`/charges/${encodeURIComponent(chargeId)}`, {}, secretKey, fetchImpl)
      );
    }
    charge = await cache.charges.get(chargeId);
  }
  if (chargeId && (!charge || boundedString(charge.id) !== chargeId)) {
    throw new Error(`Stripe ${kind} ${sourceId} charge lookup mismatch`);
  }
  if (charge) assertLiveObject(charge, `charge ${chargeId}`);

  const paymentIntentId =
    objectId(source.payment_intent) || objectId(charge?.payment_intent);
  let paymentIntent =
    typeof source.payment_intent === 'object'
      ? source.payment_intent
      : typeof charge?.payment_intent === 'object'
        ? charge.payment_intent
        : null;
  if (paymentIntentId && !paymentIntent) {
    if (!cache.paymentIntents.has(paymentIntentId)) {
      cache.paymentIntents.set(
        paymentIntentId,
        stripeGet(
          `/payment_intents/${encodeURIComponent(paymentIntentId)}`,
          {},
          secretKey,
          fetchImpl
        )
      );
    }
    paymentIntent = await cache.paymentIntents.get(paymentIntentId);
  }
  if (
    paymentIntentId &&
    (!paymentIntent || boundedString(paymentIntent.id) !== paymentIntentId)
  ) {
    throw new Error(`Stripe ${kind} ${sourceId} PaymentIntent lookup mismatch`);
  }
  if (paymentIntent) {
    assertLiveObject(paymentIntent, `PaymentIntent ${paymentIntentId}`);
  }

  let sessions = [];
  if (paymentIntentId) {
    if (!cache.checkoutSessions.has(paymentIntentId)) {
      cache.checkoutSessions.set(
        paymentIntentId,
        stripeGet(
          '/checkout/sessions',
          { payment_intent: paymentIntentId, limit: 3 },
          secretKey,
          fetchImpl
        )
      );
    }
    const sessionList = await cache.checkoutSessions.get(paymentIntentId);
    if (!sessionList || !Array.isArray(sessionList.data)) {
      throw new Error(`Stripe checkout session lookup for ${paymentIntentId} is invalid`);
    }
    sessions = sessionList.data.slice(0, 3);
    for (const session of sessions) assertLiveObject(session, `Checkout Session ${session.id}`);
  }

  const refs = new Map();
  addRef(refs, kind, sourceId);
  addRef(refs, 'charge', chargeId);
  addRef(refs, 'payment_intent', paymentIntentId);
  for (const session of sessions) addRef(refs, 'checkout_session', session?.id);

  const orderEvidence = firstOrderNumber([
    metadataOrderNumber(source.metadata),
    metadataOrderNumber(charge?.metadata),
    metadataOrderNumber(paymentIntent?.metadata),
    ...sessions.flatMap((session) => [
      session?.client_reference_id,
      metadataOrderNumber(session?.metadata),
    ]),
  ]);
  const status = boundedString(source.status, 64) || 'unknown';
  const sourceAmount = Number(source.amount);
  const chargeAmount = Number(charge?.amount);
  const cumulativeRefundAmount = Number(charge?.amount_refunded);
  const currency = boundedString(source.currency ?? charge?.currency, 8).toUpperCase();
  const succeededRefund =
    kind === 'refund' && status === 'succeeded' && Number.isSafeInteger(sourceAmount);
  // A Refund amount is immutable per resource. Never put Charge.amount_refunded in this
  // resource's payload: a later refund changes that cumulative field and would make the same
  // re_* event id collide with its previously persisted payload hash.
  const fullRefund =
    succeededRefund &&
    Number.isSafeInteger(chargeAmount) &&
    sourceAmount === chargeAmount;
  // The Dispute list exposes current state, not the historical funds_withdrawn/reinstated event
  // stream. Only a final lost dispute is safe to treat as still withdrawn; every other state is
  // retained for explicit human review and never auto-reversed.
  const lostDispute = kind === 'dispute' && status === 'lost';
  const reversalState =
    kind === 'refund'
      ? status === 'succeeded'
        ? 'withdrawn'
        : status === 'failed' || status === 'canceled'
          ? 'reinstated'
          : 'pending'
      : status === 'lost'
        ? 'withdrawn'
        : status === 'won' || status === 'warning_closed'
          ? 'reinstated'
          : 'pending';
  // Pending refunds/disputes are value-bearing uncertainty: freeze them until a later scan proves
  // succeeded/lost or failed/canceled/won. Treating pending as a harmless event would let an
  // operator finalize the cutover before Stripe's terminal update arrives.
  const reversal = reversalState !== 'reinstated';
  const reversalAmountCents =
    kind === 'refund'
      ? Number.isSafeInteger(sourceAmount)
        ? sourceAmount
        : undefined
      : Number.isSafeInteger(sourceAmount)
        ? sourceAmount
        : undefined;
  const fullReversal =
    kind === 'refund'
      ? reversalState === 'pending'
        ? false
        : fullRefund
      : reversalState === 'pending'
        ? false
        : lostDispute &&
        Number.isSafeInteger(chargeAmount) &&
        reversalAmountCents === chargeAmount;
  const eventType = kind === 'dispute' ? 'charge.dispute.updated' : 'refund.updated';
  const occurredAt = Number.isFinite(Number(source.created))
    ? new Date(Number(source.created) * 1000)
    : null;
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) {
    throw new Error(`Stripe ${kind} ${sourceId} has no valid created timestamp`);
  }
  const objectRefs = normalizedRefs(refs);
  const payload = {
    outTradeNo: orderEvidence.value || undefined,
    paid: false,
    reversal: reversal || undefined,
    reversalAmountCents,
    fullReversal: reversal ? fullReversal : undefined,
    reversalState,
    acknowledged: reversalState === 'reinstated' ? true : undefined,
    currency: currency || undefined,
    providerRef: sourceId,
    rawStatus: `historical.${kind}.${status}`,
    occurredAt: occurredAt.toISOString(),
    objectRefs,
  };
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_NORMALIZED_PAYLOAD_BYTES) {
    throw new Error(`Stripe ${kind} ${sourceId} normalized payload exceeds 16KiB`);
  }
  return {
    sourceKind: kind,
    sourceId,
    sourceStatus: status,
    // Refund/dispute status can legitimately transition. Namespace the durable event by the
    // observed status so a later terminal state is a new fact instead of a payload-hash collision.
    eventId: `history:${kind}:${sourceId}:${status}`,
    eventType,
    outTradeNo: orderEvidence.value || null,
    conflictingOrderEvidence: orderEvidence.conflict,
    objectRefs,
    payloadJson,
    payloadSha256: sha256(payloadJson),
    occurredAt: occurredAt.toISOString(),
    reversal,
    reversalState,
    reversalAmountCents: reversalAmountCents ?? null,
    fullReversal: reversal ? fullReversal : null,
    currency: currency || null,
    chargeId: chargeId || null,
    chargeAmountCents: Number.isSafeInteger(chargeAmount) ? chargeAmount : null,
    chargeCumulativeRefundAmountCents: Number.isSafeInteger(cumulativeRefundAmount)
      ? cumulativeRefundAmount
      : null,
  };
}

function buildSyntheticFullRefundRecord(refundRecords) {
  const chargeId = refundRecords[0]?.chargeId;
  const chargeAmount = refundRecords[0]?.chargeAmountCents;
  if (!chargeId || !Number.isSafeInteger(chargeAmount) || chargeAmount <= 0) return null;
  const succeeded = refundRecords.filter(
    (record) =>
      record.sourceStatus === 'succeeded' &&
      Number.isSafeInteger(record.reversalAmountCents) &&
      record.reversalAmountCents > 0
  );
  if (succeeded.some((record) => record.fullReversal === true)) return null;
  const uniqueRefunds = new Map(succeeded.map((record) => [record.sourceId, record]));
  const total = [...uniqueRefunds.values()].reduce(
    (sum, record) => sum + record.reversalAmountCents,
    0
  );
  if (!Number.isSafeInteger(total) || total !== chargeAmount) return null;
  const latest = [...uniqueRefunds.values()].sort((left, right) =>
    `${left.occurredAt}\0${left.eventId}`.localeCompare(
      `${right.occurredAt}\0${right.eventId}`
    )
  ).at(-1);
  if (!latest) return null;
  const refs = new Map();
  for (const record of uniqueRefunds.values()) {
    for (const ref of record.objectRefs) addRef(refs, ref.objectType, ref.objectId);
  }
  const orderEvidence = firstOrderNumber(
    [...uniqueRefunds.values()].map((record) => record.outTradeNo)
  );
  const currencies = [
    ...new Set(
      [...uniqueRefunds.values()].map((record) => record.currency).filter(Boolean)
    ),
  ];
  if (currencies.length !== 1) return null;
  const objectRefs = normalizedRefs(refs);
  const payload = {
    outTradeNo: orderEvidence.value || undefined,
    paid: false,
    reversal: true,
    reversalAmountCents: chargeAmount,
    fullReversal: true,
    reversalState: 'withdrawn',
    currency: currencies[0],
    providerRef: chargeId,
    rawStatus: 'historical.charge.refunded.full',
    occurredAt: latest.occurredAt,
    objectRefs,
  };
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_NORMALIZED_PAYLOAD_BYTES) {
    throw new Error(`Stripe charge ${chargeId} normalized payload exceeds 16KiB`);
  }
  return {
    sourceKind: 'charge_full_refund',
    sourceId: chargeId,
    sourceStatus: 'succeeded',
    eventId: `history:charge_full_refund:${chargeId}`,
    eventType: 'charge.refunded',
    outTradeNo: orderEvidence.value || null,
    conflictingOrderEvidence: orderEvidence.conflict,
    objectRefs,
    payloadJson,
    payloadSha256: sha256(payloadJson),
    occurredAt: latest.occurredAt,
    reversal: true,
    reversalState: 'withdrawn',
    reversalAmountCents: chargeAmount,
    fullReversal: true,
    currency: currencies[0],
    chargeId,
    chargeAmountCents: chargeAmount,
    chargeCumulativeRefundAmountCents: chargeAmount,
  };
}

export async function scanStripeHistoricalReversals({
  secretKey,
  since,
  through,
  maxItems = 5000,
  fetchImpl = fetch,
  now = new Date(),
}) {
  if (detectStripeKeyMode(secretKey) !== 'live') {
    throw new Error('Stripe historical reconciliation requires an sk_live_ or rk_live_ key');
  }
  const sinceDate = new Date(since);
  const throughDate = new Date(through);
  const scanStartedAt = new Date(now);
  if (
    !Number.isFinite(sinceDate.getTime()) ||
    !Number.isFinite(throughDate.getTime()) ||
    sinceDate >= throughDate ||
    !Number.isFinite(scanStartedAt.getTime()) ||
    throughDate.getTime() > scanStartedAt.getTime()
  ) {
    throw new Error(
      'Stripe historical reconciliation requires since < through <= scan start time'
    );
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 50_000) {
    throw new Error('Stripe historical reconciliation maxItems must be 1..50000');
  }
  const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);
  const throughEpoch = Math.floor(throughDate.getTime() / 1000);
  const options = { sinceEpoch, throughEpoch, maxItems, secretKey, fetchImpl };
  const account = await stripeGet('/account', {}, secretKey, fetchImpl);
  const accountId = boundedString(account?.id);
  if (!accountId.startsWith('acct_')) {
    throw new Error('Stripe historical reconciliation could not bind the live account id');
  }
  const refunds = await listStripeCollection('/refunds', options);
  const disputes = await listStripeCollection('/disputes', options);
  const cache = {
    charges: new Map(),
    paymentIntents: new Map(),
    checkoutSessions: new Map(),
  };
  const records = [];
  const refundRecordsByCharge = new Map();
  for (const refund of refunds) {
    const record = await enrichHistoricalObject('refund', refund, {
      secretKey,
      fetchImpl,
      cache,
    });
    records.push(record);
    if (record.chargeId) {
      const group = refundRecordsByCharge.get(record.chargeId) ?? [];
      group.push(record);
      refundRecordsByCharge.set(record.chargeId, group);
    }
  }
  for (const group of refundRecordsByCharge.values()) {
    const synthetic = buildSyntheticFullRefundRecord(group);
    if (synthetic) records.push(synthetic);
  }
  for (const dispute of disputes) {
    records.push(
      await enrichHistoricalObject('dispute', dispute, { secretKey, fetchImpl, cache })
    );
  }
  records.sort((left, right) =>
    `${left.occurredAt}\0${left.eventId}`.localeCompare(
      `${right.occurredAt}\0${right.eventId}`
    )
  );
  return {
    version: 1,
    mode: 'live',
    providerAccount: 'default',
    stripeAccountId: accountId,
    keyFingerprint: sha256(secretKey),
    scanStartedAt: scanStartedAt.toISOString(),
    since: sinceDate.toISOString(),
    through: throughDate.toISOString(),
    counts: { refunds: refunds.length, disputes: disputes.length },
    records,
  };
}

function currencyEquals(left, right) {
  return boundedString(left, 8).toUpperCase() === boundedString(right, 8).toUpperCase();
}

function amountEquals(value, expected) {
  return Number.isSafeInteger(Number(value)) && Number(value) === Number(expected);
}

async function verifyLegacyOrderObject(order, secretKey, fetchImpl) {
  const candidates = [
    ['checkout_session', order.providerCheckoutSessionRef ||
      (String(order.providerRef ?? '').startsWith('cs_') ? order.providerRef : '')],
    ['payment_intent', order.providerPaymentIntentRef],
    ['charge', order.providerChargeRef],
  ].filter(([, id]) => boundedString(id));
  let lastReason = candidates.length === 0 ? 'no_provider_object_reference' : 'not_found';
  const fetchObject = async (type, id) => {
    const path =
      type === 'checkout_session'
        ? `/checkout/sessions/${encodeURIComponent(id)}`
        : type === 'payment_intent'
          ? `/payment_intents/${encodeURIComponent(id)}`
          : `/charges/${encodeURIComponent(id)}`;
    return stripeGet(path, {}, secretKey, fetchImpl);
  };
  const verifyCharge = (charge) => {
    const id = boundedString(charge?.id);
    assertLiveObject(charge, `charge ${id || '(unknown)'}`);
    if (
      charge?.paid !== true ||
      charge?.captured !== true ||
      !amountEquals(charge?.amount, order.amountCents) ||
      !amountEquals(charge?.amount_captured, order.amountCents) ||
      !currencyEquals(charge?.currency, order.currency) ||
      charge?.refunded === true ||
      !Number.isSafeInteger(Number(charge?.amount_refunded)) ||
      Number(charge.amount_refunded) !== 0
    ) {
      return false;
    }
    return true;
  };
  const fetchAndVerifyPaymentIntent = async (paymentIntentValue) => {
    const paymentIntentId = objectId(paymentIntentValue);
    if (!paymentIntentId) return { valid: false, evidence: [] };
    const paymentIntent =
      typeof paymentIntentValue === 'object'
        ? paymentIntentValue
        : await fetchObject('payment_intent', paymentIntentId);
    assertLiveObject(paymentIntent, `PaymentIntent ${paymentIntentId}`);
    if (
      boundedString(paymentIntent?.id) !== paymentIntentId ||
      paymentIntent?.status !== 'succeeded' ||
      !amountEquals(
        paymentIntent?.amount_received ?? paymentIntent?.amount,
        order.amountCents
      ) ||
      !currencyEquals(paymentIntent?.currency, order.currency)
    ) {
      return { valid: false, evidence: [] };
    }
    const chargeValue =
      paymentIntent?.latest_charge ?? paymentIntent?.charges?.data?.[0] ?? null;
    const chargeId = objectId(chargeValue);
    if (!chargeId) return { valid: false, evidence: [] };
    const charge =
      typeof chargeValue === 'object'
        ? chargeValue
        : await fetchObject('charge', chargeId);
    if (boundedString(charge?.id) !== chargeId || !verifyCharge(charge)) {
      return { valid: false, evidence: [] };
    }
    return {
      valid: true,
      evidence: [
        metadataOrderNumber(paymentIntent?.metadata),
        metadataOrderNumber(charge?.metadata),
      ],
    };
  };

  for (const [type, idValue] of candidates) {
    const id = boundedString(idValue);
    let object;
    try {
      object = await fetchObject(type, id);
    } catch (error) {
      if (error?.status === 404) continue;
      throw error;
    }
    assertLiveObject(object, `${type} ${id}`);
    if (boundedString(object?.id) !== id) continue;
    let validFinancialState = false;
    const evidenceValues = [
      object?.client_reference_id,
      metadataOrderNumber(object?.metadata),
    ];
    if (type === 'checkout_session') {
      const intent = await fetchAndVerifyPaymentIntent(object?.payment_intent);
      validFinancialState =
        object?.payment_status === 'paid' &&
        amountEquals(object?.amount_total, order.amountCents) &&
        currencyEquals(object?.currency, order.currency) &&
        intent.valid;
      evidenceValues.push(...intent.evidence);
    } else if (type === 'payment_intent') {
      const intent = await fetchAndVerifyPaymentIntent(object);
      validFinancialState = intent.valid;
      evidenceValues.push(...intent.evidence);
    } else {
      validFinancialState = verifyCharge(object);
      const paymentIntentId = objectId(object?.payment_intent);
      if (paymentIntentId) {
        try {
          const paymentIntent = await fetchObject('payment_intent', paymentIntentId);
          assertLiveObject(paymentIntent, `PaymentIntent ${paymentIntentId}`);
          validFinancialState =
            validFinancialState &&
            boundedString(paymentIntent?.id) === paymentIntentId &&
            paymentIntent?.status === 'succeeded' &&
            amountEquals(
              paymentIntent?.amount_received ?? paymentIntent?.amount,
              order.amountCents
            ) &&
            currencyEquals(paymentIntent?.currency, order.currency);
          evidenceValues.push(metadataOrderNumber(paymentIntent?.metadata));
        } catch (error) {
          if (error?.status !== 404) throw error;
          validFinancialState = false;
        }
      }
    }
    if (!validFinancialState) {
      lastReason = `${type}_not_settled_or_amount_currency_refund_mismatch`;
      continue;
    }
    const evidence = firstOrderNumber(evidenceValues);
    if (!evidence.conflict && evidence.value === order.outTradeNo) {
      return { verified: true, objectType: type, objectId: id };
    }
    lastReason = evidence.conflict ? 'order_metadata_conflict' : 'order_metadata_mismatch';
  }
  return { verified: false, reason: lastReason };
}

export async function verifyLegacyStripeOrderNamespaces(
  prisma,
  { secretKey, fetchImpl = fetch, reason, dryRun = true }
) {
  const orders = await prisma.$queryRawUnsafe(
    `SELECT id, userId, outTradeNo, amountCents, currency,
            providerMode, providerAccount, providerRef,
            providerCheckoutSessionRef, providerPaymentIntentRef, providerChargeRef,
            status, fulfillmentStatus, reviewReason
     FROM PaymentOrder
     WHERE provider = 'stripe' AND status IN ('paid', 'late_paid', 'refunded')
       AND NOT (status = 'refunded' AND fulfillmentStatus = 'reversed')
       AND (providerMode <> 'live' OR providerAccount <> 'default')
     ORDER BY createdAt, id`
  );
  const results = [];
  for (const order of orders) {
    let verification = { verified: false };
    if (order.providerMode === 'unknown' && order.providerAccount === 'default') {
      verification = await verifyLegacyOrderObject(order, secretKey, fetchImpl);
    }
    const outcome = verification.verified ? 'verified_live' : 'quarantined';
    results.push({
      orderId: order.id,
      outTradeNo: order.outTradeNo,
      priorMode: order.providerMode,
      priorAccount: order.providerAccount,
      outcome,
      verifiedObject: verification.verified
        ? { objectType: verification.objectType, objectId: verification.objectId }
        : null,
      verificationFailure: verification.verified ? null : verification.reason ?? 'unverified',
    });
    if (dryRun) continue;
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        `SELECT id, userId, providerMode, providerAccount, status, fulfillmentStatus
         FROM PaymentOrder WHERE id = ? FOR UPDATE`,
        order.id
      );
      if (!locked[0] || locked[0].userId !== order.userId) {
        throw new Error(`Stripe namespace order changed during audit: ${order.id}`);
      }
      if (verification.verified) {
        await tx.$executeRawUnsafe(
          `UPDATE PaymentOrder SET providerMode = 'live', providerAccount = 'default'
           WHERE id = ? AND providerMode = 'unknown' AND providerAccount = 'default'`,
          order.id
        );
        return;
      }
      await tx.$queryRawUnsafe(`SELECT id FROM User WHERE id = ? FOR UPDATE`, order.userId);
      await tx.$executeRawUnsafe(
        `UPDATE PaymentOrder
         SET reviewReason = CASE
               WHEN fulfillmentStatus = 'fulfilled' THEN 'stripe_namespace_unverified'
               WHEN reviewReason IS NULL AND status = 'paid' THEN 'legacy_fulfillment_unresolved'
               ELSE reviewReason
             END,
             fulfillmentError = 'historical Stripe order could not be proven in configured live account'
         WHERE id = ? AND fulfillmentStatus <> 'reversed'`,
        order.id
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO PaymentReviewCase (
           id, dedupeKey, userId, orderId, webhookEventId, reason, detailJson,
           status, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, NULL, 'stripe_namespace_unverified', ?,
                   'open', NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE updatedAt = updatedAt`,
        randomUUID(),
        sha256(`stripe-namespace-unverified\0${order.id}`),
        order.userId,
        order.id,
        JSON.stringify({
          providerMode: order.providerMode,
          providerAccount: order.providerAccount,
          verificationFailure: verification.reason ?? 'unverified',
          operatorReason: boundedString(reason, 500),
        })
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO PaymentAccountHold (
           id, dedupeKey, userId, sourceOrderId, debtId, reason,
           status, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, NULL, 'stripe_namespace_unverified',
                   'active', NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE updatedAt = updatedAt`,
        randomUUID(),
        sha256(`stripe-namespace-unverified-hold\0${order.id}`),
        order.userId,
        order.id
      );
    });
  }
  return {
    total: results.length,
    verifiedLive: results.filter((item) => item.outcome === 'verified_live').length,
    quarantined: results.filter((item) => item.outcome === 'quarantined').length,
    results,
  };
}

function addCandidate(target, row) {
  if (row?.id && row?.userId && row?.outTradeNo) target.set(row.id, row);
}

async function findCandidateOrders(db, record) {
  const candidates = new Map();
  if (record.outTradeNo && !record.conflictingOrderEvidence) {
    const rows = await db.$queryRawUnsafe(
      `SELECT id, userId, outTradeNo, providerMode, providerAccount
       FROM PaymentOrder
       WHERE provider = 'stripe' AND outTradeNo = ?
         AND providerAccount = 'default' AND providerMode IN ('live', 'unknown')`,
      record.outTradeNo
    );
    for (const row of rows) addCandidate(candidates, row);
  }
  const typedColumn = {
    checkout_session: 'providerCheckoutSessionRef',
    payment_intent: 'providerPaymentIntentRef',
    charge: 'providerChargeRef',
  };
  for (const ref of record.objectRefs) {
    const mapped = await db.$queryRawUnsafe(
      `SELECT po.id, po.userId, po.outTradeNo, po.providerMode, po.providerAccount
       FROM PaymentProviderObject ppo
       JOIN PaymentOrder po ON po.id = ppo.orderId
       WHERE ppo.provider = 'stripe' AND ppo.providerMode = 'live'
         AND ppo.providerAccount = 'default'
         AND ppo.objectType = ? AND ppo.objectId = ?`,
      ref.objectType,
      ref.objectId
    );
    for (const row of mapped) addCandidate(candidates, row);
    const column = typedColumn[ref.objectType];
    if (column) {
      const typed = await db.$queryRawUnsafe(
        `SELECT id, userId, outTradeNo, providerMode, providerAccount
         FROM PaymentOrder
         WHERE provider = 'stripe' AND providerAccount = 'default'
           AND providerMode IN ('live', 'unknown') AND \`${column}\` = ?`,
        ref.objectId
      );
      for (const row of typed) addCandidate(candidates, row);
    }
    if (ref.objectType === 'checkout_session') {
      const legacy = await db.$queryRawUnsafe(
        `SELECT id, userId, outTradeNo, providerMode, providerAccount
         FROM PaymentOrder
         WHERE provider = 'stripe' AND providerAccount = 'default'
           AND providerMode IN ('live', 'unknown') AND providerRef = ?`,
        ref.objectId
      );
      for (const row of legacy) addCandidate(candidates, row);
    }
  }
  return [...candidates.values()];
}

async function persistInboxAndReview(tx, record, order, reason, mappingConflict = false) {
  const primary =
    record.objectRefs.find((ref) => ref.objectType === record.sourceKind) ??
    record.objectRefs[0];
  await tx.$executeRawUnsafe(
    `INSERT IGNORE INTO PaymentWebhookEvent (
       id, provider, providerMode, providerAccount, eventId, eventType,
       objectType, objectId, outTradeNo, payloadJson, payloadSha256,
       status, attempts, lastError, receivedAt, updatedAt
     ) VALUES (?, 'stripe', 'live', 'default', ?, ?, ?, ?, ?, ?, ?,
               'review', 0, ?, NOW(3), NOW(3))`,
    randomUUID(),
    record.eventId,
    record.eventType,
    primary?.objectType ?? null,
    primary?.objectId ?? null,
    order?.outTradeNo ?? record.outTradeNo,
    record.payloadJson,
    record.payloadSha256,
    'historical Stripe reversal imported for administrator review'
  );
  const inboxRows = await tx.$queryRawUnsafe(
    `SELECT id, payloadSha256, status FROM PaymentWebhookEvent
     WHERE provider = 'stripe' AND providerMode = 'live'
       AND providerAccount = 'default' AND eventId = ? FOR UPDATE`,
    record.eventId
  );
  const inbox = inboxRows[0];
  if (!inbox || inbox.payloadSha256 !== record.payloadSha256) {
    throw new Error(`historical Stripe inbox identity collision for ${record.eventId}`);
  }
  // A re-run of the same completed coverage window is evidence verification, not a new event.
  // Never reopen its case or reactivate a reason-bound hold after an administrator disposition.
  if (inbox.status === 'processed') return inbox.id;
  if (record.reversalState === 'pending' && order) {
    const terminalRows = await tx.$queryRawUnsafe(
      `SELECT payloadJson FROM PaymentWebhookEvent
       WHERE provider = 'stripe' AND providerMode = 'live' AND providerAccount = 'default'
         AND objectType = ? AND objectId = ?
         AND JSON_UNQUOTE(JSON_EXTRACT(payloadJson, '$.reversalState'))
               IN ('withdrawn', 'reinstated')
       ORDER BY id FOR UPDATE`,
      record.sourceKind,
      record.sourceId
    );
    const pendingAt = new Date(record.occurredAt).getTime();
    const superseded = terminalRows.some((row) => {
      try {
        const payload = JSON.parse(row.payloadJson);
        const terminalAt = new Date(payload.occurredAt).getTime();
        return Number.isFinite(terminalAt) && terminalAt >= pendingAt;
      } catch {
        return false;
      }
    });
    if (superseded) {
      await tx.$executeRawUnsafe(
        `UPDATE PaymentWebhookEvent
         SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
         WHERE id = ? AND status = 'review'`,
        inbox.id
      );
      return inbox.id;
    }
  }
  const reviewReason = mappingConflict
    ? 'historical_stripe_mapping_conflict'
    : record.reversalState === 'pending'
      ? 'historical_stripe_pending_reversal'
    : order
      ? 'historical_stripe_reversal_import'
      : 'historical_stripe_reversal_unresolved';
  const detailJson = JSON.stringify({
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    sourceStatus: record.sourceStatus,
    reversal: record.reversal,
    reversalAmountCents: record.reversalAmountCents,
    fullReversal: record.fullReversal,
    reversalState: record.reversalState,
    currency: record.currency,
    mappingConflict,
    operatorReason: boundedString(reason, 500),
  });
  if (Buffer.byteLength(detailJson, 'utf8') > MAX_DETAIL_BYTES) {
    throw new Error('historical Stripe review detail exceeds 8KiB');
  }
  await tx.$executeRawUnsafe(
    `INSERT INTO PaymentReviewCase (
       id, dedupeKey, userId, orderId, webhookEventId, reason, detailJson,
       status, createdAt, updatedAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE updatedAt = NOW(3)`,
    randomUUID(),
    sha256(`stripe-history-review\0${record.eventId}`),
    order?.userId ?? null,
    order?.id ?? null,
    inbox.id,
    reviewReason,
    detailJson
  );
  if (order && record.reversal) {
    const holdReason =
      record.reversalState === 'pending'
        ? `stripe_pending_reversal:${record.sourceId}`
        : 'historical_stripe_reversal_import';
    await tx.$executeRawUnsafe(
      `INSERT INTO PaymentAccountHold (
         id, dedupeKey, userId, sourceOrderId, debtId, reason,
         status, createdAt, updatedAt
       ) VALUES (?, ?, ?, ?, NULL, ?,
                 'active', NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE updatedAt = updatedAt`,
      randomUUID(),
      sha256(`historical-stripe-hold\0${record.eventId}\0${order.id}`),
      order.userId,
      order.id,
      holdReason
    );
  }
  return inbox.id;
}

async function settleHistoricalPendingReversal(tx, record, order, currentInboxId) {
  if (
    !['refund', 'dispute'].includes(record.sourceKind) ||
    !['withdrawn', 'reinstated'].includes(record.reversalState)
  ) {
    return;
  }
  await tx.$queryRawUnsafe(`SELECT id FROM User WHERE id = ? FOR UPDATE`, order.userId);
  await tx.$queryRawUnsafe(
    `SELECT id FROM PaymentWebhookEvent
     WHERE provider = 'stripe' AND providerMode = 'live' AND providerAccount = 'default'
       AND objectType = ? AND objectId = ?
       AND (id = ? OR JSON_UNQUOTE(JSON_EXTRACT(payloadJson, '$.reversalState')) = 'pending')
     ORDER BY id FOR UPDATE`,
    record.sourceKind,
    record.sourceId,
    currentInboxId
  );
  await tx.$queryRawUnsafe(
    `SELECT review.id FROM PaymentReviewCase review
     JOIN PaymentWebhookEvent event ON event.id = review.webhookEventId
     WHERE event.provider = 'stripe' AND event.providerMode = 'live'
       AND event.providerAccount = 'default' AND event.objectType = ? AND event.objectId = ?
       AND (event.id = ? OR JSON_UNQUOTE(JSON_EXTRACT(event.payloadJson, '$.reversalState')) = 'pending')
       AND review.status = 'open'
     ORDER BY review.id FOR UPDATE`,
    record.sourceKind,
    record.sourceId,
    currentInboxId
  );
  const holdReason = `stripe_pending_reversal:${record.sourceId}`;
  await tx.$queryRawUnsafe(
    `SELECT id FROM PaymentAccountHold
     WHERE sourceOrderId = ? AND reason = ? ORDER BY id FOR UPDATE`,
    order.id,
    holdReason
  );
  await tx.$executeRawUnsafe(
    `UPDATE PaymentReviewCase review
     JOIN PaymentWebhookEvent event ON event.id = review.webhookEventId
     SET review.status = 'resolved', review.resolvedAt = NOW(3), review.updatedAt = NOW(3)
     WHERE event.provider = 'stripe' AND event.providerMode = 'live'
       AND event.providerAccount = 'default' AND event.objectType = ? AND event.objectId = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(event.payloadJson, '$.reversalState')) = 'pending'
       AND review.status = 'open'`,
    record.sourceKind,
    record.sourceId
  );
  await tx.$executeRawUnsafe(
    `UPDATE PaymentWebhookEvent
     SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
     WHERE provider = 'stripe' AND providerMode = 'live' AND providerAccount = 'default'
       AND objectType = ? AND objectId = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(payloadJson, '$.reversalState')) = 'pending'
       AND status IN ('received', 'processing', 'review', 'failed')`,
    record.sourceKind,
    record.sourceId
  );
  await tx.$executeRawUnsafe(
    `UPDATE PaymentAccountHold
     SET status = 'released', releasedAt = NOW(3), updatedAt = NOW(3)
     WHERE sourceOrderId = ? AND reason = ? AND status = 'active'`,
    order.id,
    holdReason
  );
  if (record.reversalState === 'reinstated') {
    await tx.$executeRawUnsafe(
      `UPDATE PaymentReviewCase
       SET status = 'resolved', resolvedAt = NOW(3), updatedAt = NOW(3)
       WHERE webhookEventId = ? AND status = 'open'`,
      currentInboxId
    );
    await tx.$executeRawUnsafe(
      `UPDATE PaymentWebhookEvent
       SET status = 'processed', processedAt = NOW(3), lastError = NULL, updatedAt = NOW(3)
       WHERE id = ? AND status IN ('review', 'failed')`,
      currentInboxId
    );
  }
}

async function persistMappedRecord(tx, record, order, reason) {
  const locked = await tx.$queryRawUnsafe(
    `SELECT id, userId, outTradeNo FROM PaymentOrder
     WHERE id = ? AND provider = 'stripe' FOR UPDATE`,
    order.id
  );
  if (!locked[0] || locked[0].userId !== order.userId) {
    throw new Error(`historical Stripe candidate order changed for ${record.eventId}`);
  }
  const refs = [...record.objectRefs].sort((left, right) =>
    `${left.objectType}\0${left.objectId}`.localeCompare(
      `${right.objectType}\0${right.objectId}`
    )
  );
  // Detect known conflicts before the first insert. A conflict discovered during INSERT still
  // aborts the outer marker transaction, so no prefix of a multi-ref mapping can commit.
  for (const ref of refs) {
    const mapped = await tx.$queryRawUnsafe(
      `SELECT orderId FROM PaymentProviderObject
       WHERE provider = 'stripe' AND providerMode = 'live'
         AND providerAccount = 'default' AND objectType = ? AND objectId = ?
       FOR UPDATE`,
      ref.objectType,
      ref.objectId
    );
    if (mapped[0] && mapped[0].orderId !== order.id) {
      return persistUnmappedRecord(tx, record, reason, true);
    }
  }
  await tx.$executeRawUnsafe(
    `UPDATE PaymentOrder SET providerMode = 'live'
     WHERE id = ? AND providerMode = 'unknown' AND providerAccount = 'default'`,
    order.id
  );
  for (const ref of refs) {
      await tx.$executeRawUnsafe(
        `INSERT IGNORE INTO PaymentProviderObject (
           id, provider, providerMode, providerAccount, objectType, objectId,
           orderId, firstEventId, createdAt, lastSeenAt
         ) VALUES (?, 'stripe', 'live', 'default', ?, ?, ?, ?, NOW(3), NOW(3))`,
        randomUUID(),
        ref.objectType,
        ref.objectId,
        order.id,
        record.eventId
      );
      const mapped = await tx.$queryRawUnsafe(
        `SELECT orderId FROM PaymentProviderObject
         WHERE provider = 'stripe' AND providerMode = 'live'
           AND providerAccount = 'default' AND objectType = ? AND objectId = ?
         FOR UPDATE`,
        ref.objectType,
        ref.objectId
      );
      if (!mapped[0] || mapped[0].orderId !== order.id) {
        throw new Error(`historical Stripe object maps to another order`);
      }
      const column = {
        checkout_session: 'providerCheckoutSessionRef',
        payment_intent: 'providerPaymentIntentRef',
        charge: 'providerChargeRef',
      }[ref.objectType];
      if (column) {
        await tx.$executeRawUnsafe(
          `UPDATE PaymentOrder SET \`${column}\` = COALESCE(\`${column}\`, ?)
           WHERE id = ?`,
          ref.objectId,
          order.id
        );
      }
    }
  const inboxId = await persistInboxAndReview(tx, record, order, reason);
  await settleHistoricalPendingReversal(tx, record, order, inboxId);
  return {
    eventId: record.eventId,
    orderId: order.id,
    status: record.reversalState === 'reinstated' ? 'processed' : 'review',
  };
}

async function persistUnmappedRecord(tx, record, reason, mappingConflict) {
  await persistInboxAndReview(tx, record, null, reason, mappingConflict);
  return {
    eventId: record.eventId,
    orderId: null,
    status: mappingConflict ? 'mapping_conflict' : 'unresolved',
  };
}

async function ensureHistoryMarkerRow(prisma) {
  await prisma.$executeRawUnsafe(
    `INSERT IGNORE INTO SiteSetting (\`key\`, value, updatedAt)
     VALUES (?, ?, NOW(3))`,
    STRIPE_HISTORY_RECONCILIATION_MARKER,
    JSON.stringify({ version: 1, status: 'initializing' })
  );
}

export async function applyStripeHistoricalReconciliation(
  prisma,
  scan,
  { reason }
) {
  const normalizedReason = boundedString(reason, 500);
  if (normalizedReason.length < 3) {
    throw new Error('Stripe historical reconciliation apply requires a reason');
  }
  await ensureHistoryMarkerRow(prisma);
  return prisma.$transaction(async (tx) => {
    const existingMarkerRows = await tx.$queryRawUnsafe(
      `SELECT value FROM SiteSetting WHERE \`key\` = ? FOR UPDATE`,
      STRIPE_HISTORY_RECONCILIATION_MARKER
    );
    let existing = null;
    try {
      existing = JSON.parse(existingMarkerRows[0]?.value ?? '');
    } catch {
      existing = null;
    }
    if (
      typeof existing?.stripeAccountId === 'string' &&
      existing.stripeAccountId &&
      existing.stripeAccountId !== scan.stripeAccountId
    ) {
      throw new Error(
        `Stripe account rotation blocked: existing history belongs to ${existing.stripeAccountId}, scan belongs to ${scan.stripeAccountId}`
      );
    }
    if (
      existing?.version === 1 &&
      existing?.status === 'complete' &&
      existing?.keyFingerprint === scan.keyFingerprint &&
      new Date(existing.since).getTime() <= new Date(scan.since).getTime() &&
      new Date(existing.through).getTime() >= new Date(scan.through).getTime()
    ) {
      return { summary: existing, results: [], alreadyComplete: true };
    }
    const results = [];
    for (const record of scan.records) {
      const candidates = record.conflictingOrderEvidence
        ? []
        : await findCandidateOrders(tx, record);
      if (candidates.length !== 1) {
        results.push(
          await persistUnmappedRecord(
            tx,
            record,
            normalizedReason,
            candidates.length > 1 || record.conflictingOrderEvidence
          )
        );
        continue;
      }
      results.push(
        await persistMappedRecord(tx, record, candidates[0], normalizedReason)
      );
    }
    const pendingValueReviews = scan.records.filter(
      (record) => record.reversal && record.fullReversal !== true
    ).length;
    const summary = {
      version: 1,
      // Even an empty scan must be finalized separately. That final transaction proves a fresh
      // cutover and prevents an empty import from masquerading as durable review completion.
      status: 'scan_complete_pending_review',
      mode: 'live',
      providerAccount: 'default',
      stripeAccountId: scan.stripeAccountId,
      keyFingerprint: scan.keyFingerprint,
      scanStartedAt: scan.scanStartedAt,
      since: scan.since,
      through: scan.through,
      completedAt: new Date().toISOString(),
      counts: {
        ...scan.counts,
        mapped: results.filter((item) => item.orderId).length,
        unresolved: results.filter((item) => !item.orderId).length,
        pendingValueReviews,
        namespaceQuarantined: scan.namespaceAudit?.quarantined ?? 0,
      },
      reason: normalizedReason,
    };
    await tx.$executeRawUnsafe(
      `UPDATE SiteSetting SET value = ?, updatedAt = NOW(3) WHERE \`key\` = ?`,
      JSON.stringify(summary),
      STRIPE_HISTORY_RECONCILIATION_MARKER
    );
    return { summary, results };
  });
}

export async function finalizeStripeHistoricalReconciliation(
  prisma,
  { secretKey, reason }
) {
  const normalizedReason = boundedString(reason, 500);
  if (normalizedReason.length < 3) {
    throw new Error('Stripe historical reconciliation finalize requires a reason');
  }
  if (detectStripeKeyMode(secretKey) !== 'live') {
    throw new Error('Stripe history finalize requires an sk_live_ or rk_live_ key');
  }
  await ensureHistoryMarkerRow(prisma);
  return prisma.$transaction(async (tx) => {
    const markerRows = await tx.$queryRawUnsafe(
      `SELECT value FROM SiteSetting WHERE \`key\` = ? FOR UPDATE`,
      STRIPE_HISTORY_RECONCILIATION_MARKER
    );
    let marker;
    try {
      marker = JSON.parse(markerRows[0]?.value ?? '');
    } catch {
      throw new Error('Stripe history import marker is missing or invalid');
    }
    if (
      marker?.version !== 1 ||
      marker?.status !== 'scan_complete_pending_review' ||
      marker?.keyFingerprint !== sha256(secretKey)
    ) {
      throw new Error('Stripe history import marker does not match this live key/pending scan');
    }
    const through = new Date(marker.through).getTime();
    const scanStartedAt = new Date(marker.scanStartedAt).getTime();
    const now = Date.now();
    if (
      !Number.isFinite(through) ||
      !Number.isFinite(scanStartedAt) ||
      through > scanStartedAt ||
      through > now ||
      now - through > 5 * 60_000
    ) {
      throw new Error(
        'Stripe history finalize requires a fresh catch-up scan through the current maintenance cutoff'
      );
    }
    const unresolvedRows = await tx.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*) FROM PaymentWebhookEvent
        WHERE provider = 'stripe' AND providerMode = 'live'
          AND providerAccount = 'default' AND eventId LIKE 'history:%'
          AND status <> 'processed') AS inboxCount,
       (SELECT COUNT(*) FROM PaymentReviewCase review
        JOIN PaymentWebhookEvent event ON event.id = review.webhookEventId
        WHERE event.provider = 'stripe' AND event.providerMode = 'live'
          AND event.providerAccount = 'default' AND event.eventId LIKE 'history:%'
          AND review.status = 'open') AS reviewCount,
       (SELECT COUNT(*) FROM PaymentAccountHold
        WHERE (reason = 'historical_stripe_reversal_import'
               OR reason LIKE 'stripe_pending_reversal:%')
          AND status = 'active') AS holdCount`
  );
    const unresolved = {
      inbox: Number(unresolvedRows[0]?.inboxCount ?? 0),
      reviews: Number(unresolvedRows[0]?.reviewCount ?? 0),
      holds: Number(unresolvedRows[0]?.holdCount ?? 0),
    };
    if (Object.values(unresolved).some((count) => count !== 0)) {
      throw new Error(
        `Stripe history cannot finalize: inbox=${unresolved.inbox}, reviews=${unresolved.reviews}, holds=${unresolved.holds}`
      );
    }
    const completedAt = new Date();
    const completed = {
      ...marker,
      status: 'complete',
      finalizedAt: completedAt.toISOString(),
      durableCutoverAt: completedAt.toISOString(),
      finalizeReason: normalizedReason,
    };
    const changed = await tx.$executeRawUnsafe(
      `UPDATE SiteSetting SET value = ?, updatedAt = NOW(3)
       WHERE \`key\` = ? AND value = ?`,
      JSON.stringify(completed),
      STRIPE_HISTORY_RECONCILIATION_MARKER,
      markerRows[0].value
    );
    if (Number(changed) !== 1) {
      throw new Error('Stripe history finalize marker changed concurrently');
    }
    return completed;
  });
}

export function summarizeStripeHistoricalScan(scan) {
  return {
    version: scan.version,
    mode: scan.mode,
    providerAccount: scan.providerAccount,
    stripeAccountId: scan.stripeAccountId,
    scanStartedAt: scan.scanStartedAt,
    since: scan.since,
    through: scan.through,
    counts: scan.counts,
    records: scan.records.map((record) => ({
      eventId: record.eventId,
      sourceStatus: record.sourceStatus,
      occurredAt: record.occurredAt,
      outTradeNo: record.outTradeNo,
      conflictingOrderEvidence: record.conflictingOrderEvidence,
      reversal: record.reversal,
      reversalAmountCents: record.reversalAmountCents,
      fullReversal: record.fullReversal,
      currency: record.currency,
      objectRefs: record.objectRefs,
    })),
  };
}
