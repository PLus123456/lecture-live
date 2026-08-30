import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  orderFindUniqueMock,
  orderUpdateManyMock,
  userFindUniqueMock,
  userUpdateMock,
  walletTxCreateMock,
  executeRawMock,
  queryRawMock,
  entitlementQueryMock,
  fundingLotQueryMock,
  allocationQueryMock,
  debtQueryMock,
  logSystemEventMock,
  resolveRoleQuotasMock,
  resolveRoleStorageBytesLimitMock,
  settlePoolOnLimitChangeMock,
} = vi.hoisted(() => ({
  orderFindUniqueMock: vi.fn(),
  orderUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  walletTxCreateMock: vi.fn(),
  executeRawMock: vi.fn(),
    queryRawMock: vi.fn(),
    entitlementQueryMock: vi.fn(),
    fundingLotQueryMock: vi.fn(),
    allocationQueryMock: vi.fn(),
    debtQueryMock: vi.fn(),
  logSystemEventMock: vi.fn(),
  resolveRoleQuotasMock: vi.fn(),
  resolveRoleStorageBytesLimitMock: vi.fn(),
  settlePoolOnLimitChangeMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    paymentOrder: { findUnique: orderFindUniqueMock, updateMany: orderUpdateManyMock },
    user: { findUnique: userFindUniqueMock, update: userUpdateMock },
    walletTransaction: { create: walletTxCreateMock },
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
  };
  return {
    prisma: { ...tx, $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) },
  };
});

vi.mock('@/lib/auditLog', () => ({ logSystemEvent: logSystemEventMock }));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: resolveRoleQuotasMock,
  resolveRoleStorageBytesLimit: resolveRoleStorageBytesLimitMock,
}));
vi.mock('@/lib/quota', () => ({ settlePoolOnLimitChange: settlePoolOnLimitChangeMock }));

import { handlePaymentReversal } from '@/lib/payment/refundHandling';

const MEMBERSHIP_ORDER = {
  id: 'o1',
  userId: 'u1',
  provider: 'stripe',
  kind: 'purchase',
  status: 'paid',
  fulfillmentStatus: 'fulfilled',
  refundedAt: null,
  amountCents: 3900,
  currency: 'USD',
  metadataJson: JSON.stringify({
    creditCents: 3900,
    grant: { kind: 'membership', durationDays: 30, tierId: 't1', tierName: 'PRO 月卡' },
  }),
};

const MINUTES_ORDER = {
  ...MEMBERSHIP_ORDER,
  provider: 'wechat',
  amountCents: 1000,
  metadataJson: JSON.stringify({
    creditCents: 1000,
    grant: { kind: 'minutes', grantMinutes: 600, tierId: 't2', tierName: '600 分钟' },
  }),
};

/** 事务里的 $executeRaw 拿到的 SQL 模板（Prisma 标签模板 → 第一参是字符串片段数组）。 */
const rawSql = () =>
  executeRawMock.mock.calls.map((c) => (Array.isArray(c[0]) ? c[0].join('?') : String(c[0])));

