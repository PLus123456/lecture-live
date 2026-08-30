import { beforeEach, describe, expect, it, vi } from 'vitest';

const { harnessRef } = vi.hoisted(() => ({
  harnessRef: { current: null as PaymentHarness | null },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => unknown) =>
      harnessRef.current!.transaction(
        cb as Parameters<PaymentHarness['transaction']>[0]
      ),
    $executeRaw: (...args: unknown[]) =>
      (harnessRef.current as unknown as { rootExecute: (...a: unknown[]) => unknown }).rootExecute(...args),
    $queryRaw: (...args: unknown[]) =>
      (harnessRef.current as unknown as { rootQuery: (...a: unknown[]) => unknown }).rootQuery(...args),
    paymentOrder: {
      findUnique: ({ where }: { where: { id?: string; outTradeNo?: string } }) =>
        [...harnessRef.current!.orders.values()].find(
          (order) => order.id === where.id || order.outTradeNo === where.outTradeNo
        ) ?? null,
    },
    user: {
      findUnique: () => ({
        ...harnessRef.current!.user,
        id: 'u1',
        email: 'u1@example.test',
        displayName: 'U1',
        emailPreferences: null,
      }),
    },
  },
}));

vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: vi.fn().mockResolvedValue({
    transcriptionMinutesLimit: 600,
    storageHoursLimit: 100,
    allowedModels: 'local,gpt',
  }),
  resolveRoleStorageBytesLimit: vi.fn().mockResolvedValue(BigInt(1024)),
}));
vi.mock('@/lib/quota', () => ({ settlePoolOnLimitChange: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logSystemEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendSubscriptionSuccessEmail: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { creditPaidOrder, spendWalletCents } from '@/lib/wallet';
import { handlePaymentReversal } from '@/lib/payment/refundHandling';

interface FakeOrder {
  id: string;
  userId: string;
  provider: string;
  kind: 'topup' | 'purchase';
  tierId: string | null;
  outTradeNo: string;
  providerRef: string | null;
  amountCents: number;
  currency: string;
  status: string;
  paidAt: Date | null;
  refundedAt: Date | null;
  fulfillmentStatus: string;
  metadataJson: string;
  createdAt: Date;
  expiresAt: Date;
}

interface FakeUser {
  walletBalanceCents: number;
  purchasedMinutesBalance: number;
  role: 'FREE' | 'PRO' | 'ADMIN';
  originalRole: 'FREE' | 'PRO' | 'ADMIN' | null;
  roleExpiresAt: Date | null;
  transcriptionMinutesLimit: number;
}

interface FakeFundingLot {
  id: string;
  userId: string;
  sourceOrderId: string | null;
  originalCents: number;
  remainingCents: number;
  reversedCents: number;
  status: string;
  reversedAt: Date | null;
}

interface FakeFundingAllocation {
  id: string;
  fundingLotId: string;
  userId: string;
  spendTransactionId: string;
  entitlementId: string | null;
  targetKind: string;
  amountCents: number;
  entitlementUnits: number;
  recoveredUnits: number;
  debtCents: number;
  reversedAt: Date | null;
}

class Mutex {
  private held = false;
  private readonly waiters: Array<(release: () => void) => void> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.held = true;
        resolve(() => {
          const next = this.waiters.shift();
          if (next) next(grant);
          else this.held = false;
        });
      };
      if (this.held) this.waiters.push(() => grant());
      else grant();
    });
  }
}

