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
  settleGrantsMock,
  grantAggregateMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  findManyMock: vi.fn(),
  updateMock: vi.fn(),
  transactionMock: vi.fn(),
  deductMock: vi.fn(),
  recordUsageMock: vi.fn(),
  settleGrantsMock: vi.fn(),
  grantAggregateMock: vi.fn(),
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
    // R1-L2：cron 优先按 grants 的 usage-logs 实测时长计费（事务外聚合）。
    sonioxStreamGrant: {
      aggregate: grantAggregateMock,
    },
    // cron reclaim 的认领+扣费同事务；默认实现执行回调并注入带 interpretSession 的 tx。
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));
// R1-L2：cron 事务内会结算本场 grants（释放 mint 预扣）——mock 掉原语本体，单测只验调用与互斥。
vi.mock('@/lib/soniox/streamGrant', () => ({
  settleStreamGrants: settleGrantsMock,
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
  ensureActiveInterpretSession,
  INTERPRET_RECLAIM_STALE_MS,
} from '@/lib/interpret/session';

const MAX_INTERPRET_MS = 6 * 60 * 60_000;

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
  settleGrantsMock.mockResolvedValue({ settledCount: 0, releasedMinutes: 0, actualMsTotal: 0 });
  grantAggregateMock.mockResolvedValue({ _sum: { actualMs: null } });
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

    // anchorId 命中即返回（不到回退路径），anchorStartedAt 取值无关，传 null。
    const r = await claimInterpretSessionForDeduct('u1', 'a1', null);

    expect(r).toEqual({ outcome: 'claimed', sessionId: 's1' });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's1', settledAt: null },
      data: { settledAt: expect.any(Date), settledBy: 'deduct' },
    });
  });

  it('目标会话已被 cron 结算(settledAt 非空) → already_settled，不再认领', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's1', settledAt: NOW });

    const r = await claimInterpretSessionForDeduct('u1', 'a1', null);

    expect(r).toEqual({ outcome: 'already_settled', sessionId: 's1' });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('认领时输给 cron(updateMany count=0) → already_settled', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's1', settledAt: null });
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    const r = await claimInterpretSessionForDeduct('u1', 'a1', null);

    expect(r).toEqual({ outcome: 'already_settled', sessionId: 's1' });
  });

  const ANCHOR_TS = NOW.getTime() - 60_000; // 本流锚点起点：1 分钟前

  it('anchorId 命中失败 + 无本流 mint 锚点 → no_record（anchorId 查空 + 精确回退也查空）', async () => {
    // R1-C：anchorId 落空会精确回退查本流的 null-anchor 锚点；两处都查空才 no_record。
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const r = await claimInterpretSessionForDeduct('u1', 'a1', ANCHOR_TS);

    expect(r).toEqual({ outcome: 'no_record', sessionId: null });
    expect(findFirstMock).toHaveBeenCalledTimes(2);
  });

  it('R1-C Finding 1：anchorId 查无 DB 行（/start DB 建行失败）→ 精确回退认领本流 mint 锚点 B → claimed', async () => {
    // 1) 按 anchorId 查无（X1 的 DB 行没建成）；2) 精确回退：userId+未结算+anchorId:null+startedAt>=锚点起点 → 命中 B。
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's-mint-B', settledAt: null });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const r = await claimInterpretSessionForDeduct('u1', 'a1', ANCHOR_TS);

    expect(r).toEqual({ outcome: 'claimed', sessionId: 's-mint-B' });
    // 精确回退：只认 null-anchor(不动别流的 anchorId 非空行)，且 startedAt 被**上下界夹住**、
    // 取窗口内最早一条（L26）。
    //   下界 = 锚点起点 - 5s 时钟容差：排除上一场/更早的残留锚点；
    //   上界 = 锚点起点 + 10min：诚实客户端「/start 拿 anchorId → 立刻 mint」，本流的 mint 锚点
    //          必定紧跟其后。没有上界时（旧实现只有下界 + orderBy desc），并发标签页里**后启动**
    //          的流的锚点也满足条件，且恰好排在最前 → 先结束的流把后启动那条流的锚点结算掉，
    //          后者结束时无锚点可认领、走 no_record 再扣一次（被双扣）。
    expect(findFirstMock).toHaveBeenNthCalledWith(2, {
      where: {
        userId: 'u1',
        settledAt: null,
        anchorId: null,
        startedAt: {
          gte: new Date(ANCHOR_TS - 5_000),
          lte: new Date(ANCHOR_TS + 10 * 60_000),
        },
      },
      orderBy: { startedAt: 'asc' },
      select: { id: true, settledAt: true },
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's-mint-B', settledAt: null },
      data: { settledAt: expect.any(Date), settledBy: 'deduct' },
    });
  });

  it('anchorStartedAt 为 null（stale/伪造 anchorId 消费不到 Redis 锚点）→ 不回退（避免误结算并发/上一场）', async () => {
    findFirstMock.mockResolvedValueOnce(null); // anchorId 查无

    const r = await claimInterpretSessionForDeduct('u1', 'a1', null);

    // anchorStartedAt=null → 不触发回退 → no_record（deduct 侧据此按墙钟扣费、不结算任何行）
    expect(r).toEqual({ outcome: 'no_record', sessionId: null });
    expect(findFirstMock).toHaveBeenCalledTimes(1);
  });

  it('无 anchorId（降级）→ 认领该用户最旧的未结算会话（精确回退仅对 anchorId 命中失败触发，此路径不变）', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's-old', settledAt: null });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const r = await claimInterpretSessionForDeduct('u1', null, null);

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { userId: 'u1', settledAt: null },
      orderBy: { startedAt: 'asc' },
      select: { id: true, settledAt: true },
    });
    expect(r.outcome).toBe('claimed');
  });
});

