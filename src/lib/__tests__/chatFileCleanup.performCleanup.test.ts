import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock 链（必须在 import 被测代码前）───────────────────────────────
const chatAttachmentFindManyMock = vi.fn();
const chatAttachmentDeleteManyMock = vi.fn();
const queryRawMock = vi.fn();
const executeRawUnsafeMock = vi.fn();
const transactionMock = vi.fn();
const findBillableStoredArtifactsByOwnersMock = vi.fn();
const deleteCloudreveAttachmentFilesMock = vi.fn();
const releaseStoredArtifactInTransactionMock = vi.fn();
const markStoredArtifactsDeletePendingInTransactionMock = vi.fn();

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
  deleteCloudreveAttachmentFiles: (...args: unknown[]) =>
    deleteCloudreveAttachmentFilesMock(...args),
}));

vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  findBillableStoredArtifactsByOwners:
    (...args: unknown[]) => findBillableStoredArtifactsByOwnersMock(...args),
  markStoredArtifactsDeletePendingInTransaction: (...args: unknown[]) =>
    markStoredArtifactsDeletePendingInTransactionMock(...args),
  releaseStoredArtifactInTransaction: (...args: unknown[]) =>
    releaseStoredArtifactInTransactionMock(...args),
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
    findBillableStoredArtifactsByOwnersMock.mockReset();
    deleteCloudreveAttachmentFilesMock.mockReset();
    releaseStoredArtifactInTransactionMock.mockReset();
    markStoredArtifactsDeletePendingInTransactionMock.mockReset();
    findBillableStoredArtifactsByOwnersMock.mockResolvedValue([]);
    deleteCloudreveAttachmentFilesMock.mockResolvedValue(true);
    releaseStoredArtifactInTransactionMock.mockResolvedValue(true);
    transactionMock.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx())
    );
    chatAttachmentDeleteManyMock.mockResolvedValue({ count: 0 });
    executeRawUnsafeMock.mockResolvedValue(undefined);
    markStoredArtifactsDeletePendingInTransactionMock.mockResolvedValue([]);
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

    expect(res).toEqual({
      deleted: 3,
      releasedBytes: 180,
      truncated: false,
      physicalDeleteComplete: true,
      pendingArtifactCount: 0,
    });
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
    expect(res).toEqual({
      deleted: 2,
      releasedBytes: 80,
      truncated: false,
      physicalDeleteComplete: true,
      pendingArtifactCount: 0,
    });
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

    expect(res).toEqual({
      deleted: 0,
      releasedBytes: 0,
      truncated: false,
      physicalDeleteComplete: true,
      pendingArtifactCount: 0,
    });
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
    expect(res).toEqual({
      deleted: 0,
      releasedBytes: 0,
      truncated: false,
      physicalDeleteComplete: true,
      pendingArtifactCount: 0,
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('legacy 物理删除失败时保留 owner 行与配额，供后续安全重试', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      {
        id: 'r1',
        userId: 'A',
        bytes: BigInt(100),
        cloudrevePath: '/private/object?token=never-persist',
        extractedTextPath: null,
      },
    ]);
    deleteCloudreveAttachmentFilesMock.mockResolvedValueOnce(false);

    const res = await performChatFileCleanup({
      olderThanDays: 30,
      sizeBytesGT: 0,
      kinds: [],
    });

    expect(res).toEqual({
      deleted: 0,
      releasedBytes: 0,
      truncated: false,
      physicalDeleteComplete: false,
      pendingArtifactCount: 0,
    });
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(chatAttachmentDeleteManyMock).not.toHaveBeenCalled();
  });

  it('ledger 物理删除失败时 owner 行已转 durable pending，但不释放配额', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      {
        id: 'r1',
        userId: 'A',
        bytes: BigInt(100),
        cloudrevePath: 'ledger/path',
        extractedTextPath: null,
      },
    ]);
    const artifact = {
      id: 'artifact-1',
      ownerId: 'r1',
      chargedBytes: BigInt(100),
    };
    findBillableStoredArtifactsByOwnersMock.mockResolvedValueOnce([artifact]);
    queryRawMock.mockResolvedValueOnce([
      { id: 'r1', userId: 'A', bytes: BigInt(100) },
    ]);
    markStoredArtifactsDeletePendingInTransactionMock.mockResolvedValueOnce([
      artifact,
    ]);
    deleteCloudreveAttachmentFilesMock.mockResolvedValueOnce(false);

    const res = await performChatFileCleanup({
      olderThanDays: 30,
      sizeBytesGT: 0,
      kinds: [],
    });

    expect(res).toEqual({
      deleted: 1,
      releasedBytes: 0,
      truncated: false,
      physicalDeleteComplete: false,
      pendingArtifactCount: 1,
    });
    expect(markStoredArtifactsDeletePendingInTransactionMock).toHaveBeenCalled();
    expect(chatAttachmentDeleteManyMock).toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(releaseStoredArtifactInTransactionMock).not.toHaveBeenCalled();
  });

  it('ledger 配额释放与成功审计 callback 使用同一个事务', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      {
        id: 'r1',
        userId: 'A',
        bytes: BigInt(100),
        cloudrevePath: 'ledger/path',
        extractedTextPath: null,
      },
    ]);
    const artifact = {
      id: 'artifact-1',
      ownerId: 'r1',
      chargedBytes: BigInt(100),
    };
    findBillableStoredArtifactsByOwnersMock.mockResolvedValueOnce([artifact]);
    queryRawMock.mockResolvedValueOnce([
      { id: 'r1', userId: 'A', bytes: BigInt(100) },
    ]);
    markStoredArtifactsDeletePendingInTransactionMock.mockResolvedValueOnce([
      artifact,
    ]);
    const releaseAuditMock = vi.fn().mockResolvedValue(undefined);

    const res = await performChatFileCleanup(
      { olderThanDays: 30, sizeBytesGT: 0, kinds: [] },
      { onArtifactReleaseMutation: releaseAuditMock }
    );

    expect(res).toEqual({
      deleted: 1,
      releasedBytes: 100,
      truncated: false,
      physicalDeleteComplete: true,
      pendingArtifactCount: 0,
    });
    const releaseTx = releaseStoredArtifactInTransactionMock.mock.calls[0]?.[0];
    expect(releaseAuditMock).toHaveBeenCalledWith(releaseTx, {
      artifactCount: 1,
      releasedArtifactCount: 1,
      releasedBytes: 100,
    });
  });

  it('delete/quota 成功审计失败时事务回滚，不会留下无审计 mutation', async () => {
    const durable = { rowPresent: true, storageBytesUsed: 100 };
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      {
        id: 'r1',
        userId: 'A',
        bytes: BigInt(100),
        cloudrevePath: 'legacy/path',
        extractedTextPath: null,
      },
    ]);
    queryRawMock.mockImplementation(async () =>
      durable.rowPresent
        ? [{ id: 'r1', userId: 'A', bytes: BigInt(100) }]
        : []
    );
    executeRawUnsafeMock.mockImplementation(async () => {
      durable.storageBytesUsed = 0;
    });
    chatAttachmentDeleteManyMock.mockImplementation(async () => {
      durable.rowPresent = false;
      return { count: 1 };
    });
    transactionMock.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const snapshot = { ...durable };
        try {
          return await cb(makeTx());
        } catch (error) {
          Object.assign(durable, snapshot);
          throw error;
        }
      }
    );

    await expect(
      performChatFileCleanup(
        { olderThanDays: 30, sizeBytesGT: 0, kinds: [] },
        {
          onDatabaseMutation: async () => {
            throw new Error('audit unavailable');
          },
        }
      )
    ).rejects.toThrow('audit unavailable');

    expect(durable).toEqual({ rowPresent: true, storageBytesUsed: 100 });
  });
});