beforeEach(() => {
  for (const m of [
    orderFindUniqueMock,
    orderUpdateManyMock,
    userFindUniqueMock,
    userUpdateMock,
    walletTxCreateMock,
    executeRawMock,
    queryRawMock,
    entitlementQueryMock,
    fundingLotQueryMock,
    allocationQueryMock,
    debtQueryMock,
    logSystemEventMock,
    resolveRoleQuotasMock,
    resolveRoleStorageBytesLimitMock,
    settlePoolOnLimitChangeMock,
  ]) {
    m.mockReset();
  }
  executeRawMock.mockResolvedValue(1);
  walletTxCreateMock.mockResolvedValue({});
  userUpdateMock.mockResolvedValue({});
  resolveRoleQuotasMock.mockResolvedValue({
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 10,
    allowedModels: 'local',
  });
  resolveRoleStorageBytesLimitMock.mockResolvedValue(BigInt(1024));
  settlePoolOnLimitChangeMock.mockResolvedValue(undefined);
  entitlementQueryMock.mockResolvedValue([
    {
      id: 'ent-1',
      userId: 'u1',
      kind: 'membership',
      grantRole: 'PRO',
      totalUnits: 30,
      revokedUnits: 0,
      status: 'active',
      grantedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ]);
  fundingLotQueryMock.mockResolvedValue([
    {
      id: 'lot-1',
      userId: 'u1',
      originalCents: 3900,
      remainingCents: 0,
      status: 'active',
    },
  ]);
  allocationQueryMock.mockResolvedValue([
    {
      id: 'alloc-1',
      fundingLotId: 'lot-1',
      userId: 'u1',
      spendTransactionId: 'spend-1',
      entitlementId: 'ent-1',
      targetKind: 'membership',
      amountCents: 3900,
      entitlementUnits: 30,
      recoveredUnits: 0,
      debtCents: 0,
      reversedAt: null,
    },
  ]);
  debtQueryMock.mockResolvedValue([{ id: 'debt-1' }]);
  queryRawMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = String(strings);
    if (/FROM PaymentOrder/i.test(sql)) {
      const order = await orderFindUniqueMock();
      return order ? [order] : [];
    }
    if (/FROM User/i.test(sql)) {
      const user = await userFindUniqueMock();
      return user ? [user] : [];
    }
    if (/FROM WalletFundingLot/i.test(sql)) return fundingLotQueryMock();
    if (/FROM WalletFundingAllocation/i.test(sql)) return allocationQueryMock();
    if (/FROM PaymentEntitlement/i.test(sql)) return entitlementQueryMock();
    if (/FROM PaymentDebt/i.test(sql)) return debtQueryMock();
    return [];
  });
});