describe('reclaimStaleInterpretSessions', () => {
  it('P1-1：无任何 grant 实测量（锚点从未串流）→ 按 0 结算，绝不回落墙钟扣 6h', async () => {
    // startedAt = now - 8h。旧行为：墙钟被夹到 MAX_INTERPRET(6h) → 扣 360 分钟（诚实用户被凭空计费：
    // /start 在建流前就落锚点，麦克风被拒 / Soniox 不可达时前端只置 error、永不调 deduct）。
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    grantAggregateMock.mockResolvedValueOnce({ _sum: { actualMs: null } });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(1);
    // findMany 阈值 = now - INTERPRET_RECLAIM_STALE_MS
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      settledAt: null,
      startedAt: { lte: new Date(NOW.getTime() - INTERPRET_RECLAIM_STALE_MS) },
    });
    // 走 settleInterpretSessionAsVoid：billedMinutes=0、settledBy 区分于正常兜底
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's1', settledAt: null },
      data: {
        settledAt: expect.any(Date),
        settledBy: 'cron_reclaim_void',
        billedMinutes: 0,
      },
    });
    // 一分钱都不能扣（墙钟口径彻底不参与）
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it('P1-1：grants 存在但 actualMs 全为 0（usage-logs 未回填）→ 同样按 0 结算', async () => {
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    grantAggregateMock.mockResolvedValueOnce({ _sum: { actualMs: 0 } });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(1);
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('P1-1：作废时输给 deduct（count=0）→ 不计入 reclaimed', async () => {
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    grantAggregateMock.mockResolvedValueOnce({ _sum: { actualMs: null } });
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(0);
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('R1-L2：grants 有 usage-logs 实测 → 按 sum(actualMs) 计费（精确口径取代墙钟封顶）+ 事务内结算 grants', async () => {
    // startedAt = now - 8h（墙钟口径本应封 6h=360min），但实测串流只有 20 分钟 → 按 20 扣
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    grantAggregateMock.mockResolvedValueOnce({ _sum: { actualMs: 20 * 60_000 } });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(1);
    expect(grantAggregateMock).toHaveBeenCalledWith({
      where: { interpretSessionId: 's1', actualMs: { gt: 0 } },
      _sum: { actualMs: true },
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 's1', settledAt: null },
      data: { settledAt: NOW, settledBy: 'cron_reclaim', billedMinutes: 20 },
    });
    // 结算本场 grants（释放 mint 预扣）与扣费同事务
    expect(settleGrantsMock).toHaveBeenCalledWith(
      { interpretSessionId: 's1' },
      'interpret_cron',
      expect.anything()
    );
    expect(deductMock).toHaveBeenCalledWith('u1', 20, expect.anything(), {
      source: 'interpret_cron',
      referenceId: 's1',
    });
  });

  it('R1-L2：实测量超 6h 上限 → 仍封顶（防 Soniox 侧异常大值）', async () => {
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    grantAggregateMock.mockResolvedValueOnce({ _sum: { actualMs: 9 * 60 * 60_000 } });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await reclaimStaleInterpretSessions(NOW);

    expect(deductMock).toHaveBeenCalledWith('u1', 360, expect.anything(), {
      source: 'interpret_cron',
      referenceId: 's1',
    });
  });

  it('认领输给 deduct(count=0) → 跳过、不扣费（互斥，不双扣）', async () => {
    const startedAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'u1', startedAt }]);
    grantAggregateMock.mockResolvedValueOnce({ _sum: { actualMs: 20 * 60_000 } });
    updateManyMock.mockResolvedValueOnce({ count: 0 }); // deduct 抢先结算

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(0);
    expect(deductMock).not.toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it('ADMIN 用户：deduct 返回 role ADMIN → 不记台账', async () => {
    const startedAt = new Date(NOW.getTime() - 7.5 * 60 * 60_000);
    findManyMock.mockResolvedValueOnce([{ id: 's1', userId: 'admin', startedAt }]);
    grantAggregateMock.mockResolvedValueOnce({ _sum: { actualMs: 20 * 60_000 } });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    deductMock.mockResolvedValueOnce({ role: 'ADMIN' });

    const n = await reclaimStaleInterpretSessions(NOW);

    expect(n).toBe(1);
    expect(deductMock).toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled();
  });
});

