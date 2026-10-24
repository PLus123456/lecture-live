import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  txGrantCountMock,
  txGrantFindManyMock,
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
  const txGrantCountMock = vi.fn();
  const txGrantFindManyMock = vi.fn();
  return {
    transactionMock: vi.fn(),
    grantCreateMock,
    grantCountMock: vi.fn(),
    txGrantCountMock,
    txGrantFindManyMock,
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
        // L19：并发流数闸移进预扣事务后，tx 也要能 count。
        count: txGrantCountMock,
        // 单场时长闸：同一事务里读本场已有 grants。
        findMany: txGrantFindManyMock,
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
  estimateCommittedStreamMs,
  settleStreamGrants,
  streamDurationCapMs,
  STREAM_GRANT_ACTIVE_WINDOW_MS,
  STREAM_GRANT_MAX_MINUTES,
  type StreamGrantUsageRow,
} from '@/lib/soniox/streamGrant';

beforeEach(() => {
  transactionMock.mockReset();
  grantCreateMock.mockReset();
  grantCountMock.mockReset();
  txGrantCountMock.mockReset();
  txGrantFindManyMock.mockReset();
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
  txGrantCountMock.mockResolvedValue(0);
  txGrantFindManyMock.mockResolvedValue([]);
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
      { id: 'g1', userId: 'u1', reservedMinutes: 15, actualMs: null, maxSessionSeconds: 900 },
      { id: 'g2', userId: 'u1', reservedMinutes: 10, actualMs: 60000, maxSessionSeconds: 600 },
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

  it('actualMsTotal 逐条封顶到各自连接硬上限（deduct 拿它当计费下限，防对账侧异常大值）', async () => {
    queryRawMock.mockResolvedValueOnce([
      { id: 'g1', userId: 'u1', reservedMinutes: 15, actualMs: 9 * 60 * 60_000, maxSessionSeconds: 900 },
      { id: 'g2', userId: 'u1', reservedMinutes: 15, actualMs: 120_000, maxSessionSeconds: 900 },
    ]);
    grantUpdateManyMock.mockResolvedValueOnce({ count: 2 });

    const r = await settleStreamGrants({ interpretSessionId: 'i1' }, 'interpret_deduct');

    expect(r.actualMsTotal).toBe(900_000 + 120_000);
    const sql = queryRawMock.mock.calls[0][0] as { sql: string };
    expect(sql.sql).toContain('maxSessionSeconds');
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

describe('L19 并发流数闸必须在预扣事务内生效', () => {
  const INPUT = {
    userId: 'u1',
    kind: 'realtime' as const,
    sessionId: 's1',
    region: 'eu',
  };

  it('不传 maxActiveGrants → 完全不查（保持旧行为，路由不传时零影响）', async () => {
    const r = await createStreamGrantWithReservation(INPUT);

    expect(r.ok).toBe(true);
    expect(txGrantCountMock).not.toHaveBeenCalled();
  });

  it('事务内数到已达上限 → 拒发，且**不留下悬挂预扣**（必须靠抛错回滚，不能 return）', async () => {
    // 路由那道 countActiveStreamGrants 预检读到的是旧计数（并发脚本可以让 N 个请求同时通过），
    // 真正的闸在预扣事务里 —— 上面 reserveTranscriptionMinutesUpTo 已对用户行 FOR UPDATE，
    // 到这里同一用户的并发 mint 已被串行化，「数一遍 + 建行」才是原子的。
    txGrantCountMock.mockResolvedValueOnce(7);

    let rolledBack = false;
    transactionMock.mockImplementationOnce(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        try {
          return await cb(TX);
        } catch (err) {
          // Prisma 只在回调**抛出**时回滚；正常 return 一律提交。预扣此刻已写进 used，
          // 若实现用 return 表达「拒发」，这笔预留就会被提交、且永远没人释放。
          rolledBack = true;
          throw err;
        }
      }
    );

    const r = await createStreamGrantWithReservation({
      ...INPUT,
      maxActiveGrants: 7,
    });

    expect(r).toEqual({ ok: false, reason: 'too_many_streams' });
    expect(rolledBack).toBe(true);
    expect(grantCreateMock).not.toHaveBeenCalled();
  });

  it('事务内数到未达上限 → 正常签发', async () => {
    txGrantCountMock.mockResolvedValueOnce(6);

    const r = await createStreamGrantWithReservation({
      ...INPUT,
      maxActiveGrants: 7,
    });

    expect(r.ok).toBe(true);
    expect(txGrantCountMock).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        settledAt: null,
        mintedAt: { gte: expect.any(Date) },
      },
    });
    expect(grantCreateMock).toHaveBeenCalled();
  });
});

