import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B3：InterpretSession 服务端持久化 + 兜底结算。核心不变量——deduct 认领与 cron 兜底经 settledAt
 * 条件原子认领**互斥**，每场恰好扣一次。
 */

const {
  createMock,
  findFirstMock,
  updateManyMock,
  findManyMock,
  updateMock,
  transactionMock,
  deductMock,
  recordUsageMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  findManyMock: vi.fn(),
  updateMock: vi.fn(),
  transactionMock: vi.fn(),
  deductMock: vi.fn(),
  recordUsageMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    interpretSession: {
      create: createMock,
      findFirst: findFirstMock,
      updateMany: updateManyMock,
      findMany: findManyMock,
      update: updateMock,
    },
    // cron reclaim 的认领+扣费同事务；默认实现执行回调并注入带 interpretSession 的 tx。
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));
vi.mock('@/lib/quota', () => ({
  deductTranscriptionMinutes: deductMock,
  recordInterpretUsage: recordUsageMock,
}));
vi.mock('@/lib/billing', () => ({
  getBillableMinutes: (ms: number) => Math.ceil(ms / 60_000),
}));
vi.mock('@/lib/interpret/anchor', () => ({
  MAX_INTERPRET_DURATION_MS: 6 * 60 * 60_000,
}));

import {
  createInterpretSession,
  claimInterpretSessionForDeduct,
  reclaimStaleInterpretSessions,
  INTERPRET_RECLAIM_STALE_MS,
} from '@/lib/interpret/session';

const NOW = new Date('2026-07-11T12:00:00.000Z');

beforeEach(() => {
  createMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  findManyMock.mockReset();
  updateMock.mockReset();
  transactionMock.mockReset();
  deductMock.mockReset();
  recordUsageMock.mockReset();
  updateMock.mockResolvedValue(undefined);
  recordUsageMock.mockResolvedValue(undefined);
  deductMock.mockResolvedValue({ role: 'FREE' });
  // cron reclaim 事务：执行回调并注入带 interpretSession.updateMany 的 tx（复用 updateManyMock）。
  transactionMock.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ interpretSession: { updateMany: updateManyMock } })
  );
});

describe('createInterpretSession', () => {
  it('落一行 {userId, anchorId}', async () => {
    createMock.mockResolvedValueOnce({});
    await createInterpretSession('u1', 'a1');
    expect(createMock).toHaveBeenCalledWith({ data: { userId: 'u1', anchorId: 'a1' } });
  });

  it('建行失败被吞（best-effort，不抛）', async () => {
    createMock.mockRejectedValueOnce(new Error('db down'));
    await expect(createInterpretSession('u1', null)).resolves.toBeUndefined();
  });
});

describe('claimInterpretSessionForDeduct', () => {
  it('anchorId 命中未结算会话 → 原子认领成功 → claimed', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's1', settledAt: null });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const r = await claimInterpretSessionForDeduct('u1', 'a1');

    expect(r).toEqual({ outcome: 'claimed', sessionId: 's1' });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's1', settledAt: null },
      data: { settledAt: expect.any(Date), settledBy: 'deduct' },
    });
  });

  it('目标会话已被 cron 结算(settledAt 非空) → already_settled，不再认领', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's1', settledAt: NOW });

    const r = await claimInterpretSessionForDeduct('u1', 'a1');

    expect(r).toEqual({ outcome: 'already_settled', sessionId: 's1' });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('认领时输给 cron(updateMany count=0) → already_settled', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's1', settledAt: null });
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    const r = await claimInterpretSessionForDeduct('u1', 'a1');

    expect(r).toEqual({ outcome: 'already_settled', sessionId: 's1' });
  });

  it('查无记录 → no_record（调用方按旧行为扣费兜底）', async () => {
    findFirstMock.mockResolvedValueOnce(null);

    const r = await claimInterpretSessionForDeduct('u1', 'a1');

    expect(r).toEqual({ outcome: 'no_record', sessionId: null });
  });

  it('无 anchorId（降级）→ 认领该用户最旧的未结算会话', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's-old', settledAt: null });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const r = await claimInterpretSessionForDeduct('u1', null);

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { userId: 'u1', settledAt: null },
      orderBy: { startedAt: 'asc' },
      select: { id: true, settledAt: true },
    });
    expect(r.outcome).toBe('claimed');
  });
});

describe('reclaimStaleInterpretSessions', () => {
  it('扫 settledAt=null 且 startedAt 超阈值；认领成功→按服务端墙钟(封顶6h)扣费+记台账', async () => {
    // startedAt = now - 8h → elapsed 封顶 6h → billable 360
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    updateManyMock.mockResolvedValueOnce({ count: 1 }); // 认领成功

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(1);
    // findMany 阈值 = now - INTERPRET_RECLAIM_STALE_MS
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      settledAt: null,
      startedAt: { lte: new Date(NOW.getTime() - INTERPRET_RECLAIM_STALE_MS) },
    });
    // 封顶 6h → 360 分钟
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's1', settledAt: null },
      data: { settledAt: NOW, settledBy: 'cron_reclaim', billedMinutes: 360 },
    });
    expect(deductMock).toHaveBeenCalledWith('u1', 360, expect.anything());
    expect(recordUsageMock).toHaveBeenCalledWith(
      'u1',
      360,
      6 * 60 * 60_000,
      expect.anything()
    );
  });

  it('认领输给 deduct(count=0) → 跳过、不扣费（互斥，不双扣）', async () => {
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    updateManyMock.mockResolvedValueOnce({ count: 0 }); // deduct 抢先结算

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(0);
    expect(deductMock).not.toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it('ADMIN 用户：deduct 返回 role ADMIN → 不记台账', async () => {
    const startedAt = new Date(NOW.getTime() - 7.5 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'admin', startedAt }]);
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    deductMock.mockResolvedValueOnce({ role: 'ADMIN' });

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(1);
    expect(deductMock).toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled();
  });
});
