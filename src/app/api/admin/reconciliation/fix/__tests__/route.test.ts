import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../tests/utils/http';

/**
 * P5-1 / P5-10：对账「修复」按钮。
 *  - (a) 写回必须是 CAS + 增量（WHERE used = 快照 storedMinutes，increment driftMinutes），
 *        绝对写会把 run 之后发生的真实扣费一笔抹掉；
 *  - (c) 有效性下界必须取 max(cycleStart, transcriptionUsageReconcileFrom)，否则限额下调结算
 *        （把 quotaResetAt 推到下月 1 日、getQuotaCycleStartAt 返回值不变）后守卫必然放行，
 *        已被池结清的分钟被写回 used → 下次月度重置从 gross 池二次扣；
 *  - P5-10 单条修复的三步必须在一个事务内，且标记带 fixed:false 谓词。
 */

const {
  requireAdminAccessMock,
  runFindUniqueMock,
  runUpdateMock,
  mismatchFindUniqueMock,
  mismatchFindManyMock,
  mismatchUpdateManyMock,
  userFindUniqueMock,
  userFindManyMock,
  userUpdateManyMock,
  transactionMock,
  logActionMock,
  legacyUserUpdateMock,
  legacyMismatchUpdateMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  runFindUniqueMock: vi.fn(),
  runUpdateMock: vi.fn(),
  mismatchFindUniqueMock: vi.fn(),
  mismatchFindManyMock: vi.fn(),
  mismatchUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userFindManyMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  logActionMock: vi.fn(),
  // 只为「临时还原旧实现验证测试确实会红」而存在的替身：旧实现走的是 update（绝对写），
  // 不挂上它旧代码会因缺方法而报错，那种红是管道红、不算真红。
  legacyUserUpdateMock: vi.fn(),
  legacyMismatchUpdateMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/billing', () => ({
  // 周期起点固定为 2026-06-01（本月 1 日），与 settlePoolOnLimitChange 把 quotaResetAt 推到
  // 下月 1 日后 getQuotaCycleStartAt 的返回值「完全不变」这一事实一致。
  getQuotaCycleStartAt: () => new Date('2026-06-01T00:00:00.000Z'),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    reconciliationRun: { findUnique: runFindUniqueMock, update: runUpdateMock },
    reconciliationMismatch: {
      findUnique: mismatchFindUniqueMock,
      findMany: mismatchFindManyMock,
      updateMany: mismatchUpdateManyMock,
      update: legacyMismatchUpdateMock,
    },
    user: {
      findUnique: userFindUniqueMock,
      findMany: userFindManyMock,
      updateMany: userUpdateManyMock,
      update: legacyUserUpdateMock,
    },
    $transaction: transactionMock,
  },
}));

import { POST } from '@/app/api/admin/reconciliation/fix/route';

/** 事务替身：把回调跑在同一批 spy 上，让「在事务内」与「在事务外」用同一份数据可比。 */
const txClient = {
  reconciliationRun: { update: runUpdateMock },
  reconciliationMismatch: {
    updateMany: mismatchUpdateManyMock,
    update: legacyMismatchUpdateMock,
  },
  user: { updateMany: userUpdateManyMock, update: legacyUserUpdateMock },
};

const post = (body: unknown) =>
  POST(
    createJsonRequest('http://localhost/api/admin/reconciliation/fix', {
      method: 'POST',
      body,
    })
  );

const RUN_AT = new Date('2026-06-20T00:00:00.000Z');

function mismatch(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'mm-1',
    runId: 'run-1',
    userId: 'u1',
    userEmail: 'u@x.com',
    recordedMinutes: 100,
    storedMinutes: 130,
    driftMinutes: -30,
    fixed: false,
    run: { createdAt: RUN_AT },
    ...over,
  };
}

