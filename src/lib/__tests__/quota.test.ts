import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  userFindUniqueMock,
  userFindManyMock,
  userUpdateMock,
  userUpdateManyMock,
  executeRawMock,
  chatAttachmentGroupByMock,
  sessionAggregateMock,
} = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  userFindManyMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  chatAttachmentGroupByMock: vi.fn(),
  sessionAggregateMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
      findMany: userFindManyMock,
      update: userUpdateMock,
      updateMany: userUpdateManyMock,
    },
    chatAttachment: {
      groupBy: chatAttachmentGroupByMock,
    },
    session: {
      aggregate: sessionAggregateMock,
    },
    $executeRaw: executeRawMock,
  },
}));

vi.mock('@/lib/billing', () => ({
  getBillableMinutes: (ms: number) => Math.ceil(ms / 60_000),
  getNextQuotaResetAt: () => new Date('2099-01-01T00:00:00.000Z'),
  getQuotaCycleStartAt: () => new Date('2026-01-01T00:00:00.000Z'),
  getRemainingTranscriptionMinutes: (used: number, limit: number) =>
    Math.max(0, limit - used),
}));

import type { Prisma } from '@prisma/client';
import {
  addStorageBytes,
  releaseStorageBytes,
  reserveStorageBytes,
  reconcileStorageBytes,
  deductTranscriptionMinutes,
  reserveTranscriptionMinutes,
  releaseTranscriptionMinutes,
  resetExpiredTranscriptionQuotas,
  getStorageHoursUsed,
  checkQuota,
} from '@/lib/quota';

const futureReset = new Date('2099-01-01T00:00:00.000Z');

function freeUser(overrides: Partial<{ storageBytesUsed: bigint }> = {}) {
  return {
    id: 'user-free',
    role: 'FREE' as const,
    transcriptionMinutesUsed: 0,
    transcriptionMinutesLimit: 60,
    storageHoursUsed: 0,
    storageHoursLimit: 10,
    storageBytesUsed: overrides.storageBytesUsed ?? BigInt(0),
    storageBytesLimit: BigInt(104_857_600), // 100 MB
    allowedModels: 'local',
    quotaResetAt: futureReset,
  };
}

function adminUser() {
  return {
    id: 'user-admin',
    role: 'ADMIN' as const,
    transcriptionMinutesUsed: 0,
    transcriptionMinutesLimit: 60,
    storageHoursUsed: 0,
    storageHoursLimit: 10,
    storageBytesUsed: BigInt(0),
    storageBytesLimit: BigInt(104_857_600),
    allowedModels: '*',
    quotaResetAt: futureReset,
  };
}

describe('addStorageBytes', () => {
  beforeEach(() => {
    userFindUniqueMock.mockReset();
    userUpdateMock.mockReset();
    executeRawMock.mockReset();
  });

  it('正向：在 FREE 用户上累加 bytes 并返回 snapshot', async () => {
    const before = freeUser();
    const after = freeUser({ storageBytesUsed: BigInt(1234) });
    userFindUniqueMock.mockResolvedValueOnce(before);
    userUpdateMock.mockResolvedValueOnce(after);

    const snapshot = await addStorageBytes('user-free', 1234);

    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'user-free' },
      data: { storageBytesUsed: { increment: BigInt(1234) } },
      select: expect.objectContaining({ storageBytesUsed: true }),
    });
    expect(snapshot?.storageBytesUsed).toBe(1234);
    expect(snapshot?.storageBytesLimit).toBe(104_857_600);
    expect(snapshot?.remainingStorageBytes).toBe(104_857_600 - 1234);
  });

  it('正向：bytes 是小数时向上取整', async () => {
    const before = freeUser();
    const after = freeUser({ storageBytesUsed: BigInt(11) });
    userFindUniqueMock.mockResolvedValueOnce(before);
    userUpdateMock.mockResolvedValueOnce(after);

    await addStorageBytes('user-free', 10.1);

    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { storageBytesUsed: { increment: BigInt(11) } },
      })
    );
  });

  it('边界：ADMIN 不扣减，但仍返回 snapshot（含 1TB sentinel）', async () => {
    userFindUniqueMock.mockResolvedValueOnce(adminUser());

    const snapshot = await addStorageBytes('user-admin', 999);

    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(snapshot?.remainingStorageBytes).toBe(1_000_000_000_000);
  });

  it('边界：bytes <= 0 或 NaN 时直接返回 snapshot 不写库', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    const zeroSnap = await addStorageBytes('user-free', 0);
    expect(zeroSnap?.storageBytesUsed).toBe(0);

    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    const negSnap = await addStorageBytes('user-free', -100);
    expect(negSnap?.storageBytesUsed).toBe(0);

    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    const nanSnap = await addStorageBytes('user-free', NaN);
    expect(nanSnap?.storageBytesUsed).toBe(0);

    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('边界：用户不存在返回 null', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const snap = await addStorageBytes('missing', 100);

    expect(snap).toBeNull();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });
});

