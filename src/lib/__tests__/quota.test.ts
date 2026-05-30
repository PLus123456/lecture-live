import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  userFindUniqueMock,
  userFindManyMock,
  userUpdateMock,
  executeRawMock,
  chatAttachmentGroupByMock,
} = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  userFindManyMock: vi.fn(),
  userUpdateMock: vi.fn(),
  executeRawMock: vi.fn(),
  chatAttachmentGroupByMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
      findMany: userFindManyMock,
      update: userUpdateMock,
    },
    chatAttachment: {
      groupBy: chatAttachmentGroupByMock,
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

import {
  addStorageBytes,
  releaseStorageBytes,
  reserveStorageBytes,
  reconcileStorageBytes,
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
