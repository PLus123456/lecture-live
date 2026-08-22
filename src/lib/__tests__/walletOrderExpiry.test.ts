import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 未支付订单回收（PaymentOrder.expiresAt 死列）与「晚到回调仍能入账」的防资损闸。
 *
 * 这里**没有**用固定返回值的 updateMany 替身 —— 那样的替身对 where 谓词完全不敏感，
 * 把认领 CAS 改回只认 pending 测试照样绿（本项目历史上出过 4 次这种假测试）。
 * 改为一个会真正按 where 过滤行、并把 data 写回行的极小内存表：谓词写错就必然红。
 */

type OrderRow = {
  id: string;
  userId: string;
  provider: string;
  kind: string;
  tierId: string | null;
  outTradeNo: string;
  providerRef: string | null;
  amountCents: number;
  currency: string;
  status: string;
  paidAt: Date | null;
  refundedAt: Date | null;
  metadataJson: string | null;
  createdAt: Date;
  expiresAt: Date | null;
};

const {
  orderRows,
  paymentOrder,
  userUpdateMock,
  walletTxCreateMock,
  userFindUniqueMock,
  logSystemEventMock,
} = vi.hoisted(() => {
  const rows: OrderRow[] = [];

  /** 支持本文件用到的全部 Prisma 谓词形态：标量相等、{ in }、{ lt }、{ not: null }。 */
  const matchesWhere = (row: OrderRow, where: Record<string, unknown>): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as { in?: unknown[]; lt?: Date; not?: unknown };
        if ('in' in c && !c.in!.includes(actual)) return false;
        if ('lt' in c) {
          if (!(actual instanceof Date)) return false;
          if (!(actual.getTime() < c.lt!.getTime())) return false;
        }
        if ('not' in c) {
          if (c.not === null ? actual === null || actual === undefined : actual === c.not) {
            return false;
          }
        }
        continue;
      }
      if (actual !== cond) return false;
    }
    return true;
  };

  return {
    orderRows: rows,
    userUpdateMock: vi.fn(),
    walletTxCreateMock: vi.fn(),
    userFindUniqueMock: vi.fn(),
    logSystemEventMock: vi.fn(),
    paymentOrder: {
      // 返回**副本**：真实 Prisma 里 findUnique 拿到的是快照，认领 CAS 之后不会自己变。
      // 返回活引用会让「认领前状态」被后续 update 悄悄改写，掩盖幂等判定的错误。
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const hit = rows.find((r) => matchesWhere(r, where));
        return hit ? { ...hit } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = rows.filter((r) => matchesWhere(r, where));
          hits.forEach((r) => Object.assign(r, data));
          return { count: hits.length };
        }
      ),
      create: vi.fn(),
    },
  };
});

vi.mock('@/lib/prisma', () => {
  const tx = {
    paymentOrder,
    user: { update: userUpdateMock, updateMany: vi.fn(), findUnique: userFindUniqueMock },
    walletTransaction: { create: walletTxCreateMock, findFirst: vi.fn(async () => null) },
    rechargeTier: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  };
  return { prisma: { ...tx, $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) } };
});

vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: vi.fn(),
  resolveRoleStorageBytesLimit: vi.fn(),
}));
vi.mock('@/lib/quota', () => ({ settlePoolOnLimitChange: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logSystemEvent: logSystemEventMock }));
vi.mock('@/lib/email', () => ({ sendSubscriptionSuccessEmail: vi.fn(async () => ({ ok: true })) }));

import {
  creditPaidOrder,
  expireStalePaymentOrders,
  PAYMENT_ORDER_EXPIRE_GRACE_MS,
} from '@/lib/wallet';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function seedOrder(patch: Partial<OrderRow> = {}): OrderRow {
  const row: OrderRow = {
    id: 'o1',
    userId: 'u1',
    provider: 'alipay',
    kind: 'topup',
    tierId: null,
    outTradeNo: 'LL_TEST_1',
    providerRef: null,
    amountCents: 3900,
    currency: 'CNY',
    status: 'pending',
    paidAt: null,
    refundedAt: null,
    metadataJson: JSON.stringify({ creditCents: 3900 }),
    createdAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60_000),
    expiresAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60_000 + 30 * 60_000),
    ...patch,
  };
  orderRows.push(row);
  return row;
}

beforeEach(() => {
  orderRows.length = 0;
  paymentOrder.findUnique.mockClear();
  paymentOrder.updateMany.mockClear();
  userUpdateMock.mockReset().mockResolvedValue({ walletBalanceCents: 3900 });
  walletTxCreateMock.mockReset().mockResolvedValue({});
  userFindUniqueMock.mockReset().mockResolvedValue(null);
  logSystemEventMock.mockReset();
});