describe('releaseStorageBytes', () => {
  beforeEach(() => {
    userFindUniqueMock.mockReset();
    userUpdateMock.mockReset();
    executeRawMock.mockReset();
  });

  it('正向：FREE 用户扣减后用 raw SQL 写库并刷新 snapshot', async () => {
    const before = freeUser({ storageBytesUsed: BigInt(5000) });
    const after = freeUser({ storageBytesUsed: BigInt(4000) });
    userFindUniqueMock.mockResolvedValueOnce(before);
    executeRawMock.mockResolvedValueOnce(1);
    userFindUniqueMock.mockResolvedValueOnce(after);

    const snap = await releaseStorageBytes('user-free', 1000);

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(snap?.storageBytesUsed).toBe(4000);
  });

  it('边界：负数 / 0 / NaN 不触发 SQL', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser({ storageBytesUsed: BigInt(100) }));
    const negSnap = await releaseStorageBytes('user-free', -50);
    expect(negSnap?.storageBytesUsed).toBe(100);

    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    const zeroSnap = await releaseStorageBytes('user-free', 0);
    expect(zeroSnap?.storageBytesUsed).toBe(0);

    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    const nanSnap = await releaseStorageBytes('user-free', NaN);
    expect(nanSnap?.storageBytesUsed).toBe(0);

    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('边界：raw SQL 保证不会减到负（GREATEST 在 SQL 层 clamp）', async () => {
    // 模拟当前 used 100，要释放 500 — SQL 层会 clamp 到 0
    const before = freeUser({ storageBytesUsed: BigInt(100) });
    const after = freeUser({ storageBytesUsed: BigInt(0) });
    userFindUniqueMock.mockResolvedValueOnce(before);
    executeRawMock.mockResolvedValueOnce(1);
    userFindUniqueMock.mockResolvedValueOnce(after);

    const snap = await releaseStorageBytes('user-free', 500);

    expect(snap?.storageBytesUsed).toBe(0);
    expect(snap?.remainingStorageBytes).toBe(104_857_600);
  });

  it('边界：ADMIN 不调用 raw SQL，仅返回 snapshot', async () => {
    userFindUniqueMock.mockResolvedValueOnce(adminUser());

    const snap = await releaseStorageBytes('user-admin', 999);

    expect(executeRawMock).not.toHaveBeenCalled();
    expect(snap?.role).toBe('ADMIN');
  });

  it('边界：用户不存在返回 null', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const snap = await releaseStorageBytes('missing', 100);

    expect(snap).toBeNull();
    expect(executeRawMock).not.toHaveBeenCalled();
  });
});

