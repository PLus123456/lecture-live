import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  applyStripeHistoricalReconciliation,
  finalizeStripeHistoricalReconciliation,
  scanStripeHistoricalReversals,
  verifyLegacyStripeOrderNamespaces,
} from '../../scripts/stripe-history-reconciliation-core.mjs';

const LIVE_KEY = 'sk_live_history_test';
const NOW = new Date('2026-08-20T12:00:00.000Z');
const SINCE = '2026-08-01T00:00:00.000Z';
const THROUGH = '2026-08-20T11:59:59.000Z';

function okJson(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorJson(status = 404) {
  return new Response('{}', {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refund(
  id: string,
  amount: number,
  chargeAmount: number,
  amountRefunded: number,
  created: number
) {
  return {
    id,
    object: 'refund',
    livemode: true,
    status: 'succeeded',
    amount,
    currency: 'usd',
    created,
    metadata: { out_trade_no: 'ORDER-1' },
    charge: {
      id: 'ch_1',
      livemode: true,
      amount: chargeAmount,
      amount_refunded: amountRefunded,
      currency: 'usd',
      metadata: { out_trade_no: 'ORDER-1' },
      payment_intent: {
        id: 'pi_1',
        livemode: true,
        metadata: { out_trade_no: 'ORDER-1' },
      },
    },
  };
}

function scanFetch(pages: {
  refunds: unknown[][];
  disputes?: unknown[][];
}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: URL | string | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    if (url.pathname === '/v1/account') return okJson({ id: 'acct_history' });
    if (url.pathname === '/v1/checkout/sessions') {
      return okJson({ data: [], has_more: false });
    }
    const collection =
      url.pathname === '/v1/refunds'
        ? pages.refunds
        : url.pathname === '/v1/disputes'
          ? pages.disputes ?? [[]]
          : null;
    if (collection) {
      const cursor = url.searchParams.get('starting_after');
      const pageIndex = cursor ? 1 : 0;
      const data = collection[pageIndex] ?? [];
      return okJson({ data, has_more: pageIndex < collection.length - 1 });
    }
    throw new Error(`unexpected Stripe test request: ${url.pathname}`);
  });
  return { fetchImpl, calls };
}

function emptyScan(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: 'live',
    providerAccount: 'default',
    stripeAccountId: 'acct_history',
    keyFingerprint: createHash('sha256').update(LIVE_KEY).digest('hex'),
    scanStartedAt: new Date().toISOString(),
    since: new Date(Date.now() - 86_400_000).toISOString(),
    through: new Date(Date.now() - 1_000).toISOString(),
    counts: { refunds: 0, disputes: 0 },
    records: [],
    ...overrides,
  };
}

class MarkerDatabase {
  marker: string | null = null;
  activeTransactions = 0;
  maxActiveTransactions = 0;
  transactionOrder: string[] = [];
  private tail = Promise.resolve();

  async $executeRawUnsafe(sql: string, ...args: unknown[]) {
    if (sql.includes('INSERT IGNORE INTO SiteSetting') && this.marker === null) {
      this.marker = String(args[1]);
      return 1;
    }
    return 0;
  }

  async $transaction<T>(callback: (tx: MarkerDatabase) => Promise<T>): Promise<T> {
    let release = () => {};
    const prior = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    this.activeTransactions += 1;
    this.maxActiveTransactions = Math.max(
      this.maxActiveTransactions,
      this.activeTransactions
    );
    try {
      return await callback(this);
    } finally {
      this.activeTransactions -= 1;
      release();
    }
  }

  async $queryRawUnsafe(sql: string) {
    if (sql.includes('FROM SiteSetting') && sql.includes('FOR UPDATE')) {
      this.transactionOrder.push('marker-lock');
      return this.marker === null ? [] : [{ value: this.marker }];
    }
    if (sql.includes('AS inboxCount')) {
      return [{ inboxCount: 0, reviewCount: 0, holdCount: 0 }];
    }
    return [];
  }

  async executeInTransaction(sql: string, ...args: unknown[]) {
    return this.$executeRawUnsafe(sql, ...args);
  }
}

function installMarkerUpdate(db: MarkerDatabase) {
  db.$executeRawUnsafe = async (sql: string, ...args: unknown[]) => {
    if (sql.includes('INSERT IGNORE INTO SiteSetting')) {
      if (db.marker === null) db.marker = String(args[1]);
      return 1;
    }
    if (sql.includes('UPDATE SiteSetting')) {
      if (args.length === 3 && db.marker !== String(args[2])) return 0;
      db.marker = String(args[0]);
      return 1;
    }
    return 0;
  };
  return db;
}

type ImportState = {
  marker: string | null;
  objects: Map<string, string>;
  inbox: Map<string, { id: string; payloadSha256: string; status: string }>;
  reviewWrites: number;
  holdWrites: number;
};

function cloneImportState(state: ImportState): ImportState {
  return {
    marker: state.marker,
    objects: new Map(state.objects),
    inbox: new Map(
      [...state.inbox].map(([key, value]) => [key, { ...value }])
    ),
    reviewWrites: state.reviewWrites,
    holdWrites: state.holdWrites,
  };
}

function importDatabase({ lateConflictId }: { lateConflictId?: string } = {}) {
  const order = {
    id: 'order-1',
    userId: 'user-1',
    outTradeNo: 'ORDER-1',
    providerMode: 'unknown',
    providerAccount: 'default',
  };
  const state: ImportState = {
    marker: null,
    objects: new Map(),
    inbox: new Map(),
    reviewWrites: 0,
    holdWrites: 0,
  };

  const query = async (sql: string, ...args: unknown[]) => {
    if (sql.includes('FROM SiteSetting') && sql.includes('FOR UPDATE')) {
      return state.marker === null ? [] : [{ value: state.marker }];
    }
    if (sql.includes('FROM PaymentOrder') && sql.includes('outTradeNo = ?')) {
      return args[0] === order.outTradeNo ? [order] : [];
    }
    if (sql.includes('JOIN PaymentOrder')) return [];
    if (
      sql.includes('FROM PaymentOrder') &&
      (sql.includes('providerCheckoutSessionRef') ||
        sql.includes('providerPaymentIntentRef') ||
        sql.includes('providerChargeRef') ||
        sql.includes('providerRef = ?'))
    ) {
      return [];
    }
    if (sql.includes('FROM PaymentOrder') && sql.includes('FOR UPDATE')) {
      return args[0] === order.id ? [order] : [];
    }
    if (sql.includes('FROM PaymentProviderObject')) {
      const objectType = String(args.at(-2));
      const objectId = String(args.at(-1));
      const mapped = state.objects.get(`${objectType}\0${objectId}`);
      return mapped ? [{ orderId: mapped }] : [];
    }
    if (sql.includes('FROM PaymentWebhookEvent')) {
      const inbox = state.inbox.get(String(args[0]));
      return inbox ? [inbox] : [];
    }
    return [];
  };

  const execute = async (sql: string, ...args: unknown[]) => {
    if (sql.includes('INSERT IGNORE INTO SiteSetting')) {
      if (state.marker === null) state.marker = String(args[1]);
      return 1;
    }
    if (sql.includes('UPDATE SiteSetting')) {
      state.marker = String(args[0]);
      return 1;
    }
    if (sql.includes('INSERT IGNORE INTO PaymentProviderObject')) {
      const objectType = String(args[1]);
      const objectId = String(args[2]);
      const selectedOrderId = String(args[3]);
      const key = `${objectType}\0${objectId}`;
      if (!state.objects.has(key)) {
        state.objects.set(
          key,
          objectId === lateConflictId ? 'different-order' : selectedOrderId
        );
      }
      return 1;
    }
    if (sql.includes('INSERT IGNORE INTO PaymentWebhookEvent')) {
      const eventId = String(args[1]);
      if (!state.inbox.has(eventId)) {
        state.inbox.set(eventId, {
          id: `inbox-${eventId}`,
          payloadSha256: String(args[7]),
          status: 'review',
        });
      }
      return 1;
    }
    if (sql.includes('INSERT INTO PaymentReviewCase')) {
      state.reviewWrites += 1;
      return 1;
    }
    if (sql.includes('INSERT INTO PaymentAccountHold')) {
      state.holdWrites += 1;
      return 1;
    }
    return 1;
  };

  const db = {
    state,
    $executeRawUnsafe: execute,
    $queryRawUnsafe: query,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      const snapshot = cloneImportState(state);
      try {
        return await callback({ $queryRawUnsafe: query, $executeRawUnsafe: execute });
      } catch (error) {
        state.marker = snapshot.marker;
        state.objects = snapshot.objects;
        state.inbox = snapshot.inbox;
        state.reviewWrites = snapshot.reviewWrites;
        state.holdWrites = snapshot.holdWrites;
        throw error;
      }
    },
  };
  return db;
}