describe('POST /api/admin/reconciliation/fix — 单条修复', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    // 同时支持交互式与数组两种形态：旧实现批量路径走数组形态，替身能跑它才能验出「真红」。
    transactionMock.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(txClient)
        : Promise.all(arg as unknown[])
    );
    mismatchUpdateManyMock.mockResolvedValue({ count: 1 });
    userUpdateManyMock.mockResolvedValue({ count: 1 });
    runUpdateMock.mockResolvedValue({});
    legacyUserUpdateMock.mockResolvedValue({});
    legacyMismatchUpdateMock.mockResolvedValue({});
  });

  it('▶ P5-1(a)：写回是 CAS + 增量，而非按 recordedMinutes 绝对覆写', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    userFindUniqueMock.mockResolvedValue({
      id: 'u1',
      quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
      transcriptionUsageReconcileFrom: null,
    });

    const res = await post({ mismatchId: 'mm-1' });

    expect(res.status).toBe(200);
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'u1', transcriptionMinutesUsed: 130 },
      data: { transcriptionMinutesUsed: { increment: -30 } },
    });
  });

  it('▶ P5-1(a)：用量在 run 之后已变化（CAS 不中）→ 409 且整个事务回滚，不改任何计数', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    userFindUniqueMock.mockResolvedValue({
      id: 'u1',
      quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
      transcriptionUsageReconcileFrom: null,
    });
    userUpdateManyMock.mockResolvedValue({ count: 0 }); // 快照失效

    const res = await post({ mismatchId: 'mm-1' });

    expect(res.status).toBe(409);
    // 事务体抛错 → 真实 Prisma 会整体回滚；这里断言 fixedCount 那一步根本没执行
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  it('▶ P5-1(c)：run 早于 transcriptionUsageReconcileFrom → 409（不把已结清分钟写回 used）', async () => {
    // 关键：quotaResetAt 已被限额下调结算推到下月 1 日，但 getQuotaCycleStartAt 仍返回本月 1 日，
    // 只看 cycleStart 的旧守卫必然放行 → 二次扣池。reconcileFrom 是唯一能拦住它的下界。
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    userFindUniqueMock.mockResolvedValue({
      id: 'u1',
      quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
      transcriptionUsageReconcileFrom: new Date('2026-06-25T00:00:00.000Z'),
    });

    const res = await post({ mismatchId: 'mm-1' });

    expect(res.status).toBe(409);
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it('reconcileFrom 早于 run → 正常放行', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    userFindUniqueMock.mockResolvedValue({
      id: 'u1',
      quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
      transcriptionUsageReconcileFrom: new Date('2026-06-10T00:00:00.000Z'),
    });

    const res = await post({ mismatchId: 'mm-1' });

    expect(res.status).toBe(200);
    expect(userUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it('▶ P5-10：三步（改用量 / 标记 / 递增计数）都在同一个事务内', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    userFindUniqueMock.mockResolvedValue({
      id: 'u1',
      quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
      transcriptionUsageReconcileFrom: null,
    });
    const inside: string[] = [];
    let insideTx = false;
    transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      insideTx = true;
      try {
        return await fn(txClient);
      } finally {
        insideTx = false;
      }
    });
    userUpdateManyMock.mockImplementation(async () => {
      inside.push(`user:${insideTx ? 'in-tx' : 'out-of-tx'}`);
      return { count: 1 };
    });
    mismatchUpdateManyMock.mockImplementation(async () => {
      inside.push(`mark:${insideTx ? 'in-tx' : 'out-of-tx'}`);
      return { count: 1 };
    });
    runUpdateMock.mockImplementation(async () => {
      inside.push(`count:${insideTx ? 'in-tx' : 'out-of-tx'}`);
      return {};
    });

    const res = await post({ mismatchId: 'mm-1' });

    expect(res.status).toBe(200);
    expect(inside).toEqual(['mark:in-tx', 'user:in-tx', 'count:in-tx']);
  });

  it('▶ P5-10：标记带 fixed:false 谓词；被并发抢先则 409、不重复递增 fixedCount', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    userFindUniqueMock.mockResolvedValue({
      id: 'u1',
      quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
      transcriptionUsageReconcileFrom: null,
    });
    mismatchUpdateManyMock.mockResolvedValue({ count: 0 }); // 已被别人标记

    const res = await post({ mismatchId: 'mm-1' });

    expect(res.status).toBe(409);
    expect(mismatchUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mm-1', fixed: false },
      })
    );
    expect(runUpdateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/reconciliation/fix — 批量修复', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    // 同时支持交互式与数组两种形态：旧实现批量路径走数组形态，替身能跑它才能验出「真红」。
    transactionMock.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(txClient)
        : Promise.all(arg as unknown[])
    );
    runFindUniqueMock.mockResolvedValue({ id: 'run-1', createdAt: RUN_AT });
    mismatchUpdateManyMock.mockResolvedValue({ count: 1 });
    userUpdateManyMock.mockResolvedValue({ count: 1 });
    runUpdateMock.mockResolvedValue({});
    legacyUserUpdateMock.mockResolvedValue({});
    legacyMismatchUpdateMock.mockResolvedValue({});
  });

  it('▶ P5-1(a)：批量写回同样是 CAS + 增量', async () => {
    mismatchFindManyMock.mockResolvedValue([mismatch()]);
    userFindManyMock.mockResolvedValue([
      {
        id: 'u1',
        quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
        transcriptionUsageReconcileFrom: null,
      },
    ]);

    const res = await post({ runId: 'run-1', fixAll: true });

    expect(res.status).toBe(200);
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'u1', transcriptionMinutesUsed: 130 },
      data: { transcriptionMinutesUsed: { increment: -30 } },
    });
  });

  it('▶ P5-1(c)：批量侧也读 transcriptionUsageReconcileFrom，早于它的 run 被跳过', async () => {
    mismatchFindManyMock.mockResolvedValue([mismatch()]);
    userFindManyMock.mockResolvedValue([
      {
        id: 'u1',
        quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
        transcriptionUsageReconcileFrom: new Date('2026-06-25T00:00:00.000Z'),
      },
    ]);

    const res = await post({ runId: 'run-1', fixAll: true });

    expect(res.status).toBe(409);
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it('▶ CAS 未命中的条目不计入 fixedCount（计数不虚高）', async () => {
    mismatchFindManyMock.mockResolvedValue([
      mismatch({ id: 'mm-1', userId: 'u1' }),
      mismatch({ id: 'mm-2', userId: 'u2' }),
    ]);
    userFindManyMock.mockResolvedValue([
      { id: 'u1', quotaResetAt: null, transcriptionUsageReconcileFrom: null },
      { id: 'u2', quotaResetAt: null, transcriptionUsageReconcileFrom: null },
    ]);
    userUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 }); // u2 用量已变
    mismatchUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await post({ runId: 'run-1', fixAll: true });
    const body = await res.json();

    expect(body.fixedCount).toBe(1);
    expect(body.skippedStale).toBe(1);
    expect(mismatchUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['mm-1'] }, fixed: false } })
    );
    expect(runUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { fixedCount: { increment: 1 } } })
    );
  });
});