class Barrier {
  private arrived = 0;
  private release!: () => void;
  private readonly promise = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async wait(parties: number): Promise<void> {
    this.arrived += 1;
    if (this.arrived >= parties) this.release();
    await this.promise;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class PaymentHarness {
  readonly orders = new Map<string, FakeOrder>();
  readonly entitlements = new Map<
    string,
    {
      id: string;
      userId: string;
      orderId: string | null;
      kind: 'membership' | 'minutes';
      grantRole: 'PRO' | null;
      totalUnits: number;
      revokedUnits: number;
      status: string;
      grantedAt: Date;
    }
  >();
  readonly lots = new Map<string, FakeFundingLot>();
  readonly allocations = new Map<string, FakeFundingAllocation>();
  readonly holds = new Set<string>();
  readonly debts = new Map<string, { id: string; userId: string; amountCents: number }>();
  readonly ledger: Array<{ type: string; amountCents: number; orderId?: string | null }> = [];
  readonly sequence: string[] = [];
  readonly userMutex = new Mutex();
  readonly orderMutexes = new Map<string, Mutex>();
  readonly orderBarrier = new Barrier();
  readonly creditLocked = deferred();
  readonly reversalWaiting = deferred();
  readonly allowCredit = deferred();
  readonly firstUserWaiting = deferred();
  readonly catchWaiting = deferred();
  readonly allowCatch = deferred();
  user: FakeUser = {
    walletBalanceCents: 0,
    purchasedMinutesBalance: 0,
    role: 'FREE',
    originalRole: null,
    roleExpiresAt: null,
    transcriptionMinutesLimit: 600,
  };
  gateFirstOrderLock = false;
  barrierBeforeUser = false;
  private transactionNo = 0;

  rootExecute = vi.fn().mockResolvedValue(1);
  rootQuery = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (/FROM PaymentOrder/i.test(Array.from(strings).join('?'))) {
        const order = [...this.orders.values()].find(
          (row) => row.outTradeNo === String(values[0])
        );
        return order ? [{ ...order }] : [];
      }
      return [];
    }
  );

  async transaction<T>(cb: (tx: ReturnType<PaymentHarness['makeTx']>) => Promise<T>): Promise<T> {
    const no = ++this.transactionNo;
    const releases: Array<() => void> = [];
    const tx = this.makeTx(no, releases);
    const orderSnapshot = new Map(
      [...this.orders].map(([id, order]) => [id, { ...order }])
    );
    try {
      const result = await cb(tx);
      this.sequence.push(`tx${no}:commit`);
      return result;
    } catch (err) {
      // This focused harness models the PaymentOrder rollback needed by the failure-vs-refund
      // race below. The failing path throws before mutating User/lot/ledger state.
      this.orders.clear();
      for (const [id, order] of orderSnapshot) this.orders.set(id, order);
      this.sequence.push(`tx${no}:rollback`);
      throw err;
    } finally {
      while (releases.length) releases.pop()!();
    }
  }