function importRecord(objectRefs = [{ objectType: 'charge', objectId: 'ch_1' }]) {
  const payloadJson = JSON.stringify({
    outTradeNo: 'ORDER-1',
    reversal: true,
    reversalAmountCents: 1000,
    fullReversal: true,
    currency: 'USD',
    objectRefs,
  });
  return {
    sourceKind: 'refund',
    sourceId: 're_1',
    sourceStatus: 'succeeded',
    eventId: 'history:refund:re_1:succeeded',
    eventType: 'charge.refunded',
    outTradeNo: 'ORDER-1',
    conflictingOrderEvidence: false,
    objectRefs,
    payloadJson,
    payloadSha256: createHash('sha256').update(payloadJson).digest('hex'),
    occurredAt: '2026-08-20T11:00:00.000Z',
    reversal: true,
    reversalAmountCents: 1000,
    fullReversal: true,
    currency: 'USD',
  };
}

function namespaceOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-namespace',
    userId: 'user-namespace',
    outTradeNo: 'ORDER-NAMESPACE',
    amountCents: 1000,
    currency: 'USD',
    providerMode: 'unknown',
    providerAccount: 'default',
    providerRef: null,
    providerCheckoutSessionRef: null,
    providerPaymentIntentRef: null,
    providerChargeRef: 'ch_namespace',
    status: 'paid',
    fulfillmentStatus: 'fulfilled',
    reviewReason: null,
    ...overrides,
  };
}

