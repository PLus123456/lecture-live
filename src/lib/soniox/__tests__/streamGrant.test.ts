import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R1-L2：Soniox 临时 key 预扣台账原语。核心不变量——
 *  - mint 闸门：签发前同事务收缩式预扣，key 的 max_session_duration_seconds=预扣分钟
 *    → 单 key 可串流量恒 ≤ 已预扣量；额度剩 0 拒发。
 *  - 结算互斥：settledAt 条件原子认领，多条结算路径并发时恰好一次释放预留。
 */

const {
  transactionMock,
  grantCreateMock,
  grantCountMock,
  grantAggregateMock,
  grantUpdateManyMock,
  queryRawMock,
  executeRawMock,
  reserveUpToMock,
  releaseMock,
  TX,
} = vi.hoisted(() => {
  const grantCreateMock = vi.fn();
  const grantUpdateManyMock = vi.fn();
  const queryRawMock = vi.fn();
  return {
    transactionMock: vi.fn(),
    grantCreateMock,
    grantCountMock: vi.fn(),
    grantAggregateMock: vi.fn(),
    grantUpdateManyMock,
    queryRawMock,
    executeRawMock: vi.fn(),
    reserveUpToMock: vi.fn(),
    releaseMock: vi.fn(),
    // $transaction 注入的 tx：预扣建行走 create；结算走 $queryRaw（FOR UPDATE）+ updateMany。
    TX: {
      $queryRaw: (...a: unknown[]) => queryRawMock(...a),
      sonioxStreamGrant: {
        create: grantCreateMock,
        updateMany: grantUpdateManyMock,
      },
    },
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...a: unknown[]) => transactionMock(...a),
    $queryRaw: (...a: unknown[]) => queryRawMock(...a),
    $executeRaw: (...a: unknown[]) => executeRawMock(...a),
    sonioxStreamGrant: {
      create: grantCreateMock,
      count: grantCountMock,
      aggregate: grantAggregateMock,
      updateMany: grantUpdateManyMock,
    },
  },
}));

vi.mock('@/lib/quota', () => ({
  reserveTranscriptionMinutesUpTo: reserveUpToMock,
  releaseTranscriptionMinutes: releaseMock,
}));

import {
  countActiveStreamGrants,
  createStreamGrantWithReservation,
  settleStreamGrants,
  STREAM_GRANT_ACTIVE_WINDOW_MS,
  STREAM_GRANT_MAX_MINUTES,
} from '@/lib/soniox/streamGrant';

beforeEach(() => {
  transactionMock.mockReset();
  grantCreateMock.mockReset();
  grantCountMock.mockReset();
  grantAggregateMock.mockReset();
  grantUpdateManyMock.mockReset();
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  reserveUpToMock.mockReset();
  releaseMock.mockReset();

  // 默认：$transaction 执行回调并注入 TX。
  transactionMock.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(TX)
  );
  reserveUpToMock.mockResolvedValue({ reservedMinutes: 15, role: 'FREE' });
  releaseMock.mockResolvedValue(undefined);
  grantCreateMock.mockResolvedValue({ id: 'g1' });
  grantUpdateManyMock.mockResolvedValue({ count: 0 });
  queryRawMock.mockResolvedValue([]);
  grantCountMock.mockResolvedValue(0);
  grantAggregateMock.mockResolvedValue({ _sum: { actualMs: null } });
});