describe('estimateCommittedStreamMs（单场时长闸的口径）', () => {
  const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
  const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000);
  const row = (
    overrides: Partial<StreamGrantUsageRow> & { mintedAt: Date }
  ): StreamGrantUsageRow => ({
    maxSessionSeconds: 900,
    actualMs: null,
    settledBy: null,
    ...overrides,
  });

  it('实测优先；签发失败 / 确认无用量的记 0；其余按到下一次 mint 的间隔 + 1 分钟交接余量，封顶连接硬上限', () => {
    const rows = [
      // 乱序传入：内部按 mintedAt 排序
      row({ mintedAt: minutesAgo(10), maxSessionSeconds: 600 }), // 最新：到 now 10m + 1m → 封顶 10m
      row({ mintedAt: minutesAgo(60), actualMs: 14 * 60_000 }), // 实测 14m
      row({ mintedAt: minutesAgo(45), settledBy: 'mint_failed' }), // 0
      row({ mintedAt: minutesAgo(44), settledBy: 'usage_refund' }), // 0
      row({ mintedAt: minutesAgo(43) }), // 下一次 mint 在 40 分钟前：3m + 1m = 4m
      row({ mintedAt: minutesAgo(40) }), // 下一次 mint 在 10 分钟前：30m + 1m → 封顶 15m
    ];

    expect(estimateCommittedStreamMs(rows, NOW)).toBe((10 + 14 + 0 + 0 + 4 + 15) * 60_000);
  });

  it('实测异常大于该连接硬上限 → 按硬上限计（Soniox 到点硬断，单条流不可能更长）', () => {
    expect(
      estimateCommittedStreamMs(
        [row({ mintedAt: minutesAgo(30), actualMs: 40 * 60_000 })],
        NOW
      )
    ).toBe(15 * 60_000);
  });

  it('同一场几乎同时签发的多条流（重连 / 多开）按间隔估算 —— 诚实重连不被当成满额', () => {
    const rows = [
      row({ mintedAt: new Date(NOW - 20_000) }),
      row({ mintedAt: new Date(NOW - 10_000) }),
    ];
    // 10s + 60s，最新一条 10s + 60s
    expect(estimateCommittedStreamMs(rows, NOW)).toBe(140_000);
  });
});

describe('streamDurationCapMs', () => {
  it('realtime 按角色单场上限，interpret 按 6h，ADMIN 不设闸', () => {
    expect(streamDurationCapMs('realtime', 'FREE')).toBe(2 * 60 * 60_000);
    expect(streamDurationCapMs('realtime', 'PRO')).toBe(4 * 60 * 60_000);
    expect(streamDurationCapMs('interpret', 'FREE')).toBe(6 * 60 * 60_000);
    expect(streamDurationCapMs('interpret', 'PRO')).toBe(6 * 60 * 60_000);
    expect(streamDurationCapMs('realtime', 'ADMIN')).toBeNull();
    expect(streamDurationCapMs('interpret', 'ADMIN')).toBeNull();
  });
});