describe('ensureActiveInterpretSession（R1-C：mint 时保证有活锚点，堵 skip /start）', () => {
  it('存在最近未结算锚点（honest /start 已建）→ 复用、不新建', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 's-existing' });

    const r = await ensureActiveInterpretSession('u1', NOW);

    expect(r).toEqual({ id: 's-existing', created: false });
    expect(createMock).not.toHaveBeenCalled();
    // 查询按 userId + 未结算 + startedAt 在 MAX_INTERPRET 窗口内，取最近一条
    expect(findFirstMock).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        settledAt: null,
        startedAt: { gte: new Date(NOW.getTime() - MAX_INTERPRET_MS) },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
  });

  it('无活锚点（skip /start）→ 新建 {userId, anchorId:null, startedAt:now}', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 's-new' });

    const r = await ensureActiveInterpretSession('u1', NOW);

    expect(r).toEqual({ id: 's-new', created: true });
    expect(createMock).toHaveBeenCalledWith({
      data: { userId: 'u1', anchorId: null, startedAt: NOW },
      select: { id: true },
    });
  });

  it('DB 故障 → 吞错、返回 {id:null, created:false}（绝不阻塞发 key）', async () => {
    findFirstMock.mockRejectedValueOnce(new Error('db down'));

    const r = await ensureActiveInterpretSession('u1', NOW);

    expect(r).toEqual({ id: null, created: false });
  });

  it('create 抛错也被吞', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockRejectedValueOnce(new Error('create failed'));

    const r = await ensureActiveInterpretSession('u1', NOW);

    expect(r).toEqual({ id: null, created: false });
  });
});
