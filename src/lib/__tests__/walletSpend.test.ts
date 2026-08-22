// spendWalletCents / refundWalletCents（翻译扣费/退款的通用助手）单测：
// 原子守卫（WHERE gte 条件扣减）、余额不足/用户不存在语义、台账写入、外部事务透传。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  userUpdateMock,
  userUpdateManyMock,
  userFindUniqueMock,
  walletTxCreateMock,
  executeRawMock,
  queryRawMock,
} = vi.hoisted(() => ({
    userUpdateMock: vi.fn(),
    userUpdateManyMock: vi.fn(),
    userFindUniqueMock: vi.fn(),
    walletTxCreateMock: vi.fn(),
    executeRawMock: vi.fn(),
    queryRawMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => {
  const tx = {
    user: {
      update: userUpdateMock,
      updateMany: userUpdateManyMock,
      findUnique: userFindUniqueMock,
    },
    walletTransaction: { create: walletTxCreateMock },
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
  };
  return {
    prisma: {
      ...tx,
      $transaction: (cb: (t: typeof tx) => unknown) => cb(tx),
    },
  };
});

vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: vi.fn(),
  resolveRoleStorageBytesLimit: vi.fn(),
}));
vi.mock('@/lib/auditLog', () => ({ logSystemEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendSubscriptionSuccessEmail: vi.fn() }));

import { spendWalletCents, refundWalletCents, WalletError } from '@/lib/wallet';

beforeEach(() => {
  userUpdateMock.mockReset();
  userUpdateManyMock.mockReset();
  userFindUniqueMock.mockReset();
  walletTxCreateMock.mockReset();
  executeRawMock.mockReset();
  executeRawMock.mockResolvedValue(1);
  queryRawMock.mockReset();
  queryRawMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = String(strings);
    if (/FROM PaymentAccountHold/i.test(sql)) return [];
    if (/FROM WalletFundingLot/i.test(sql)) return [];
    if (/SELECT id FROM User/i.test(sql)) return [{ id: 'u1' }];
    return [];
  });
  walletTxCreateMock.mockResolvedValue({ id: 'wallet-tx-1' });
});

describe('spendWalletCents', () => {
  it('余额充足：条件扣减 + 写台账（负 amountCents + 余额快照）', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindUniqueMock.mockResolvedValue({ walletBalanceCents: 700 });

    const result = await spendWalletCents({
      userId: 'u1',
      amountCents: 300,
      type: 'translation',
      note: 'doc-translate:t1',
    });

    expect(result.balanceAfterCents).toBe(700);
    // 守卫形态：WHERE walletBalanceCents >= 300 才 decrement
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'u1', walletBalanceCents: { gte: 300 } },
      data: { walletBalanceCents: { decrement: 300 } },
    });
    expect(walletTxCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        type: 'translation',
        amountCents: -300,
        balanceAfterCents: 700,
        note: 'doc-translate:t1',
      }),
    });
  });

  it('余额不足：count=0 且用户存在 → insufficient_balance，不写台账', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    userFindUniqueMock.mockResolvedValue({ id: 'u1' });

    await expect(
      spendWalletCents({ userId: 'u1', amountCents: 300, type: 'translation' })
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
    expect(walletTxCreateMock).not.toHaveBeenCalled();
  });

  it('用户不存在：count=0 且查无此人 → user_not_found', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    userFindUniqueMock.mockResolvedValue(null);
    queryRawMock.mockResolvedValueOnce([]);

    await expect(
      spendWalletCents({ userId: 'ghost', amountCents: 300, type: 'translation' })
    ).rejects.toMatchObject({ code: 'user_not_found' });
  });

  it('非法金额（0/负数/NaN）直接拒绝', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      await expect(
        spendWalletCents({ userId: 'u1', amountCents: bad, type: 'translation' })
      ).rejects.toBeInstanceOf(WalletError);
    }
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it('传入外部事务时不自开事务，直接用传入的 tx 客户端', async () => {
    const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txFindUnique = vi.fn().mockResolvedValue({ walletBalanceCents: 1 });
    const txCreate = vi.fn().mockResolvedValue({ id: 'external-wallet-tx-1' });
    const txExecuteRaw = vi.fn().mockResolvedValue(1);
    const txQueryRaw = vi.fn().mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = String(strings);
      if (/FROM PaymentAccountHold/i.test(sql)) return [];
      if (/FROM WalletFundingLot/i.test(sql)) return [];
      if (/SELECT id FROM User/i.test(sql)) return [{ id: 'u1' }];
      return [];
    });
    const externalTx = {
      user: { updateMany: txUpdateMany, findUnique: txFindUnique },
      walletTransaction: { create: txCreate },
      $executeRaw: txExecuteRaw,
      $queryRaw: txQueryRaw,
    } as never;

    await spendWalletCents(
      { userId: 'u1', amountCents: 9, type: 'translation' },
      externalTx
    );
    expect(txUpdateMany).toHaveBeenCalled();
    // 全局 prisma 的 mock 不应被触碰
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it('账户存在 active payment hold：拒绝扣款且不写台账/资金分摊', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{ id: 'hold-1' }]);

    await expect(
      spendWalletCents({ userId: 'u1', amountCents: 300, type: 'translation' })
    ).rejects.toMatchObject({ code: 'account_frozen' });

    expect(userUpdateManyMock).not.toHaveBeenCalled();
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });
});

describe('refundWalletCents', () => {
  it('入账 + 台账（正 amountCents）', async () => {
    userUpdateMock.mockResolvedValue({ walletBalanceCents: 1000 });

    const result = await refundWalletCents({
      userId: 'u1',
      amountCents: 300,
      type: 'translation_refund',
      note: '翻译失败自动退款 doc-translate:t1',
    });

    expect(result.balanceAfterCents).toBe(1000);
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { walletBalanceCents: { increment: 300 } },
      select: { walletBalanceCents: true },
    });
    expect(walletTxCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'translation_refund',
        amountCents: 300,
        balanceAfterCents: 1000,
      }),
    });
  });

  it('用户不存在（update 抛错）→ user_not_found，不写台账', async () => {
    userUpdateMock.mockRejectedValue(new Error('P2025'));

    await expect(
      refundWalletCents({ userId: 'ghost', amountCents: 300, type: 'translation_refund' })
    ).rejects.toMatchObject({ code: 'user_not_found' });
    expect(walletTxCreateMock).not.toHaveBeenCalled();
  });
});