describe('SEC-025/026 Stripe history reconciliation', () => {
  it('traverses every refund page and forwards the last id as the cursor', async () => {
    const { fetchImpl, calls } = scanFetch({
      refunds: [
        [refund('re_1', 100, 1000, 300, 1_776_921_000)],
        [refund('re_2', 200, 1000, 300, 1_776_921_100)],
      ],
    });
    const scan = await scanStripeHistoricalReversals({
      secretKey: LIVE_KEY,
      since: SINCE,
      through: THROUGH,
      now: NOW,
      fetchImpl,
    });

    expect(scan.counts.refunds).toBe(2);
    expect(scan.records.filter((record: { sourceKind: string }) => record.sourceKind === 'refund')).toHaveLength(2);
    expect(
      calls.some(
        (call) => call.startsWith('/v1/refunds?') && call.includes('starting_after=re_1')
      )
    ).toBe(true);
  });

  it('fails closed when a page exceeds the configured scan limit', async () => {
    const { fetchImpl } = scanFetch({
      refunds: [[
        refund('re_1', 100, 1000, 200, 1_776_921_000),
        refund('re_2', 100, 1000, 200, 1_776_921_100),
      ]],
    });
    await expect(
      scanStripeHistoricalReversals({
        secretKey: LIVE_KEY,
        since: SINCE,
        through: THROUGH,
        now: NOW,
        maxItems: 1,
        fetchImpl,
      })
    ).rejects.toThrow(/scan limit 1 reached/);
  });

  it('rejects a Stripe list whose cursor does not advance', async () => {
    const repeated = refund('re_repeat', 100, 1000, 100, 1_776_921_000);
    const { fetchImpl } = scanFetch({ refunds: [[repeated], [repeated], [repeated]] });
    await expect(
      scanStripeHistoricalReversals({
        secretKey: LIVE_KEY,
        since: SINCE,
        through: THROUGH,
        now: NOW,
        fetchImpl,
      })
    ).rejects.toThrow(/pagination did not advance/);
  });

  it('keeps a refund payload immutable and emits a separate full-charge fact after catch-up', async () => {
    const firstFetch = scanFetch({
      refunds: [[refund('re_1', 400, 1000, 400, 1_776_921_000)]],
    }).fetchImpl;
    const secondFetch = scanFetch({
      refunds: [[
        refund('re_1', 400, 1000, 1000, 1_776_921_000),
        refund('re_2', 600, 1000, 1000, 1_776_921_100),
      ]],
    }).fetchImpl;
    const first = await scanStripeHistoricalReversals({
      secretKey: LIVE_KEY,
      since: SINCE,
      through: THROUGH,
      now: NOW,
      fetchImpl: firstFetch,
    });
    const second = await scanStripeHistoricalReversals({
      secretKey: LIVE_KEY,
      since: SINCE,
      through: THROUGH,
      now: NOW,
      fetchImpl: secondFetch,
    });
    const firstResource = first.records.find(
      (record: { eventId: string }) => record.eventId === 'history:refund:re_1:succeeded'
    );
    const rescannedResource = second.records.find(
      (record: { eventId: string }) => record.eventId === 'history:refund:re_1:succeeded'
    );
    const synthetic = second.records.find(
      (record: { eventId: string }) => record.eventId === 'history:charge_full_refund:ch_1'
    );

    expect(rescannedResource?.payloadSha256).toBe(firstResource?.payloadSha256);
    expect(JSON.parse(rescannedResource?.payloadJson ?? '{}').reversalAmountCents).toBe(400);
    expect(synthetic).toMatchObject({
      reversalAmountCents: 1000,
      fullReversal: true,
    });
  });

  it.each([
    ['refund', 'pending', 'pending', true, false],
    ['refund', 'failed', 'reinstated', false, null],
    ['dispute', 'needs_response', 'pending', true, false],
    ['dispute', 'lost', 'withdrawn', true, true],
    ['dispute', 'won', 'reinstated', false, null],
    ['dispute', 'warning_closed', 'reinstated', false, null],
  ])(
    'retains historical %s/%s with lifecycle state %s',
    async (kind, status, reversalState, reversal, fullReversal) => {
      const source = {
        ...refund(kind === 'refund' ? 're_state' : 'dp_state', 1000, 1000, 0, 1_776_921_000),
        status,
      };
      const { fetchImpl } = scanFetch({
        refunds: [kind === 'refund' ? [source] : []],
        disputes: [kind === 'dispute' ? [source] : []],
      });
      const scan = await scanStripeHistoricalReversals({
        secretKey: LIVE_KEY,
        since: SINCE,
        through: THROUGH,
        now: NOW,
        fetchImpl,
      });
      expect(scan.records[0]).toMatchObject({
        sourceKind: kind,
        reversalState,
        reversal,
        fullReversal,
      });
      const payload = JSON.parse(scan.records[0].payloadJson);
      expect(payload.reversalState).toBe(reversalState);
      expect(payload.reversal).toBe(reversal ? true : undefined);
    }
  );

  it('requires an empty scan to pass the same locked finalize cutover', async () => {
    const db = installMarkerUpdate(new MarkerDatabase());
    const scan = emptyScan();
    const applied = await applyStripeHistoricalReconciliation(db, scan, {
      reason: 'initial empty historical scan',
    });
    expect(applied.summary.status).toBe('scan_complete_pending_review');

    const finalized = await finalizeStripeHistoricalReconciliation(db, {
      secretKey: LIVE_KEY,
      reason: 'operator reviewed empty coverage',
    });
    expect(finalized.status).toBe('complete');
    expect(new Date(finalized.durableCutoverAt).getTime()).toBeGreaterThan(0);
    expect(db.transactionOrder).toEqual(['marker-lock', 'marker-lock']);
  });

  it('serializes apply and finalize on the same marker transaction lock', async () => {
    const db = installMarkerUpdate(new MarkerDatabase());
    const scan = emptyScan();
    const applyPromise = applyStripeHistoricalReconciliation(db, scan, {
      reason: 'catch-up scan before cutover',
    });
    const finalizePromise = finalizeStripeHistoricalReconciliation(db, {
      secretKey: LIVE_KEY,
      reason: 'finalize after serialized scan',
    });
    await Promise.all([applyPromise, finalizePromise]);

    expect(db.maxActiveTransactions).toBe(1);
    expect(JSON.parse(db.marker ?? '{}').status).toBe('complete');
  });

  it('does not reopen a processed event or reactivate its released hold on rerun', async () => {
    const db = importDatabase();
    const scan = emptyScan({
      records: [importRecord()],
      counts: { refunds: 1, disputes: 0 },
    });
    await applyStripeHistoricalReconciliation(db, scan, { reason: 'first import' });
    const inbox = db.state.inbox.get('history:refund:re_1:succeeded');
    expect(inbox).toBeDefined();
    if (inbox) inbox.status = 'processed';
    const initialReviewWrites = db.state.reviewWrites;
    const initialHoldWrites = db.state.holdWrites;

    await applyStripeHistoricalReconciliation(db, scan, { reason: 'idempotent rerun' });
    expect(db.state.reviewWrites).toBe(initialReviewWrites);
    expect(db.state.holdWrites).toBe(initialHoldWrites);
  });

  it('rolls back every object mapping when a later ref conflicts', async () => {
    const db = importDatabase({ lateConflictId: 'pi_late_conflict' });
    const record = importRecord([
      { objectType: 'payment_intent', objectId: 'pi_late_conflict' },
      { objectType: 'charge', objectId: 'ch_first' },
    ]);
    const scan = emptyScan({ records: [record], counts: { refunds: 1, disputes: 0 } });

    await expect(
      applyStripeHistoricalReconciliation(db, scan, { reason: 'atomic mapping test' })
    ).rejects.toThrow(/object maps to another order/);
    expect(db.state.objects.size).toBe(0);
    expect(db.state.inbox.size).toBe(0);
  });
});

