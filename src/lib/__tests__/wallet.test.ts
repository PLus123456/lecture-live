import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  paymentOrderUpdateManyMock,
  paymentOrderFindUniqueMock,
  paymentOrderCreateMock,
  userUpdateMock,
  userFindUniqueMock,
  walletTxCreateMock,
  rechargeTierFindUniqueMock,
  executeRawMock,
} = vi.hoisted(() => ({
  paymentOrderUpdateManyMock: vi.fn(),
  paymentOrderFindUniqueMock: vi.fn(),
  paymentOrderCreateMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  walletTxCreateMock: vi.fn(),
  rechargeTierFindUniqueMock: vi.fn(),
  executeRawMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    paymentOrder: {
      updateMany: paymentOrderUpdateManyMock,
      findUnique: paymentOrderFindUniqueMock,
      create: paymentOrderCreateMock,
    },
    user: { update: userUpdateMock, findUnique: userFindUniqueMock },
    walletTransaction: { create: walletTxCreateMock },
    rechargeTier: { findUnique: rechargeTierFindUniqueMock },
    $executeRaw: executeRawMock,
  };
  return {
    prisma: {
      ...tx,
      // $transaction 直接以同一 mock 作为 tx 客户端执行回调。
      $transaction: (cb: (t: typeof tx) => unknown) => cb(tx),
    },
  };
});

vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: vi.fn().mockResolvedValue({
    transcriptionMinutesLimit: 600,
    storageHoursLimit: 100,
    allowedModels: 'local,gpt,deepseek',
  }),
  resolveRoleStorageBytesLimit: vi.fn().mockResolvedValue(BigInt(1024 * 1024 * 1024)),
}));

import { creditPaidOrder, spendFromBalance, adminAdjust, WalletError } from '@/lib/wallet';

beforeEach(() => {
  paymentOrderUpdateManyMock.mockReset();
  paymentOrderFindUniqueMock.mockReset();
  userUpdateMock.mockReset();
  userFindUniqueMock.mockReset();
  walletTxCreateMock.mockReset();
  rechargeTierFindUniqueMock.mockReset();
  executeRawMock.mockReset();
  userUpdateMock.mockResolvedValue({ walletBalanceCents: 0 });
  walletTxCreateMock.mockResolvedValue({});
});

describe('creditPaidOrder：幂等到账', () => {
  it('▶ 充值订单：认领成功 → 钱包 += creditCents + topup 台账', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o1',
      userId: 'u1',
      kind: 'topup',
      tierId: null,
      amountCents: 1000,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 1200, returnUrl: '/x' }), // 充1000送200
    });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 1200 });

    const res = await creditPaidOrder('LLABC', 'ref-1');
    expect(res.ok).toBe(true);
    expect(res.alreadyProcessed).toBe(false);
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletBalanceCents: { increment: 1200 } } })
    );
    expect(walletTxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'topup', amountCents: 1200, balanceAfterCents: 1200 }),
      })
    );
  });

  it('▶ 重复回调：CAS count=0 → 幂等，不再加余额/记账', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o1',
      userId: 'u1',
      kind: 'topup',
      amountCents: 1000,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
    });

    const res = await creditPaidOrder('LLABC');
    expect(res.alreadyProcessed).toBe(true);
    expect(res.ok).toBe(true);
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(walletTxCreateMock).not.toHaveBeenCalled();
  });

  it('▶ 订单不存在：ok:false', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce(null);
    const res = await creditPaidOrder('LLNONE');
    expect(res.ok).toBe(false);
  });

  it('▶ 直接购买时间档位：进账 + 等额出账 + 加永久池', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o2',
      userId: 'u1',
      kind: 'purchase',
      tierId: 't-min',
      amountCents: 5000,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 5000 }),
    });
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-min',
      kind: 'minutes',
      name: '600分钟包',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 5000, // 进账后余额足够
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });

    await creditPaidOrder('LLBUY');

    // 加永久时长池 600
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { purchasedMinutesBalance: { increment: 600 } } })
    );
    // 两笔台账：topup(+) 与 purchase_minutes(-)
    const types = walletTxCreateMock.mock.calls.map((c) => c[0].data.type);
    expect(types).toContain('topup');
    expect(types).toContain('purchase_minutes');
  });
});

describe('spendFromBalance：余额购买', () => {
  it('▶ 余额不足 → 抛 WalletError(insufficient_balance)', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't1',
      kind: 'minutes',
      name: 'x',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 100,
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });
    await expect(spendFromBalance('u1', 't1')).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('▶ 会员档位：扣余额 + 设 role/originalRole/roleExpiresAt + purchase_membership 台账', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-pro',
      kind: 'membership',
      name: 'PRO月卡',
      priceCents: 3000,
      grantRole: 'PRO',
      durationDays: 30,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 3000,
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });
    userUpdateMock.mockResolvedValue({ walletBalanceCents: 0 });

    await spendFromBalance('u1', 't-pro');

    // 第二次 user.update 应设 role=PRO、originalRole=FREE、roleExpiresAt 非空
    const roleUpdate = userUpdateMock.mock.calls.find(
      (c) => c[0].data?.role === 'PRO'
    );
    expect(roleUpdate).toBeTruthy();
    expect(roleUpdate?.[0].data.originalRole).toBe('FREE');
    expect(roleUpdate?.[0].data.roleExpiresAt).toBeInstanceOf(Date);
    expect(roleUpdate?.[0].data.customGroupId).toBeNull();
    const memberTx = walletTxCreateMock.mock.calls.find(
      (c) => c[0].data.type === 'purchase_membership'
    );
    expect(memberTx?.[0].data.amountCents).toBe(-3000);
  });

  it('▶ ADMIN 买会员 → 拒绝', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-pro',
      kind: 'membership',
      name: 'PRO',
      priceCents: 3000,
      grantRole: 'PRO',
      durationDays: 30,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 999999,
      role: 'ADMIN',
      originalRole: null,
      roleExpiresAt: null,
    });
    await expect(spendFromBalance('admin', 't-pro')).rejects.toMatchObject({
      code: 'admin_no_membership',
    });
  });
});

describe('adminAdjust：管理员手动调整', () => {
  it('▶ 同时加余额与时长 → admin_adjust 台账（含 minutesDelta）', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ walletBalanceCents: 500 });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 1500 });

    await adminAdjust({
      userId: 'u1',
      amountCentsDelta: 1000,
      minutesDelta: 200,
      note: '补偿',
      operatorId: 'admin-1',
    });

    expect(walletTxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'admin_adjust',
          amountCents: 1000,
          minutesDelta: 200,
          operatorId: 'admin-1',
          note: '补偿',
        }),
      })
    );
  });

  it('▶ 负向余额调整不减到负数（按当前余额截断）', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ walletBalanceCents: 300 });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 0 });

    await adminAdjust({ userId: 'u1', amountCentsDelta: -1000, operatorId: 'admin-1' });

    // 只扣 300（截断），台账 amountCents = -300
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletBalanceCents: { increment: -300 } } })
    );
    expect(walletTxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountCents: -300 }) })
    );
  });

  it('▶ 空调整 → 抛错', async () => {
    await expect(
      adminAdjust({ userId: 'u1', operatorId: 'admin-1' })
    ).rejects.toBeInstanceOf(WalletError);
  });
});