describe('reserveStorageBytes', () => {
  beforeEach(() => {
    userFindUniqueMock.mockReset();
    userUpdateMock.mockReset();
    executeRawMock.mockReset();
  });

  it('正向：额度足够时条件原子扣减成功返回 true', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    executeRawMock.mockResolvedValueOnce(1); // affectedRows=1 → 预留成功

    const ok = await reserveStorageBytes('user-free', 1000);

    expect(ok).toBe(true);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it('配额不足：条件 UPDATE 影响 0 行 → 返回 false', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser({ storageBytesUsed: BigInt(104_857_500) }));
    executeRawMock.mockResolvedValueOnce(0); // used+bytes > limit → 不更新

    const ok = await reserveStorageBytes('user-free', 1000);

    expect(ok).toBe(false);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it('边界：ADMIN 视为无限，不走 SQL 直接 true', async () => {
    userFindUniqueMock.mockResolvedValueOnce(adminUser());

    const ok = await reserveStorageBytes('user-admin', 999);

    expect(ok).toBe(true);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('边界：bytes <= 0 直接 true 不写库', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser());

    const ok = await reserveStorageBytes('user-free', 0);

    expect(ok).toBe(true);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('边界：用户不存在返回 false', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const ok = await reserveStorageBytes('missing', 100);

    expect(ok).toBe(false);
    expect(executeRawMock).not.toHaveBeenCalled();
  });
});

describe('reconcileStorageBytes', () => {
  beforeEach(() => {
    userFindManyMock.mockReset();
    userUpdateMock.mockReset();
    chatAttachmentGroupByMock.mockReset();
  });

  it('回写漂移：实际 SUM 与 storageBytesUsed 不一致时校正', async () => {
    chatAttachmentGroupByMock.mockResolvedValueOnce([
      { userId: 'u-a', _sum: { bytes: BigInt(500) } },
    ]);
    userFindManyMock.mockResolvedValueOnce([
      { id: 'u-a', storageBytesUsed: BigInt(800) }, // 实际 500，记账 800 → 校正
    ]);
    userUpdateMock.mockResolvedValue(null);

    const result = await reconcileStorageBytes();

    expect(result).toEqual({ checked: 1, corrected: 1 });
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u-a' },
      data: { storageBytesUsed: BigInt(500) },
    });
  });

  it('一致时不写库，corrected=0', async () => {
    chatAttachmentGroupByMock.mockResolvedValueOnce([
      { userId: 'u-a', _sum: { bytes: BigInt(500) } },
    ]);
    userFindManyMock.mockResolvedValueOnce([
      { id: 'u-a', storageBytesUsed: BigInt(500) },
    ]);

    const result = await reconcileStorageBytes();

    expect(result).toEqual({ checked: 1, corrected: 1 - 1 });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('无附件的用户若残留非零计数 → 清零', async () => {
    chatAttachmentGroupByMock.mockResolvedValueOnce([]); // 没有任何附件
    userFindManyMock.mockResolvedValueOnce([
      { id: 'u-b', storageBytesUsed: BigInt(300) },
    ]);
    userUpdateMock.mockResolvedValue(null);

    const result = await reconcileStorageBytes();

    expect(result).toEqual({ checked: 1, corrected: 1 });
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u-b' },
      data: { storageBytesUsed: BigInt(0) },
    });
  });
});