describe('单场时长闸：mint 只放行到「单场上限 + 15 分钟宽限」', () => {
  const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
  const INPUT = {
    userId: 'u1',
    kind: 'realtime' as const,
    sessionId: 's1',
    region: 'eu',
  };

  /** 本场已回填实测、合计 totalMinutes 的 grants（每条 ≤ 15 分钟连接上限，依次签发）。 */
  function measuredRows(totalMinutes: number): StreamGrantUsageRow[] {
    const rows: StreamGrantUsageRow[] = [];
    let remaining = totalMinutes;
    let minutesAgo = 10 * 60;
    while (remaining > 0) {
      const minutes = Math.min(15, remaining);
      rows.push({
        mintedAt: new Date(NOW - minutesAgo * 60_000),
        maxSessionSeconds: 900,
        actualMs: Math.round(minutes * 60_000),
        settledBy: null,
      });
      remaining -= minutes;
      minutesAgo -= 15;
    }
    return rows;
  }

  function trackRollback(): { rolledBack: boolean } {
    const state = { rolledBack: false };
    transactionMock.mockImplementationOnce(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        try {
          return await cb(TX);
        } catch (err) {
          state.rolledBack = true;
          throw err;
        }
      }
    );
    return state;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('PRO 已串 3h55m → 余量 20 分钟，全额 15 分钟签发，不退预扣', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'PRO' });
    txGrantFindManyMock.mockResolvedValueOnce(measuredRows(235));

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({ ok: true, grantId: 'g1', reservedMinutes: 15, maxSessionSeconds: 900 });
    expect(txGrantFindManyMock).toHaveBeenCalledWith({
      where: { sessionId: 's1' },
      select: { mintedAt: true, maxSessionSeconds: true, actualMs: true, settledBy: true },
    });
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('PRO 已串 4h05m → 余量 10 分钟：同事务退回多扣的 5 分钟，key 收缩到 600s', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'PRO' });
    txGrantFindManyMock.mockResolvedValueOnce(measuredRows(245));

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({ ok: true, grantId: 'g1', reservedMinutes: 10, maxSessionSeconds: 600 });
    expect(releaseMock).toHaveBeenCalledWith('u1', 5, TX);
    expect(grantCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reservedMinutes: 10, maxSessionSeconds: 600 }),
      })
    );
  });

  it('PRO 已串满 4h15m → session_duration_limit，预扣随事务回滚，不建 grant', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'PRO' });
    txGrantFindManyMock.mockResolvedValueOnce(measuredRows(255));
    const tracker = trackRollback();

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({
      ok: false,
      reason: 'session_duration_limit',
      limitMs: 4 * 60 * 60_000,
    });
    expect(tracker.rolledBack).toBe(true);
    expect(grantCreateMock).not.toHaveBeenCalled();
  });

  it('余量不足 1 分钟同样拒发（不签只能用几秒的 key）', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'PRO' });
    txGrantFindManyMock.mockResolvedValueOnce(measuredRows(254.5));

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toMatchObject({ ok: false, reason: 'session_duration_limit' });
    expect(grantCreateMock).not.toHaveBeenCalled();
  });

  it('FREE 单场上限 2h：已串 2h12m → 余量 3 分钟', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'FREE' });
    txGrantFindManyMock.mockResolvedValueOnce(measuredRows(132));

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({ ok: true, grantId: 'g1', reservedMinutes: 3, maxSessionSeconds: 180 });
    expect(releaseMock).toHaveBeenCalledWith('u1', 12, TX);
  });

  it('额度只剩 5 分钟、时长余量 10 分钟 → 取较小的 5，不再退预扣', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 5, role: 'PRO' });
    txGrantFindManyMock.mockResolvedValueOnce(measuredRows(245));

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({ ok: true, grantId: 'g1', reservedMinutes: 5, maxSessionSeconds: 300 });
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('interpret 按锚点累计、上限 6h（不套角色的 2h/4h）', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'FREE' });
    txGrantFindManyMock.mockResolvedValueOnce(measuredRows(370));

    const r = await createStreamGrantWithReservation({
      userId: 'u1',
      kind: 'interpret',
      interpretSessionId: 'is-1',
      region: 'eu',
    });

    expect(txGrantFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { interpretSessionId: 'is-1' } })
    );
    // 6h15m − 6h10m = 5 分钟
    expect(r).toEqual({ ok: true, grantId: 'g1', reservedMinutes: 5, maxSessionSeconds: 300 });
  });

  it('ADMIN 不设闸：不读本场 grants，连接上限仍全额', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'ADMIN' });

    const r = await createStreamGrantWithReservation(INPUT);

    expect(r).toEqual({ ok: true, grantId: 'g1', reservedMinutes: 0, maxSessionSeconds: 900 });
    expect(txGrantFindManyMock).not.toHaveBeenCalled();
  });

  it('无归属（interpret 补建锚点失败）→ 无从累计，不设闸', async () => {
    reserveUpToMock.mockResolvedValueOnce({ reservedMinutes: 15, role: 'PRO' });

    const r = await createStreamGrantWithReservation({
      userId: 'u1',
      kind: 'interpret',
      interpretSessionId: null,
      region: 'eu',
    });

    expect(r.ok).toBe(true);
    expect(txGrantFindManyMock).not.toHaveBeenCalled();
  });
});
