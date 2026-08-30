import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { allocateWalletSpend, assertNoActivePaymentHold } from '@/lib/payment/fundingLedger';

const queryRaw = vi.fn();
const executeRaw = vi.fn();
const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as never;

const sqlOf = (call: unknown[]) => String(call[0]);

beforeEach(() => {
  queryRaw.mockReset();
  executeRaw.mockReset().mockResolvedValue(1);
});

describe('SEC-025 wallet funding allocation', () => {
  it('allocates FIFO across lots and apportions entitlement units exactly once', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        id: 'lot-a',
        userId: 'u1',
        originalCents: 400,
        remainingCents: 400,
        status: 'active',
      },
      {
        id: 'lot-b',
        userId: 'u1',
        originalCents: 600,
        remainingCents: 600,
        status: 'active',
      },
    ]);

    await allocateWalletSpend(tx, {
      userId: 'u1',
      spendTransactionId: 'spend-1',
      amountCents: 1000,
      balanceAfterCents: 0,
      targetKind: 'membership',
      entitlementId: 'ent-1',
      totalUnits: 30,
    });

    const inserts = executeRaw.mock.calls.filter((call) =>
      /INSERT INTO WalletFundingAllocation/.test(sqlOf(call))
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toEqual(
      expect.arrayContaining(['lot-a', 'u1', 'spend-1', 'ent-1', 'membership', 400, 12])
    );
    expect(inserts[1]).toEqual(
      expect.arrayContaining(['lot-b', 'u1', 'spend-1', 'ent-1', 'membership', 600, 18])
    );
    expect(Number(inserts[0][inserts[0].length - 1]) + Number(inserts[1][inserts[1].length - 1])).toBe(
      30
    );
  });

  it('represents an unattributed historical balance as a consumed legacy lot, never as a payment lot', async () => {
    queryRaw.mockResolvedValueOnce([]);

    await allocateWalletSpend(tx, {
      userId: 'u1',
      spendTransactionId: 'spend-legacy',
      amountCents: 250,
      balanceAfterCents: 0,
      targetKind: 'service',
    });

    const lotInsert = executeRaw.mock.calls.find((call) =>
      /INSERT INTO WalletFundingLot/.test(sqlOf(call))
    );
    expect(lotInsert).toEqual(expect.arrayContaining(['u1', 'legacy_unattributed', 250]));
    const allocationInsert = executeRaw.mock.calls.find((call) =>
      /INSERT INTO WalletFundingAllocation/.test(sqlOf(call))
    );
    expect(allocationInsert).toEqual(
      expect.arrayContaining(['u1', 'spend-legacy', 'service', 250, 0])
    );
  });

  it('consumes an older legacy balance before a newer tracked topup', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        id: 'lot-new-payment',
        userId: 'u1',
        originalCents: 1000,
        remainingCents: 1000,
        status: 'active',
      },
    ]);

    // Locked wallet was 2000 before this spend: 1000 is the tracked topup and 1000 is a
    // pre-ledger balance. FIFO must consume the latter, leaving the chargeback source intact.
    await allocateWalletSpend(tx, {
      userId: 'u1',
      spendTransactionId: 'spend-after-upgrade',
      amountCents: 1000,
      balanceAfterCents: 1000,
      targetKind: 'service',
    });

    const allocationInserts = executeRaw.mock.calls.filter((call) =>
      /INSERT INTO WalletFundingAllocation/.test(sqlOf(call))
    );
    expect(allocationInserts).toHaveLength(1);
    expect(allocationInserts[0]).not.toContain('lot-new-payment');
    expect(
      executeRaw.mock.calls.some(
        (call) => /UPDATE WalletFundingLot/.test(sqlOf(call)) && call.includes('lot-new-payment')
      )
    ).toBe(false);
  });

  it('fails the whole transaction when a forced source lot no longer has enough funds', async () => {
    executeRaw.mockResolvedValueOnce(0);

    await expect(
      allocateWalletSpend(tx, {
        userId: 'u1',
        spendTransactionId: 'spend-race',
        amountCents: 500,
        balanceAfterCents: 0,
        targetKind: 'minutes',
        entitlementId: 'ent-race',
        totalUnits: 60,
        forcedFundingLotId: 'lot-race',
      })
    ).rejects.toThrow(/allocation raced or became insufficient/);
    expect(
      executeRaw.mock.calls.some((call) => /INSERT INTO WalletFundingAllocation/.test(sqlOf(call)))
    ).toBe(false);
  });

  it('active hold is a final spend/checkout gate', async () => {
    queryRaw.mockResolvedValueOnce([{ id: 'hold-1' }]);
    await expect(assertNoActivePaymentHold(tx, 'u1')).rejects.toThrow(
      'payment_account_frozen'
    );
  });
});