describe('createStreamGrantWithReservation', () => {
  const INPUT = {
    userId: 'u1',
    kind: 'realtime' as const,
    sessionId: 's1',
    region: 'eu',
  };

  it('预扣成功（15 分钟全额）→ 同事务落 grant 行，连接上限 900s', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'FREE' });
    grantCreateMock.mockResolvedValueOnce({ id: 'g1' });

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({
      ok: true,
      grantId: 'g1',
      reservedMinutes: 15,
      maxSessionSeconds: 900,
    });
    // 预扣在 $transaction 注入的同一 tx 上执行（收缩式，最多 D=15）
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(reserveUpToMock).toHaveBeenCalledWith('u1', STREAM_GRANT_MAX_MINUTES, TX);
    expect(grantCreateMock).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        kind: 'realtime',
        sessionId: 's1',
        interpretSessionId: null,
        region: 'eu',
        reservedMinutes: 15,
        maxSessionSeconds: 900,
      },
      select: { id: true },
    });
  });

  it('额度只剩 3 分钟 → 收缩预扣 3，连接上限同步收缩为 180s', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 3, role: 'FREE' });

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({
      ok: true,
      grantId: 'g1',
      reservedMinutes: 3,
      maxSessionSeconds: 180,
    });
    expect(grantCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reservedMinutes: 3, maxSessionSeconds: 180 }),
      })
    );
  });

  it('额度耗尽（预扣到 0）→ quota_exhausted，不建 grant', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 0, role: 'FREE' });

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({ ok: false, reason: 'quota_exhausted' });
    expect(grantCreateMock).not.toHaveBeenCalled();
  });

  it('ADMIN → reservedMinutes 记 0（不占额度、结算释放 0），连接上限仍全额 900s', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'ADMIN' });

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({
      ok: true,
      grantId: 'g1',
      reservedMinutes: 0,
      maxSessionSeconds: 900,
    });
    expect(grantCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reservedMinutes: 0, maxSessionSeconds: 900 }),
      })
    );
  });

  it('用户不存在（reserveUpTo 返回 null）→ user_not_found，不建 grant', async () => {
    reserveUpToMock.mockResolvedValueOnce(null);

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({ ok: false, reason: 'user_not_found' });
    expect(grantCreateMock).not.toHaveBeenCalled();
  });
});

describe('settleStreamGrants', () => {
  it('按 sessionId 圈定两行未结 → 条件原子认领 + 恰好一次合并释放预留', async () => {
    queryRawMock.mockResolvedValueOnce([
      { id: 'g1', userId: 'u1', reservedMinutes: 15, actualMs: null },
      { id: 'g2', userId: 'u1', reservedMinutes: 10, actualMs: 60000 },
    ]);
    grantUpdateManyMock.mockResolvedValueOnce({ count: 2 });

    const r = await settleStreamGrants({ sessionId: 's1' }, 'session_finalize');

    expect(r).toEqual({ settledCount: 2, releasedMinutes: 25, actualMsTotal: 60000 });
    // 默认 db=prisma（带 $transaction）→ 自开事务保证 FOR UPDATE 生效
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // 锁行查询：按 sessionId 圈定且只挑未结行
    const sql = queryRawMock.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain('settledAt IS NULL');
    expect(sql.sql).toContain('FOR UPDATE');
    expect(sql.values).toEqual(['s1']);
    expect(grantUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['g1', 'g2'] }, settledAt: null },
      data: { settledAt: expect.any(Date), settledBy: 'session_finalize' },
    });
    // 同键 grants 恒属同一 user → 合并一次释放（15+10=25），且在同一 tx 上
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith('u1', 25, TX);
  });

  it('无未结行（已被别的路径结算）→ 全 0，不 updateMany 不释放；传入无 $transaction 的 tx 直接复用不再自开事务', async () => {
    const bareTx = {
      $queryRaw: (...a: unknown[]) => queryRawMock(...a),
      sonioxStreamGrant: { updateMany: grantUpdateManyMock },
    };
    queryRawMock.mockResolvedValueOnce([]);

    const r = await settleStreamGrants({ grantId: 'g1' }, 'usage_refund', bareTx as never);

    expect(r).toEqual({ settledCount: 0, releasedMinutes: 0, actualMsTotal: 0 });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(grantUpdateManyMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('reservedMinutes 已被月度重置清零 → 认领结算但释放 0（不吃新周期额度）', async () => {
    queryRawMock.mockResolvedValueOnce([
      { id: 'g1', userId: 'u1', reservedMinutes: 0, actualMs: null },
    ]);
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    const r = await settleStreamGrants({ grantId: 'g1' }, 'usage_cron');

    expect(r).toEqual({ settledCount: 1, releasedMinutes: 0, actualMsTotal: 0 });
    expect(grantUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });
});

describe('countActiveStreamGrants', () => {
  it('只数未结且 mintedAt 在活跃窗内（连接上限 15min + key TTL 60s + 时钟余量 120s）的 grant', async () => {
    const NOW = new Date('2026-07-16T12:00:00.000Z');
    grantCountMock.mockResolvedValueOnce(2);

    const n = await countActiveStreamGrants('u1', NOW);

    expect(n).toBe(2);
    expect(STREAM_GRANT_ACTIVE_WINDOW_MS).toBe((15 * 60 + 60 + 120) * 1000);
    expect(grantCountMock).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        settledAt: null,
        mintedAt: { gte: new Date(NOW.getTime() - STREAM_GRANT_ACTIVE_WINDOW_MS) },
      },
    });
  });
});