describe('deductTranscriptionMinutes', () => {
  const futureResetLocal = new Date('2099-01-01T00:00:00.000Z');

  function txUser(
    over: Partial<{
      transcriptionMinutesUsed: number;
      quotaResetAt: Date;
      role: 'ADMIN' | 'PRO' | 'FREE';
    }> = {}
  ) {
    return {
      id: 'user-1',
      role: over.role ?? ('FREE' as const),
      transcriptionMinutesUsed: over.transcriptionMinutesUsed ?? 0,
      transcriptionMinutesLimit: 600,
      storageHoursUsed: 0,
      storageHoursLimit: 10,
      storageBytesUsed: BigInt(0),
      storageBytesLimit: BigInt(104_857_600),
      allowedModels: '*',
      quotaResetAt: over.quotaResetAt ?? futureResetLocal,
    };
  }

  beforeEach(() => {
    userFindUniqueMock.mockReset();
    userUpdateMock.mockReset();
    userUpdateManyMock.mockReset();
  });

  it('窗口未过期：直接 increment 扣减，不触发重置', async () => {
    userFindUniqueMock.mockResolvedValueOnce(txUser({ transcriptionMinutesUsed: 10 }));
    userUpdateMock.mockResolvedValueOnce(txUser({ transcriptionMinutesUsed: 13 }));

    const snap = await deductTranscriptionMinutes('user-1', 3);

    expect(userUpdateManyMock).not.toHaveBeenCalled(); // 未过期不重置
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { transcriptionMinutesUsed: { increment: 3 } },
      select: expect.objectContaining({ transcriptionMinutesUsed: true }),
    });
    expect(snap?.transcriptionMinutesUsed).toBe(13);
  });

  it('跨月窗口：过期 → 先重置清零再 increment，分钟落在新窗口（修隐性 drift）', async () => {
    const expired = new Date('2020-01-01T00:00:00.000Z');
    // ensureQuotaWindow：1st findUnique 拿到过期用户（旧窗口已用 580）
    userFindUniqueMock.mockResolvedValueOnce(
      txUser({ transcriptionMinutesUsed: 580, quotaResetAt: expired })
    );
    // 乐观锁重置成功
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    // 2nd findUnique 拿到重置后的用户（新窗口已用 0）
    userFindUniqueMock.mockResolvedValueOnce(
      txUser({ transcriptionMinutesUsed: 0, quotaResetAt: futureResetLocal })
    );
    // increment 落到新窗口
    userUpdateMock.mockResolvedValueOnce(
      txUser({ transcriptionMinutesUsed: 5, quotaResetAt: futureResetLocal })
    );

    const snap = await deductTranscriptionMinutes('user-1', 5);

    // 关键：重置确实发生（裸 increment 不会调 updateMany），increment 落在重置后的窗口
    expect(userUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { transcriptionMinutesUsed: { increment: 5 } },
      })
    );
    expect(snap?.transcriptionMinutesUsed).toBe(5); // 新窗口的 5，而非旧窗口的 585
  });

  it('ADMIN：不扣减，仅返回 snapshot', async () => {
    userFindUniqueMock.mockResolvedValueOnce(txUser({ role: 'ADMIN' }));

    const snap = await deductTranscriptionMinutes('user-1', 100);

    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(snap?.role).toBe('ADMIN');
  });

  it('minutes <= 0：直接返回不写库', async () => {
    userFindUniqueMock.mockResolvedValueOnce(txUser());

    const snap = await deductTranscriptionMinutes('user-1', 0);

    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(snap?.transcriptionMinutesUsed).toBe(0);
  });

  it('用户不存在返回 null', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const snap = await deductTranscriptionMinutes('missing', 5);

    expect(snap).toBeNull();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('传入事务客户端：在该 tx 上读写、不碰全局 prisma（finalize 原子扣减）', async () => {
    const txFindUnique = vi
      .fn()
      .mockResolvedValueOnce(txUser({ transcriptionMinutesUsed: 0 }));
    const txUpdate = vi
      .fn()
      .mockResolvedValueOnce(txUser({ transcriptionMinutesUsed: 7 }));
    const tx = {
      user: { findUnique: txFindUnique, update: txUpdate, updateMany: vi.fn() },
    } as unknown as Prisma.TransactionClient;

    const snap = await deductTranscriptionMinutes('user-1', 7, tx);

    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { transcriptionMinutesUsed: { increment: 7 } },
      })
    );
    // 全局 prisma 的 mock 完全没被调用 —— 证明扣减走在传入的事务上
    expect(userFindUniqueMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(snap?.transcriptionMinutesUsed).toBe(7);
  });
});