describe('handlePaymentReversal（P3-16）', () => {
  it('▶ 已付订单收到退款通知 → order/user 行锁内置 reversed + 冻结会员 + 记账', async () => {
    orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
    orderUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 0,
        purchasedMinutesBalance: 100,
        role: 'PRO',
        originalRole: 'FREE',
        roleExpiresAt: new Date(Date.now() + 10 * 86_400_000), // 只剩 10 天，扣 30 天必翻负
        transcriptionMinutesLimit: 600,
      })
      .mockResolvedValueOnce({ purchasedMinutesBalance: 100 });

    const res = await handlePaymentReversal({
      outTradeNo: 'LL1',
      provider: 'stripe',
      rawStatus: 'charge.refunded',
      reversalAmountCents: 3900,
      fullReversal: true,
      currency: 'USD',
    });

    expect(res).toEqual({ handled: true, outcome: 'reversed' });

    expect(queryRawMock.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /FROM PaymentOrder[\s\S]*FOR UPDATE[\s\S]*FROM User[\s\S]*FOR UPDATE/i
    );

    // 会员到期日已被扣穿 → 回落 originalRole 并 bump tokenVersion 让旧 JWT 失效。
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
        customGroupId: null,
        transcriptionMinutesLimit: 60,
        storageHoursLimit: 10,
        allowedModels: 'local',
        storageBytesLimit: BigInt(1024),
        tokenVersion: { increment: 1 },
      },
    });
    expect(settlePoolOnLimitChangeMock).toHaveBeenCalledWith(
      'u1',
      600,
      60,
      expect.anything()
    );

    // Direct purchase already spent its same-transaction credit; reversal must not double-deduct
    // unrelated wallet funds.
    expect(rawSql().some((s) => /GREATEST\(0, walletBalanceCents/.test(s))).toBe(false);

    expect(walletTxCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', type: 'refund', amountCents: 0 }),
    });
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'recharge.reversal.applied',
      expect.stringContaining('LL1')
    );
  });

  it('▶ 会员剩余期长于本单天数 → 只缩回到期日，不降级', async () => {
    orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
    orderUpdateManyMock.mockResolvedValue({ count: 1 });
    const expiry = new Date(Date.now() + 90 * 86_400_000);
    const target = {
      id: 'ent-1', userId: 'u1', kind: 'membership', grantRole: 'PRO',
      totalUnits: 30, revokedUnits: 0, status: 'active',
      grantedAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    entitlementQueryMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([
        target,
        {
          id: 'ent-remaining', userId: 'u1', kind: 'membership', grantRole: 'PRO',
          totalUnits: 60, revokedUnits: 0, status: 'active',
          grantedAt: new Date('2026-07-02T00:00:00.000Z'),
        },
      ]);
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 0,
        purchasedMinutesBalance: 0,
        role: 'PRO',
        originalRole: 'FREE',
        roleExpiresAt: expiry,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 });

    await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });

    const data = userUpdateMock.mock.calls[0][0].data;
    expect(data.role).toBe('PRO');
    expect((data.roleExpiresAt as Date).getTime()).toBe(expiry.getTime() - 30 * 86_400_000);
  });

  it('▶ 会员只剩分数天时按实际剩余时间估值，不用 ceil 少记债务', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-20T00:00:00.000Z');
    vi.setSystemTime(now);
    try {
      orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
      userFindUniqueMock.mockResolvedValueOnce({
        walletBalanceCents: 0,
        purchasedMinutesBalance: 0,
        role: 'PRO',
        originalRole: 'FREE',
        roleExpiresAt: new Date(now.getTime() + 10.5 * 86_400_000),
      });

      await expect(
        handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' })
      ).resolves.toEqual({ handled: true, outcome: 'reversed' });

      const allocationUpdate = executeRawMock.mock.calls.find((call) =>
        /UPDATE WalletFundingAllocation/.test(String(call[0]))
      );
      // 10.5 / 30 of ¥39 = ¥13.65 recovered; the remaining ¥25.35 is durable debt.
      expect(allocationUpdate).toEqual(
        expect.arrayContaining([10, 2535, 'alloc-1'])
      );
      expect(
        executeRawMock.mock.calls.some(
          (call) => /INSERT INTO PaymentDebt/.test(String(call[0])) && call.includes(2535)
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('▶ ADMIN 永不被退款降级', async () => {
    orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
    orderUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 0,
        purchasedMinutesBalance: 0,
        role: 'ADMIN',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 });

    await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('▶ 分钟档：只回收仍在池中的归属分钟，差额记债且不打负', async () => {
    entitlementQueryMock.mockResolvedValueOnce([
      {
        id: 'ent-min',
        userId: 'u1',
        kind: 'minutes',
        totalUnits: 600,
        revokedUnits: 0,
        status: 'active',
      },
    ]);
    fundingLotQueryMock.mockResolvedValueOnce([
      {
        id: 'lot-min',
        userId: 'u1',
        originalCents: 1000,
        remainingCents: 0,
        status: 'active',
      },
    ]);
    allocationQueryMock.mockResolvedValueOnce([
      {
        id: 'alloc-min',
        fundingLotId: 'lot-min',
        userId: 'u1',
        spendTransactionId: 'spend-min',
        entitlementId: 'ent-min',
        targetKind: 'minutes',
        amountCents: 1000,
        entitlementUnits: 600,
        recoveredUnits: 0,
        debtCents: 0,
        reversedAt: null,
      },
    ]);
    orderFindUniqueMock.mockResolvedValue(MINUTES_ORDER);
    orderUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 500,
        purchasedMinutesBalance: 100,
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 });

    await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'wechat' });

    expect(rawSql().some((s) => /purchasedMinutesBalance = purchasedMinutesBalance -/.test(s))).toBe(
      true
    );
    expect(walletTxCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ minutesDelta: -100, amountCents: 0 }),
    });
    expect(rawSql().some((s) => /INSERT INTO PaymentDebt/.test(s))).toBe(true);
    expect(rawSql().some((s) => /INSERT INTO PaymentAccountHold/.test(s))).toBe(true);
  });

  it('▶ 未消费 topup 只扣该批次剩余，不动其他批次且余额不为负', async () => {
    orderFindUniqueMock.mockResolvedValue({
      ...MEMBERSHIP_ORDER,
      kind: 'topup',
      amountCents: 1000,
      metadataJson: JSON.stringify({ creditCents: 1200 }),
    });
    fundingLotQueryMock.mockResolvedValueOnce([
      {
        id: 'lot-topup',
        userId: 'u1',
        originalCents: 1200,
        remainingCents: 1200,
        status: 'active',
      },
    ]);
    allocationQueryMock.mockResolvedValueOnce([]);
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 1700,
      purchasedMinutesBalance: 0,
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });

    await expect(
      handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' })
    ).resolves.toEqual({ handled: true, outcome: 'reversed' });

    const walletUpdateIndex = rawSql().findIndex((s) =>
      /walletBalanceCents = walletBalanceCents -/.test(s)
    );
    expect(walletUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(executeRawMock.mock.calls[walletUpdateIndex]).toEqual(
      expect.arrayContaining([1200, 'u1', 1200])
    );
    expect(walletTxCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: -1200, balanceAfterCents: 500 }),
    });
    expect(rawSql().some((s) => /INSERT INTO PaymentDebt/.test(s))).toBe(false);
  });

  it('▶ 多批次共同购买会员：只撤销被拒付 lot 分摊的精确天数', async () => {
    orderFindUniqueMock.mockResolvedValue({
      ...MEMBERSHIP_ORDER,
      kind: 'topup',
      amountCents: 1000,
      metadataJson: JSON.stringify({ creditCents: 1000 }),
    });
    fundingLotQueryMock.mockResolvedValueOnce([
      {
        id: 'lot-a',
        userId: 'u1',
        originalCents: 1000,
        remainingCents: 0,
        status: 'active',
      },
    ]);
    allocationQueryMock.mockResolvedValueOnce([
      {
        id: 'alloc-a',
        fundingLotId: 'lot-a',
        userId: 'u1',
        spendTransactionId: 'mixed-membership-spend',
        entitlementId: 'ent-mixed',
        targetKind: 'membership',
        amountCents: 1000,
        entitlementUnits: 10,
        recoveredUnits: 0,
        debtCents: 0,
        reversedAt: null,
      },
    ]);
    entitlementQueryMock.mockResolvedValueOnce([
      {
        id: 'ent-mixed',
        userId: 'u1',
        kind: 'membership',
        grantRole: 'PRO',
        totalUnits: 30,
        revokedUnits: 0,
        status: 'active',
        grantedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]).mockResolvedValueOnce([
      {
        id: 'ent-mixed',
        userId: 'u1',
        kind: 'membership',
        grantRole: 'PRO',
        totalUnits: 30,
        revokedUnits: 0,
        status: 'active',
        grantedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);
    const expiry = new Date(Date.now() + 90 * 86_400_000);
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 0,
      purchasedMinutesBalance: 0,
      role: 'PRO',
      originalRole: 'FREE',
      roleExpiresAt: expiry,
    });

    await expect(
      handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' })
    ).resolves.toEqual({ handled: true, outcome: 'reversed' });

    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        role: 'PRO',
        originalRole: 'FREE',
        roleExpiresAt: new Date(expiry.getTime() - 10 * 86_400_000),
        customGroupId: null,
        transcriptionMinutesLimit: 60,
        storageHoursLimit: 10,
        allowedModels: 'local',
        storageBytesLimit: BigInt(1024),
        tokenVersion: { increment: 1 },
      },
    });
    const entitlementUpdate = executeRawMock.mock.calls.find((call) =>
      /UPDATE PaymentEntitlement/.test(String(call[0]))
    );
    expect(entitlementUpdate).toEqual(expect.arrayContaining([10, 'ent-mixed']));
    expect(rawSql().some((s) => /INSERT INTO PaymentDebt/.test(s))).toBe(false);
  });

  it('▶ 存量 paid 订单没有 lot：不猜测扣聚合余额，债务+冻结+review', async () => {
    orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
    fundingLotQueryMock.mockResolvedValueOnce([]);
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 9000,
      purchasedMinutesBalance: 0,
      role: 'PRO',
      originalRole: 'FREE',
      roleExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });

    await expect(
      handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' })
    ).resolves.toEqual({ handled: false, outcome: 'review' });

    expect(rawSql().some((s) => /walletBalanceCents\s*=/.test(s))).toBe(false);
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(rawSql().some((s) => /INSERT INTO PaymentDebt/.test(s))).toBe(true);
    expect(rawSql().some((s) => /INSERT INTO PaymentAccountHold/.test(s))).toBe(true);
    expect(rawSql().some((s) => /fulfillmentStatus = 'review'/.test(s))).toBe(true);
    expect(rawSql().some((s) => /reviewReason = 'reversal_provenance_unresolved'/.test(s))).toBe(true);
  });

  it('▶ 历史 paid+review purchase 可能保留到账余额：保守记债冻结并终态化退款', async () => {
    orderFindUniqueMock.mockResolvedValue({
      ...MEMBERSHIP_ORDER,
      fulfillmentStatus: 'review',
      reviewReason: 'legacy_fulfillment_unresolved',
    });
    userFindUniqueMock.mockResolvedValueOnce({ id: 'u1' });

    await expect(
      handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' })
    ).resolves.toEqual({ handled: false, outcome: 'review' });

    expect(rawSql().some((s) => /INSERT INTO PaymentDebt/.test(s))).toBe(true);
    expect(rawSql().some((s) => /INSERT INTO PaymentAccountHold/.test(s))).toBe(true);
    expect(rawSql().join('\n')).toMatch(
      /status = 'refunded'[\s\S]*reviewReason = 'reversal_provenance_unresolved'/
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('▶ 资金守恒式或归属破坏：整单人审，不做半套自动追缴', async () => {
    orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
    fundingLotQueryMock.mockResolvedValueOnce([
      {
        id: 'lot-bad',
        userId: 'another-user',
        originalCents: 3900,
        remainingCents: 0,
        status: 'active',
      },
    ]);
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 3900,
      purchasedMinutesBalance: 0,
      role: 'PRO',
      originalRole: 'FREE',
      roleExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });

    const result = await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });

    expect(result).toEqual({ handled: false, outcome: 'review' });
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(
      executeRawMock.mock.calls.some((call) => call.includes('funding_provenance_invalid'))
    ).toBe(true);
    expect(rawSql().some((s) => /INSERT INTO PaymentDebt/.test(s))).toBe(true);
  });

  it('▶ 重复退款通知 → already，不再冲正第二次（幂等）', async () => {
    orderFindUniqueMock.mockResolvedValue({ ...MEMBERSHIP_ORDER, refundedAt: new Date() });
    orderUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });
    expect(res).toEqual({ handled: true, outcome: 'already' });
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('▶ 乱序：反向通知先于到账 → 锁内终态化，不给后到支付留下发放窗口', async () => {
    orderFindUniqueMock.mockResolvedValue({
      ...MEMBERSHIP_ORDER,
      provider: 'alipay',
      status: 'pending',
      fulfillmentStatus: 'pending',
      reviewReason: null,
    });
    orderUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'alipay' });
    expect(res).toEqual({ handled: true, outcome: 'reversed' });
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(rawSql().join('\n')).toMatch(
      /SET status = 'refunded'[\s\S]*fulfillmentStatus = 'reversed'/i
    );
  });

  it('▶ 已回滚的 fulfillment failure 收到反向事件 → 可证明未发权益并安全终态化', async () => {
    orderFindUniqueMock.mockResolvedValue({
      ...MEMBERSHIP_ORDER,
      status: 'pending',
      fulfillmentStatus: 'review',
      reviewReason: 'fulfillment_failed_uncommitted',
    });

    await expect(
      handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' })
    ).resolves.toEqual({ handled: true, outcome: 'reversed' });
    expect(rawSql().join('\n')).toMatch(
      /status = 'refunded'[\s\S]*fulfillmentStatus = 'reversed'/
    );
    expect(rawSql().some((s) => /INSERT INTO PaymentDebt/.test(s))).toBe(false);
  });

  it('▶ 旧数据 paid+review 无法证明是否曾发放 → 不成功 ACK，等待重试/人审', async () => {
    orderFindUniqueMock.mockResolvedValue({
      ...MEMBERSHIP_ORDER,
      status: 'paid',
      fulfillmentStatus: 'review',
      reviewReason: null,
    });

    const res = await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });

    expect(res).toEqual({ handled: false, outcome: 'not_paid' });
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'recharge.reversal.not_paid',
      expect.any(String)
    );
  });

  it('▶ 拒付通知拿不到我方订单号 → 告警并拒绝 ACK，让 durable inbox 保持重试/人审', async () => {
    const res = await handlePaymentReversal({
      outTradeNo: '',
      provider: 'stripe',
      rawStatus: 'charge.dispute.created',
    });
    expect(res).toEqual({ handled: false, outcome: 'unknown_order' });
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'recharge.reversal.unresolved',
      expect.stringContaining('charge.dispute.created')
    );
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('▶ 我方处理抛错 → handled=false，让网关重投（CAS 幂等，重投安全）', async () => {
    orderFindUniqueMock.mockRejectedValue(new Error('db down'));
    const res = await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });
    expect(res.handled).toBe(false);
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'recharge.reversal.failed',
      expect.any(String)
    );
  });
});
