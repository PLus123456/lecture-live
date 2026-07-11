import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock 链（必须在 import 被测代码前）───────────────────────────────
const chatAttachmentFindManyMock = vi.fn();
const chatAttachmentDeleteManyMock = vi.fn();
const queryRawMock = vi.fn();
const executeRawUnsafeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      findMany: (...a: unknown[]) => chatAttachmentFindManyMock(...a),
    },
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));

vi.mock('@/lib/adminCleanup', () => ({
  olderThanDaysToCutoff: () => new Date('2026-01-01T00:00:00.000Z'),
}));

vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: vi.fn().mockResolvedValue(undefined),
}));

import { performChatFileCleanup } from '@/lib/chatFileCleanup';

/** $transaction 回调注入的 tx：FOR UPDATE 重读($queryRaw) / 释放($executeRawUnsafe) / 删行(deleteMany) */
function makeTx() {
  return {
    $queryRaw: (...a: unknown[]) => queryRawMock(...a),
    $executeRawUnsafe: (...a: unknown[]) => executeRawUnsafeMock(...a),
    chatAttachment: {
      deleteMany: (...a: unknown[]) => chatAttachmentDeleteManyMock(...a),
    },
  };
}

describe('performChatFileCleanup — 释放口径按事务内 FOR UPDATE 实际存在的行（B8 防重复退）', () => {
  beforeEach(() => {
    chatAttachmentFindManyMock.mockReset();
    chatAttachmentDeleteManyMock.mockReset();
    queryRawMock.mockReset();
    executeRawUnsafeMock.mockReset();
    transactionMock.mockReset();
    transactionMock.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx())
    );
    chatAttachmentDeleteManyMock.mockResolvedValue({ count: 0 });
    executeRawUnsafeMock.mockResolvedValue(undefined);
  });

  it('无并发：锁定重读=快照 → 释放并删除全部行', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      { id: 'r1', userId: 'A', bytes: BigInt(100), cloudrevePath: 'p1', extractedTextPath: null },
      { id: 'r2', userId: 'A', bytes: BigInt(50), cloudrevePath: 'p2', extractedTextPath: null },
      { id: 'r3', userId: 'B', bytes: BigInt(30), cloudrevePath: 'p3', extractedTextPath: null },
    ]);
    queryRawMock.mockResolvedValueOnce([
      { id: 'r1', userId: 'A', bytes: BigInt(100) },
      { id: 'r2', userId: 'A', bytes: BigInt(50) },
      { id: 'r3', userId: 'B', bytes: BigInt(30) },
    ]);

    const res = await performChatFileCleanup({
      olderThanDays: 30,
      sizeBytesGT: 0,
      kinds: [],
    });

    expect(res).toEqual({ deleted: 3, releasedBytes: 180, truncated: false });
    // 每用户各释放一次：A=150, B=30（releaseUserStorageBytesRaw 调 $executeRawUnsafe(sql, value, userId)）
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(2);
    const calls = executeRawUnsafeMock.mock.calls.map((c) => [c[1], c[2]]);
    expect(calls).toContainEqual(['150', 'A']);
    expect(calls).toContainEqual(['30', 'B']);
    expect(chatAttachmentDeleteManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2', 'r3'] } },
    });
  });

  it('并发单删已删走 r1：锁定重读只剩 r2/r3 → 只退 r2/r3，绝不重复退 r1', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      { id: 'r1', userId: 'A', bytes: BigInt(100), cloudrevePath: 'p1', extractedTextPath: null },
      { id: 'r2', userId: 'A', bytes: BigInt(50), cloudrevePath: 'p2', extractedTextPath: null },
      { id: 'r3', userId: 'B', bytes: BigInt(30), cloudrevePath: 'p3', extractedTextPath: null },
    ]);
    // 锁定重读只剩 r2/r3（r1 被并发单删提交删走并已退过其字节）
    queryRawMock.mockResolvedValueOnce([
      { id: 'r2', userId: 'A', bytes: BigInt(50) },
      { id: 'r3', userId: 'B', bytes: BigInt(30) },
    ]);

    const res = await performChatFileCleanup({
      olderThanDays: 30,
      sizeBytesGT: 0,
      kinds: [],
    });

    // r1 的 100 字节不再由本处释放 → 只退 80、删 2（此前按快照会多退 r1 的 100）
    expect(res).toEqual({ deleted: 2, releasedBytes: 80, truncated: false });
    const calls = executeRawUnsafeMock.mock.calls.map((c) => [c[1], c[2]]);
    expect(calls).toContainEqual(['50', 'A']); // A 只退 r2 的 50，而非快照的 150
    expect(calls).toContainEqual(['30', 'B']);
    expect(calls).not.toContainEqual(['150', 'A']);
    expect(chatAttachmentDeleteManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['r2', 'r3'] } },
    });
  });

  it('锁定重读全空（候选行全被并发删走）：不释放、不删、deleted=0', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      { id: 'r1', userId: 'A', bytes: BigInt(100), cloudrevePath: 'p1', extractedTextPath: null },
    ]);
    queryRawMock.mockResolvedValueOnce([]);

    const res = await performChatFileCleanup({
      olderThanDays: 30,
      sizeBytesGT: 0,
      kinds: [],
    });

    expect(res).toEqual({ deleted: 0, releasedBytes: 0, truncated: false });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(chatAttachmentDeleteManyMock).not.toHaveBeenCalled();
  });

  it('候选为空：不进事务，返回全 0', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([]);
    const res = await performChatFileCleanup({
      olderThanDays: 30,
      sizeBytesGT: 0,
      kinds: [],
    });
    expect(res).toEqual({ deleted: 0, releasedBytes: 0, truncated: false });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