  private makeTx(no: number, releases: Array<() => void>) {
    let currentOrder: FakeOrder | null = null;
    const sqlText = (strings: TemplateStringsArray) => Array.from(strings).join('?');
    return {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlText(strings);
        if (/FROM PaymentOrder/i.test(sql)) {
          const outTradeNo = String(values[0]);
          currentOrder = [...this.orders.values()].find((o) => o.outTradeNo === outTradeNo) ?? null;
          if (!currentOrder) return [];
          const mutex = this.orderMutexes.get(currentOrder.id) ?? new Mutex();
          this.orderMutexes.set(currentOrder.id, mutex);
          if (this.gateFirstOrderLock && no === 2) this.reversalWaiting.resolve();
          releases.push(await mutex.acquire());
          this.sequence.push(`tx${no}:order:${currentOrder.id}`);
          if (this.gateFirstOrderLock && no === 1) {
            this.creditLocked.resolve();
            await this.allowCredit.promise;
          }
          return [{ ...currentOrder }];
        }
        if (/FROM User/i.test(sql)) {
          if (this.barrierBeforeUser) {
            if (no === 1) this.firstUserWaiting.resolve();
            await this.orderBarrier.wait(2);
          }
          releases.push(await this.userMutex.acquire());
          this.sequence.push(`tx${no}:user`);
          if (/SELECT id FROM User/i.test(sql)) return [{ id: 'u1' }];
          return [{ ...this.user }];
        }
        if (/FROM PaymentAccountHold/i.test(sql)) {
          return this.holds.has(String(values[0])) ? [{ id: 'hold-1' }] : [];
        }
        if (/FROM WalletFundingLot/i.test(sql)) {
          if (/sourceOrderId/i.test(sql)) {
            const orderId = String(values[0]);
            const lot = [...this.lots.values()].find((row) => row.sourceOrderId === orderId);
            return lot ? [{ ...lot }] : [];
          }
          const userId = String(values[0]);
          return [...this.lots.values()]
            .filter(
              (row) =>
                row.userId === userId && row.status === 'active' && row.remainingCents > 0
            )
            .map((row) => ({ ...row }));
        }
        if (/FROM WalletFundingAllocation/i.test(sql)) {
          const lotId = String(values[0]);
          return [...this.allocations.values()]
            .filter((row) => row.fundingLotId === lotId)
            .map((row) => ({ ...row }));
        }
        if (/FROM PaymentEntitlement/i.test(sql)) {
          if (/WHERE userId/i.test(sql)) {
            const userId = String(values[0]);
            return [...this.entitlements.values()]
              .filter(
                (row) =>
                  row.userId === userId &&
                  row.kind === 'membership' &&
                  ['active', 'partially_reversed'].includes(row.status)
              )
              .sort(
                (left, right) =>
                  left.grantedAt.getTime() - right.grantedAt.getTime() ||
                  left.id.localeCompare(right.id)
              )
              .map((row) => ({ ...row }));
          }
          const entitlement = this.entitlements.get(String(values[0]));
          return entitlement ? [{ ...entitlement }] : [];
        }
        if (/FROM PaymentDebt/i.test(sql)) {
          const orderId = String(values[0]);
          const debt = this.debts.get(orderId);
          return debt ? [{ id: debt.id }] : [{ id: `debt-${orderId}` }];
        }
        return [];
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlText(strings);
        if (/INSERT INTO WalletFundingLot/i.test(sql)) {
          const [id, userId, sourceOrderId, , , originalCents] = values;
          this.lots.set(String(id), {
            id: String(id),
            userId: String(userId),
            sourceOrderId: sourceOrderId === null ? null : String(sourceOrderId),
            originalCents: Number(originalCents),
            remainingCents: Number(originalCents),
            reversedCents: 0,
            status: 'active',
            reversedAt: null,
          });
        } else if (/INSERT INTO WalletFundingAllocation/i.test(sql)) {
          const [id, fundingLotId, userId, spendTransactionId, entitlementId, targetKind, amountCents, entitlementUnits] =
            values;
          this.allocations.set(String(id), {
            id: String(id),
            fundingLotId: String(fundingLotId),
            userId: String(userId),
            spendTransactionId: String(spendTransactionId),
            entitlementId: entitlementId === null ? null : String(entitlementId),
            targetKind: String(targetKind),
            amountCents: Number(amountCents),
            entitlementUnits: Number(entitlementUnits),
            recoveredUnits: 0,
            debtCents: 0,
            reversedAt: null,
          });
        } else if (/INSERT INTO PaymentEntitlement/i.test(sql)) {
          const [id, userId, sourceOrderId, , kind, grantRole, totalUnits] = values;
          this.entitlements.set(String(id), {
            id: String(id),
            userId: String(userId),
            orderId: sourceOrderId === null ? null : String(sourceOrderId),
            kind: String(kind) as 'membership' | 'minutes',
            grantRole: grantRole === null ? null : (String(grantRole) as 'PRO'),
            totalUnits: Number(totalUnits),
            revokedUnits: 0,
            status: 'active',
            grantedAt: new Date(),
          });
        } else if (/INSERT INTO PaymentDebt/i.test(sql)) {
          const [id, userId, sourceOrderId, , amountCents] = values;
          this.debts.set(String(sourceOrderId), {
            id: String(id),
            userId: String(userId),
            amountCents: Number(amountCents),
          });
        } else if (/INSERT INTO PaymentAccountHold/i.test(sql)) {
          this.holds.add(String(values[2]));
        } else if (/SET status = 'paid'/i.test(sql) && currentOrder) {
          currentOrder.status = 'paid';
          currentOrder.paidAt = values[0] as Date;
          currentOrder.fulfillmentStatus = 'processing';
        } else if (/fulfillmentStatus = 'fulfilled'/i.test(sql) && currentOrder) {
          currentOrder.fulfillmentStatus = 'fulfilled';
          this.sequence.push(`tx${no}:fulfilled`);
        } else if (/fulfillmentStatus = 'reversed'/i.test(sql) && currentOrder) {
          currentOrder.status = 'refunded';
          currentOrder.refundedAt = new Date();
          currentOrder.fulfillmentStatus = 'reversed';
          this.sequence.push(`tx${no}:reversed`);
        } else if (/walletBalanceCents = walletBalanceCents -/i.test(sql)) {
          const cents = Number(values[0]);
          if (this.user.walletBalanceCents < cents) return 0;
          this.user.walletBalanceCents -= cents;
        } else if (/purchasedMinutesBalance = purchasedMinutesBalance -/i.test(sql)) {
          const minutes = Number(values[0]);
          if (this.user.purchasedMinutesBalance < minutes) return 0;
          this.user.purchasedMinutesBalance -= minutes;
        } else if (/UPDATE WalletFundingLot[\s\S]*remainingCents = remainingCents -/i.test(sql)) {
          const amount = Number(values[0]);
          const lot = this.lots.get(String(values[1]));
          if (!lot || lot.status !== 'active' || lot.remainingCents < amount) return 0;
          lot.remainingCents -= amount;
        } else if (/UPDATE WalletFundingAllocation/i.test(sql)) {
          const allocation = this.allocations.get(String(values[2]));
          if (allocation && allocation.reversedAt === null) {
            allocation.recoveredUnits = Number(values[0]);
            allocation.debtCents = Number(values[1]);
            allocation.reversedAt = new Date();
          }
        } else if (/UPDATE WalletFundingLot[\s\S]*status = 'reversed'/i.test(sql)) {
          const lot = this.lots.get(String(values[1]));
          if (lot) {
            lot.remainingCents = 0;
            lot.reversedCents = Number(values[0]);
            lot.status = 'reversed';
            lot.reversedAt = new Date();
          }
        } else if (/UPDATE PaymentEntitlement/i.test(sql)) {
          const id = String(values[values.length - 1]);
          const row = this.entitlements.get(id);
          if (row) {
            row.revokedUnits = Number(values[0]);
            row.status = row.revokedUnits >= row.totalUnits ? 'reversed' : 'partially_reversed';
          }
        }
        return 1;
      },
      user: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          const wallet = data.walletBalanceCents as { increment?: number } | undefined;
          if (wallet?.increment) this.user.walletBalanceCents += wallet.increment;
          const minutes = data.purchasedMinutesBalance as { increment?: number } | undefined;
          if (minutes?.increment) this.user.purchasedMinutesBalance += minutes.increment;
          if (data.role) this.user.role = data.role as FakeUser['role'];
          if ('originalRole' in data) this.user.originalRole = data.originalRole as FakeUser['originalRole'];
          if ('roleExpiresAt' in data) this.user.roleExpiresAt = data.roleExpiresAt as Date | null;
          return { walletBalanceCents: this.user.walletBalanceCents };
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const walletGuard = where.walletBalanceCents as { gte?: number } | undefined;
          const decrement = (data.walletBalanceCents as { decrement?: number } | undefined)
            ?.decrement;
          if (
            walletGuard?.gte !== undefined &&
            this.user.walletBalanceCents < Number(walletGuard.gte)
          ) {
            return { count: 0 };
          }
          if (decrement) this.user.walletBalanceCents -= Number(decrement);
          return { count: 1 };
        },
        findUnique: async () => ({ walletBalanceCents: this.user.walletBalanceCents }),
      },
      walletTransaction: {
        create: async ({ data }: { data: { type: string; amountCents: number; orderId?: string | null } }) => {
          this.ledger.push(data);
          return { id: `wt-${this.ledger.length}`, ...data };
        },
      },
      rechargeTier: { findUnique: vi.fn() },
    };
  }
}