describe('SEC-025 legacy Stripe settlement proof', () => {
  function namespaceDb(order: ReturnType<typeof namespaceOrder>) {
    return {
      $queryRawUnsafe: vi.fn().mockResolvedValue([order]),
    };
  }

  function chargeFetch(charge: Record<string, unknown>, paymentIntent?: Record<string, unknown>) {
    return vi.fn(async (input: URL | string | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/v1/charges/ch_namespace') return okJson(charge);
      if (pathname === '/v1/payment_intents/pi_namespace' && paymentIntent) {
        return okJson(paymentIntent);
      }
      return errorJson();
    });
  }

  const settledCharge = {
    id: 'ch_namespace',
    livemode: true,
    paid: true,
    captured: true,
    amount: 1000,
    amount_captured: 1000,
    amount_refunded: 0,
    refunded: false,
    currency: 'usd',
    metadata: { out_trade_no: 'ORDER-NAMESPACE' },
  };

  it('promotes only exact fully settled live evidence', async () => {
    const result = await verifyLegacyStripeOrderNamespaces(
      namespaceDb(namespaceOrder()),
      {
        secretKey: LIVE_KEY,
        fetchImpl: chargeFetch(settledCharge),
        reason: 'verify old namespace',
        dryRun: true,
      }
    );
    expect(result).toMatchObject({ total: 1, verifiedLive: 1, quarantined: 0 });
  });

  it.each([
    ['unpaid', { paid: false }],
    ['amount mismatch', { amount: 999 }],
    ['currency mismatch', { currency: 'eur' }],
    ['already refunded', { refunded: true, amount_refunded: 1000 }],
    ['partial capture', { amount_captured: 700 }],
  ])('quarantines %s Charge evidence', async (_label, mutation) => {
    const result = await verifyLegacyStripeOrderNamespaces(
      namespaceDb(namespaceOrder()),
      {
        secretKey: LIVE_KEY,
        fetchImpl: chargeFetch({ ...settledCharge, ...mutation }),
        reason: 'reject insufficient settlement proof',
        dryRun: true,
      }
    );
    expect(result).toMatchObject({ total: 1, verifiedLive: 0, quarantined: 1 });
  });

  it('requires a linked PaymentIntent to be succeeded for direct Charge proof', async () => {
    const result = await verifyLegacyStripeOrderNamespaces(
      namespaceDb(namespaceOrder()),
      {
        secretKey: LIVE_KEY,
        fetchImpl: chargeFetch(
          { ...settledCharge, payment_intent: 'pi_namespace' },
          {
            id: 'pi_namespace',
            livemode: true,
            status: 'requires_capture',
            amount_received: 700,
            currency: 'usd',
            metadata: { out_trade_no: 'ORDER-NAMESPACE' },
          }
        ),
        reason: 'reject unsettled payment intent',
        dryRun: true,
      }
    );
    expect(result).toMatchObject({ verifiedLive: 0, quarantined: 1 });
  });

  it.each([
    ['no refs', namespaceOrder({ providerChargeRef: null })],
    ['test mode', namespaceOrder({ providerMode: 'test' })],
    ['foreign account', namespaceOrder({ providerAccount: 'acct_foreign' })],
  ])('keeps %s legacy orders in quarantine', async (_label, order) => {
    const fetchImpl = vi.fn().mockResolvedValue(errorJson());
    const result = await verifyLegacyStripeOrderNamespaces(namespaceDb(order), {
      secretKey: LIVE_KEY,
      fetchImpl,
      reason: 'namespace quarantine',
      dryRun: true,
    });
    expect(result).toMatchObject({ verifiedLive: 0, quarantined: 1 });
  });
});
