import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  orderFindUniqueMock,
  orderUpdateManyMock,
  userFindUniqueMock,
  userUpdateMock,
  walletTxCreateMock,
  executeRawMock,
  queryRawMock,
  logSystemEventMock,
} = vi.hoisted(() => ({
  orderFindUniqueMock: vi.fn(),
  orderUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  walletTxCreateMock: vi.fn(),
  executeRawMock: vi.fn(),
  queryRawMock: vi.fn(),
  logSystemEventMock: vi.fn(),
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

import { handlePaymentReversal } from '@/lib/payment/refundHandling';

const MEMBERSHIP_ORDER = {
  id: 'o1',
  userId: 'u1',
  status: 'paid',
  refundedAt: null,
  amountCents: 3900,
  metadataJson: JSON.stringify({
    creditCents: 3900,
    grant: { kind: 'membership', durationDays: 30, tierId: 't1', tierName: 'PRO 月卡' },
  }),
};

const MINUTES_ORDER = {
  ...MEMBERSHIP_ORDER,
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
    logSystemEventMock,
  ]) {
    m.mockReset();
  }
  executeRawMock.mockResolvedValue(1);
  walletTxCreateMock.mockResolvedValue({});
  userUpdateMock.mockResolvedValue({});
  // M6：freezeEntitlements 的用户快照读改成 `SELECT … FOR UPDATE` 锁读（对齐 wallet.ts
  // applyGrantTx 的 P3-6）。替身把它接到 userFindUniqueMock，既有用例照旧用
  // userFindUniqueMock 配置「用户当前状态」即可（第一个 Once = 锁读，第二个 = 余额回读）。
  queryRawMock.mockImplementation(async () => {
    const row = await userFindUniqueMock();
    return row ? [row] : [];
  });
});

describe('handlePaymentReversal（P3-16）', () => {
  it('▶ 已付订单收到退款通知 → CAS 置 refunded + 冻结会员 + 记 refund 台账', async () => {
    orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
    orderUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 0,
        purchasedMinutesBalance: 0,
        role: 'PRO',
        originalRole: 'FREE',
        roleExpiresAt: new Date(Date.now() + 10 * 86_400_000), // 只剩 10 天，扣 30 天必翻负
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 });

    const res = await handlePaymentReversal({
      outTradeNo: 'LL1',
      provider: 'stripe',
      rawStatus: 'charge.refunded',
    });

    expect(res).toEqual({ handled: true, outcome: 'reversed' });

    // CAS 谓词必须同时锁 status=paid 与 refundedAt=null（幂等锚点）。
    expect(orderUpdateManyMock).toHaveBeenCalledWith({
      where: { outTradeNo: 'LL1', status: 'paid', refundedAt: null, provider: 'stripe' },
      data: expect.objectContaining({ status: 'refunded', refundedAt: expect.any(Date) }),
    });

    // 会员到期日已被扣穿 → 回落 originalRole 并 bump tokenVersion 让旧 JWT 失效。
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });

    // 余额冲正走 GREATEST(0, …)，绝不打成负数。
    expect(rawSql().some((s) => /GREATEST\(0, walletBalanceCents/.test(s))).toBe(true);

    expect(walletTxCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', type: 'refund', amountCents: -3900 }),
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
    expect(data.role).toBeUndefined();
    expect((data.roleExpiresAt as Date).getTime()).toBe(expiry.getTime() - 30 * 86_400_000);
  });

  it('▶ M6 用户行必须走 `SELECT … FOR UPDATE` 锁读（对齐 applyGrantTx 的 P3-6）', async () => {
    orderFindUniqueMock.mockResolvedValue(MEMBERSHIP_ORDER);
    orderUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 0,
        purchasedMinutesBalance: 0,
        role: 'PRO',
        originalRole: 'FREE',
        roleExpiresAt: new Date(Date.now() + 90 * 86_400_000),
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 });

    await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });

    // 结构闸：会员分支是读-改-写绝对值，快照读在并发下必然 lost update（行为证据见
    // refundHandling.concurrency.test.ts）。这里只锁住「锁读没有被人改回 findUnique」。
    const lockSql = queryRawMock.mock.calls.map((c) =>
      Array.isArray(c[0]) ? c[0].join('?') : String(c[0])
    );
    expect(lockSql.some((sql) => /FROM User WHERE id = \?\s*FOR UPDATE/.test(sql))).toBe(
      true
    );
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

  it('▶ 分钟档：回收永久池同样走 GREATEST 地板', async () => {
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

    expect(rawSql().some((s) => /GREATEST\(0, purchasedMinutesBalance/.test(s))).toBe(true);
    expect(walletTxCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ minutesDelta: -600 }),
    });
  });

  it('▶ 重复退款通知 → already，不再冲正第二次（幂等）', async () => {
    orderFindUniqueMock.mockResolvedValue({ ...MEMBERSHIP_ORDER, refundedAt: new Date() });
    orderUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'stripe' });
    expect(res).toEqual({ handled: true, outcome: 'already' });
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(queryRawMock).not.toHaveBeenCalled(); // 连锁读都不该发生
  });

  it('▶ 订单还在 pending（未到账）→ not_paid，不动任何权益', async () => {
    orderFindUniqueMock.mockResolvedValue({ ...MEMBERSHIP_ORDER, status: 'pending' });
    orderUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await handlePaymentReversal({ outTradeNo: 'LL1', provider: 'alipay' });
    expect(res.outcome).toBe('not_paid');
    expect(walletTxCreateMock).not.toHaveBeenCalled();
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'recharge.reversal.not_paid',
      expect.any(String)
    );
  });

  it('▶ 拒付通知拿不到我方订单号 → 告警到人，仍回可 ACK（重推也没用）', async () => {
    const res = await handlePaymentReversal({
      outTradeNo: '',
      provider: 'stripe',
      rawStatus: 'charge.dispute.created',
    });
    expect(res).toEqual({ handled: true, outcome: 'unknown_order' });
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'recharge.reversal.unresolved',
      expect.stringContaining('charge.dispute.created')
    );
    expect(orderFindUniqueMock).not.toHaveBeenCalled();
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