beforeEach(() => {
  harnessRef.current = new PaymentHarness();
});

describe('payment row-lock concurrency (SEC-027/028)', () => {
  it('refund winning after fulfillment rollback cannot be overwritten by catch review CAS', async () => {
    const db = harnessRef.current as PaymentHarness;
    db.orders.set('o1', {
      id: 'o1',
      userId: 'u1',
      provider: 'stripe',
      kind: 'topup',
      tierId: null,
      outTradeNo: 'LL-RACE-CATCH',
      providerRef: null,
      amountCents: 1000,
      currency: 'CNY',
      status: 'pending',
      paidAt: null,
      refundedAt: null,
      fulfillmentStatus: 'pending',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Force a WalletError after the order entered processing inside tx1; real rollback restores
    // pending before catch runs.
    db.holds.add('u1');
    db.rootExecute.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Array.from(strings).join('?');
        if (sql.includes("reviewReason = 'fulfillment_failed_uncommitted'")) {
          db.catchWaiting.resolve();
          await db.allowCatch.promise;
          const outTradeNo = String(values[1]);
          const order = [...db.orders.values()].find(
            (row) => row.outTradeNo === outTradeNo
          );
          if (
            !order ||
            order.refundedAt ||
            order.status === 'refunded' ||
            ['fulfilled', 'reversed'].includes(order.fulfillmentStatus)
          ) {
            return 0;
          }
          order.fulfillmentStatus = 'review';
          return 1;
        }
        return 1;
      }
    );

    const fulfillment = creditPaidOrder(
      'LL-RACE-CATCH',
      'ch_race',
      'stripe',
      1000,
      'CNY'
    );
    await db.catchWaiting.promise;
    const reversal = handlePaymentReversal({
      outTradeNo: 'LL-RACE-CATCH',
      provider: 'stripe',
    });
    await expect(reversal).resolves.toEqual({ handled: true, outcome: 'reversed' });
    db.allowCatch.resolve();

    await expect(fulfillment).resolves.toMatchObject({
      ok: false,
      acknowledged: true,
      status: 'refunded',
    });
    expect(db.orders.get('o1')).toMatchObject({
      status: 'refunded',
      fulfillmentStatus: 'reversed',
    });
    expect(db.sequence).toEqual(
      expect.arrayContaining(['tx1:rollback', 'tx2:reversed', 'tx2:commit'])
    );
  });

  it('serializes an earlier reversal before settlement and permanently blocks the later grant', async () => {
    const db = harnessRef.current as PaymentHarness;
    db.gateFirstOrderLock = true;
    db.orders.set('o1', {
      id: 'o1',
      userId: 'u1',
      provider: 'stripe',
      kind: 'topup',
      tierId: null,
      outTradeNo: 'LL1',
      providerRef: null,
      amountCents: 1000,
      currency: 'CNY',
      status: 'pending',
      paidAt: null,
      refundedAt: null,
      fulfillmentStatus: 'pending',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const reversal = handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });
    await db.creditLocked.promise;
    const fulfillment = creditPaidOrder('LL1', 'ch_1', 'stripe', 1000, 'CNY');
    await db.reversalWaiting.promise;
    db.allowCredit.resolve();

    await expect(reversal).resolves.toEqual({ handled: true, outcome: 'reversed' });
    await expect(fulfillment).resolves.toMatchObject({ ok: false, acknowledged: true });
    expect(db.orders.get('o1')).toMatchObject({
      status: 'refunded',
      fulfillmentStatus: 'reversed',
    });
    expect(db.user.walletBalanceCents).toBe(0);
    expect(db.ledger).toHaveLength(0);
    expect(db.sequence.indexOf('tx1:commit')).toBeLessThan(db.sequence.indexOf('tx2:order:o1'));
  });

  it('serializes fulfillment against a simultaneous reversal on the same order', async () => {
    const db = harnessRef.current as PaymentHarness;
    db.gateFirstOrderLock = true;
    db.orders.set('o1', {
      id: 'o1',
      userId: 'u1',
      provider: 'stripe',
      kind: 'topup',
      tierId: null,
      outTradeNo: 'LL1',
      providerRef: null,
      amountCents: 1000,
      currency: 'CNY',
      status: 'pending',
      paidAt: null,
      refundedAt: null,
      fulfillmentStatus: 'pending',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const fulfillment = creditPaidOrder('LL1', 'ch_1', 'stripe', 1000, 'CNY');
    await db.creditLocked.promise;
    const reversal = handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });
    await db.reversalWaiting.promise;
    db.allowCredit.resolve();

    await expect(fulfillment).resolves.toMatchObject({ ok: true });
    await expect(reversal).resolves.toEqual({ handled: true, outcome: 'reversed' });
    expect(db.orders.get('o1')).toMatchObject({ status: 'refunded', fulfillmentStatus: 'reversed' });
    expect(db.user.walletBalanceCents).toBe(0);
    expect(db.sequence.indexOf('tx1:commit')).toBeLessThan(db.sequence.indexOf('tx2:order:o1'));
  });

  it('two concurrent membership reversals subtract both durations without a lost update', async () => {
    const db = harnessRef.current as PaymentHarness;
    db.barrierBeforeUser = true;
    const originalExpiry = new Date(Date.now() + 120 * 86_400_000);
    db.user = {
      ...db.user,
      role: 'PRO',
      originalRole: 'FREE',
      roleExpiresAt: originalExpiry,
    };
    db.entitlements.set('ent-remaining', {
      id: 'ent-remaining',
      userId: 'u1',
      orderId: 'o-remaining',
      kind: 'membership',
      grantRole: 'PRO',
      totalUnits: 60,
      revokedUnits: 0,
      status: 'active',
      grantedAt: new Date(Date.now() - 5_000),
    });
    for (const suffix of ['1', '2']) {
      db.orders.set(`o${suffix}`, {
        id: `o${suffix}`,
        userId: 'u1',
        provider: 'stripe',
        kind: 'purchase',
        tierId: `tier-${suffix}`,
        outTradeNo: `LL${suffix}`,
        providerRef: `ch_${suffix}`,
        amountCents: 3900,
        currency: 'CNY',
        status: 'paid',
        paidAt: new Date(),
        refundedAt: null,
        fulfillmentStatus: 'fulfilled',
        metadataJson: JSON.stringify({
          grant: { kind: 'membership', durationDays: 30, tierId: `tier-${suffix}` },
        }),
        createdAt: new Date(),
        expiresAt: new Date(),
      });
      db.entitlements.set(`ent-${suffix}`, {
        id: `ent-${suffix}`,
        userId: 'u1',
        orderId: `o${suffix}`,
        kind: 'membership',
        grantRole: 'PRO',
        totalUnits: 30,
        revokedUnits: 0,
        status: 'active',
        grantedAt: new Date(Date.now() - Number(suffix) * 1_000),
      });
      db.lots.set(`lot-${suffix}`, {
        id: `lot-${suffix}`,
        userId: 'u1',
        sourceOrderId: `o${suffix}`,
        originalCents: 3900,
        remainingCents: 0,
        reversedCents: 0,
        status: 'active',
        reversedAt: null,
      });
      db.allocations.set(`alloc-${suffix}`, {
        id: `alloc-${suffix}`,
        fundingLotId: `lot-${suffix}`,
        userId: 'u1',
        spendTransactionId: `spend-${suffix}`,
        entitlementId: `ent-${suffix}`,
        targetKind: 'membership',
        amountCents: 3900,
        entitlementUnits: 30,
        recoveredUnits: 0,
        debtCents: 0,
        reversedAt: null,
      });
    }

    const [first, second] = await Promise.all([
      handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' }),
      handlePaymentReversal({ outTradeNo: 'LL2', provider: 'stripe' }),
    ]);

    expect(first).toEqual({ handled: true, outcome: 'reversed' });
    expect(second).toEqual({ handled: true, outcome: 'reversed' });
    expect(db.user.roleExpiresAt?.getTime()).toBe(
      originalExpiry.getTime() - 60 * 86_400_000
    );
    expect(db.user.role).toBe('PRO');
    expect(db.entitlements.get('ent-1')?.status).toBe('reversed');
    expect(db.entitlements.get('ent-2')?.status).toBe('reversed');
    expect(db.entitlements.get('ent-remaining')?.status).toBe('active');
  });

  it('serializes a service spend against source-lot reversal and leaves no negative/untracked money', async () => {
    const db = harnessRef.current as PaymentHarness;
    db.barrierBeforeUser = true;
    db.user.walletBalanceCents = 1000;
    db.orders.set('o1', {
      id: 'o1',
      userId: 'u1',
      provider: 'stripe',
      kind: 'topup',
      tierId: null,
      outTradeNo: 'LL1',
      providerRef: 'ch_1',
      amountCents: 1000,
      currency: 'CNY',
      status: 'paid',
      paidAt: new Date(),
      refundedAt: null,
      fulfillmentStatus: 'fulfilled',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
      createdAt: new Date(),
      expiresAt: new Date(),
    });
    db.lots.set('lot-1', {
      id: 'lot-1',
      userId: 'u1',
      sourceOrderId: 'o1',
      originalCents: 1000,
      remainingCents: 1000,
      reversedCents: 0,
      status: 'active',
      reversedAt: null,
    });

    // Transaction 1 reaches the real async barrier first. Transaction 2 then releases the
    // barrier; both contend on the same mutex rather than being invoked sequentially.
    const spend = spendWalletCents({
      userId: 'u1',
      amountCents: 1000,
      type: 'translation',
    });
    await db.firstUserWaiting.promise;
    const reversal = handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });

    await expect(spend).resolves.toEqual({ balanceAfterCents: 0 });
    await expect(reversal).resolves.toEqual({ handled: true, outcome: 'reversed' });

    expect(db.user.walletBalanceCents).toBe(0);
    expect(db.lots.get('lot-1')).toMatchObject({ remainingCents: 0, status: 'reversed' });
    expect([...db.allocations.values()]).toEqual([
      expect.objectContaining({
        fundingLotId: 'lot-1',
        targetKind: 'service',
        amountCents: 1000,
        debtCents: 1000,
      }),
    ]);
    expect(db.debts.get('o1')).toMatchObject({ userId: 'u1', amountCents: 1000 });
    expect(db.holds.has('u1')).toBe(true);
    expect(db.sequence.indexOf('tx1:commit')).toBeLessThan(db.sequence.indexOf('tx2:user'));
  });
});