describe('reserveTranscriptionMinutes', () => {
  beforeEach(() => {
    userFindUniqueMock.mockReset();
    userUpdateManyMock.mockReset();
    executeRawMock.mockReset();
  });

  it('正向：额度足够时条件原子预扣成功返回 true', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser()); // ensureQuotaWindow，窗口未过期
    executeRawMock.mockResolvedValueOnce(1); // affectedRows=1 → 预留成功

    const ok = await reserveTranscriptionMinutes('user-free', 30);

    expect(ok).toBe(true);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it('配额不足：条件 UPDATE 影响 0 行 → 返回 false（投影后超 limit）', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    executeRawMock.mockResolvedValueOnce(0); // used+est > limit → 不更新

    const ok = await reserveTranscriptionMinutes('user-free', 300);

    expect(ok).toBe(false);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it('边界：ADMIN 视为无限，不走 SQL 直接 true', async () => {
    userFindUniqueMock.mockResolvedValueOnce(adminUser());

    const ok = await reserveTranscriptionMinutes('user-admin', 9999);

    expect(ok).toBe(true);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('边界：minutes <= 0 / NaN 直接 true 不写库', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    expect(await reserveTranscriptionMinutes('user-free', 0)).toBe(true);

    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    expect(await reserveTranscriptionMinutes('user-free', NaN)).toBe(true);

    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('边界：用户不存在返回 false', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const ok = await reserveTranscriptionMinutes('missing', 10);

    expect(ok).toBe(false);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('跨月窗口：过期 → ensureQuotaWindow 先乐观锁重置，再在新窗口预留', async () => {
    const expired = new Date('2020-01-01T00:00:00.000Z');
    // 1st findUnique：拿到过期用户
    userFindUniqueMock.mockResolvedValueOnce({
      ...freeUser(),
      transcriptionMinutesUsed: 55,
      quotaResetAt: expired,
    });
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 }); // 乐观锁重置成功
    // 2nd findUnique：重置后的用户（新窗口已用 0）
    userFindUniqueMock.mockResolvedValueOnce(freeUser());
    executeRawMock.mockResolvedValueOnce(1); // 预留成功

    const ok = await reserveTranscriptionMinutes('user-free', 30);

    expect(userUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
  });
});

describe('releaseTranscriptionMinutes', () => {
  beforeEach(() => {
    executeRawMock.mockReset();
  });

  it('正向：用 raw SQL 回滚预留的分钟（GREATEST 防负）', async () => {
    executeRawMock.mockResolvedValueOnce(1);

    await releaseTranscriptionMinutes('user-free', 30);

    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it('边界：minutes <= 0 / NaN 不触发 SQL', async () => {
    await releaseTranscriptionMinutes('user-free', 0);
    await releaseTranscriptionMinutes('user-free', -5);
    await releaseTranscriptionMinutes('user-free', NaN);

    expect(executeRawMock).not.toHaveBeenCalled();
  });
});

describe('getStorageHoursUsed', () => {
  beforeEach(() => {
    sessionAggregateMock.mockReset();
  });

  it('实时 SUM(durationMs)/3600000：3 小时 = 10_800_000ms → 3', async () => {
    sessionAggregateMock.mockResolvedValueOnce({ _sum: { durationMs: 10_800_000 } });

    const hours = await getStorageHoursUsed('user-free');

    expect(hours).toBe(3);
    expect(sessionAggregateMock).toHaveBeenCalledWith({
      where: { userId: 'user-free' },
      _sum: { durationMs: true },
    });
  });

  it('无 session（_sum.durationMs 为 null）→ 0', async () => {
    sessionAggregateMock.mockResolvedValueOnce({ _sum: { durationMs: null } });

    expect(await getStorageHoursUsed('user-free')).toBe(0);
  });
});

describe("checkQuota('storage_hours')", () => {
  beforeEach(() => {
    userFindUniqueMock.mockReset();
    sessionAggregateMock.mockReset();
  });

  it('实时用量 < limit → 放行 true', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser()); // limit=10h
    sessionAggregateMock.mockResolvedValueOnce({ _sum: { durationMs: 5 * 3_600_000 } }); // 5h

    expect(await checkQuota('user-free', 'storage_hours')).toBe(true);
  });

  it('实时用量 >= limit → 拦截 false（修死维度恒真）', async () => {
    userFindUniqueMock.mockResolvedValueOnce(freeUser()); // limit=10h
    sessionAggregateMock.mockResolvedValueOnce({ _sum: { durationMs: 10 * 3_600_000 } }); // 10h，恰好顶满

    expect(await checkQuota('user-free', 'storage_hours')).toBe(false);
  });

  it('ADMIN 永远放行，不查 session', async () => {
    userFindUniqueMock.mockResolvedValueOnce(adminUser());

    expect(await checkQuota('user-admin', 'storage_hours')).toBe(true);
    expect(sessionAggregateMock).not.toHaveBeenCalled();
  });
});

describe('resetExpiredTranscriptionQuotas', () => {
  beforeEach(() => {
    userUpdateManyMock.mockReset();
    userFindManyMock.mockReset();
  });

  it('用乐观锁 updateMany WHERE quotaResetAt<=now 条件重置，返回 count', async () => {
    userUpdateManyMock.mockResolvedValueOnce({ count: 3 });

    const now = new Date('2026-02-01T00:00:00.000Z');
    const count = await resetExpiredTranscriptionQuotas(now);

    expect(count).toBe(3);
    // 不再先 findMany 再逐个 update —— 单条原子 updateMany
    expect(userFindManyMock).not.toHaveBeenCalled();
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { quotaResetAt: { lte: now } },
      data: {
        transcriptionMinutesUsed: 0,
        quotaResetAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  });

  it('无过期窗口：updateMany count=0 → 返回 0', async () => {
    userUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    expect(await resetExpiredTranscriptionQuotas(new Date())).toBe(0);
  });
});