describe('expireStalePaymentOrders', () => {
  it('只回收超过 expiresAt + 宽限期的 pending 订单', async () => {
    const stale = seedOrder({ id: 'stale', outTradeNo: 'LL_STALE' });
    // 刚过 expiresAt 但还在 72h 宽限期内 —— 网关这时仍可能重投，绝不能扫。
    const fresh = seedOrder({
      id: 'fresh',
      outTradeNo: 'LL_FRESH',
      expiresAt: new Date(NOW.getTime() - 60 * 60_000),
    });

    const count = await expireStalePaymentOrders({ now: NOW });

    expect(count).toBe(1);
    expect(stale.status).toBe('expired');
    expect(fresh.status).toBe('pending');
  });

  it('绝不覆写已决终态（paid / failed / canceled / refunded）', async () => {
    const ancient = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
    const decided = ['paid', 'failed', 'canceled', 'refunded'].map((status, i) =>
      seedOrder({ id: `d${i}`, outTradeNo: `LL_D${i}`, status, expiresAt: ancient })
    );

    const count = await expireStalePaymentOrders({ now: NOW });

    expect(count).toBe(0);
    expect(decided.map((r) => r.status)).toEqual(['paid', 'failed', 'canceled', 'refunded']);
  });

  it('expiresAt 为 NULL 的历史行不参与回收', async () => {
    const legacy = seedOrder({ expiresAt: null });
    await expireStalePaymentOrders({ now: NOW });
    expect(legacy.status).toBe('pending');
  });

  it('宽限期默认 ≥ 网关最长重投窗口（Stripe 约 3 天），且远大于建单 TTL', async () => {
    expect(PAYMENT_ORDER_EXPIRE_GRACE_MS).toBeGreaterThanOrEqual(72 * 60 * 60_000);
    expect(PAYMENT_ORDER_EXPIRE_GRACE_MS).toBeGreaterThan(30 * 60_000);
  });
});

describe('creditPaidOrder：已被清扫成 expired 的订单遇到晚到回调', () => {
  it('★ 防资损闸：仍然恰好入账一次', async () => {
    const row = seedOrder();

    // 清扫器先跑（订单进入 expired）——这正是「直觉修法」会造成净资损的那一刻。
    expect(await expireStalePaymentOrders({ now: NOW })).toBe(1);
    expect(row.status).toBe('expired');

    // 网关重投窗口内晚到的真实回调。
    const result = await creditPaidOrder('LL_TEST_1', 'ALI_REF_1', 'alipay', 3900, 'CNY');

    expect(result).toMatchObject({ ok: true, alreadyProcessed: false, status: 'paid' });
    expect(row.status).toBe('paid');
    expect(row.paidAt).toBeInstanceOf(Date);
    // 钱恰好进一次
    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { walletBalanceCents: { increment: 3900 } },
      })
    );
    expect(walletTxCreateMock).toHaveBeenCalledTimes(1);
  });

  it('★ 入账后重复回调不再二次到账（幂等未被放宽破坏）', async () => {
    seedOrder();
    await expireStalePaymentOrders({ now: NOW });

    await creditPaidOrder('LL_TEST_1', 'ALI_REF_1', 'alipay', 3900, 'CNY');
    const again = await creditPaidOrder('LL_TEST_1', 'ALI_REF_1', 'alipay', 3900, 'CNY');

    expect(again).toMatchObject({ ok: true, alreadyProcessed: true, status: 'paid' });
    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    expect(walletTxCreateMock).toHaveBeenCalledTimes(1);
  });

  it('expired 订单同样受金额对账约束（放宽的只是状态，不是校验）', async () => {
    const row = seedOrder();
    await expireStalePaymentOrders({ now: NOW });

    const result = await creditPaidOrder('LL_TEST_1', 'ALI_REF_1', 'alipay', 1, 'CNY');

    expect(result.ok).toBe(false);
    expect(row.status).toBe('expired'); // 不认领，状态保持
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('已退款的 expired 订单绝不复活', async () => {
    const row = seedOrder({ refundedAt: new Date(NOW.getTime() - 60_000), status: 'expired' });

    const result = await creditPaidOrder('LL_TEST_1', 'ALI_REF_1', 'alipay', 3900, 'CNY');

    expect(result.ok).toBe(false);
    expect(row.status).toBe('expired');
    expect(userUpdateMock).not.toHaveBeenCalled();
  });
});

describe('creditPaidOrder：主动判定的终态不被放宽复活', () => {
  it.each(['failed', 'canceled'])('%s 订单的晚到回调不入账', async (status) => {
    const row = seedOrder({ status });

    const result = await creditPaidOrder('LL_TEST_1', 'ALI_REF_1', 'alipay', 3900, 'CNY');

    expect(result).toMatchObject({ ok: false, alreadyProcessed: true, status });
    expect(row.status).toBe(status);
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(walletTxCreateMock).not.toHaveBeenCalled();
  });
});
