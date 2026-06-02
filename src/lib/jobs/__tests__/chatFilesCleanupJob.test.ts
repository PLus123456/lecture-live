import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock 链 ──────────────────────────────────────────────────────────
// 必须在 import 被测代码之前 vi.mock，否则 prisma / cloudreve 都已经被求值。

const chatAttachmentFindManyMock = vi.fn();
const chatAttachmentDeleteMock = vi.fn();
const userQueryRawMock = vi.fn();
const executeRawMock = vi.fn();
const transactionMock = vi.fn();
const siteSettingFindUniqueMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      findMany: (...args: unknown[]) => chatAttachmentFindManyMock(...args),
      delete: (...args: unknown[]) => chatAttachmentDeleteMock(...args),
    },
    siteSetting: {
      findUnique: (...args: unknown[]) => siteSettingFindUniqueMock(...args),
    },
    $queryRaw: (...args: unknown[]) => userQueryRawMock(...args),
    $executeRaw: (...args: unknown[]) => executeRawMock(...args),
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  resolveCloudreveConfig: vi.fn().mockResolvedValue(null), // 默认未配置，DB 删除路径仍要走
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => v),
  isEncrypted: vi.fn(() => false),
}));

// pino logger noop（避免每个 test 都污染 stdout）
vi.mock('@/lib/logger', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => noopLogger,
  };
  return {
    logger: noopLogger,
    serializeError: (err: unknown) =>
      err instanceof Error ? { message: err.message } : { message: String(err) },
  };
});

// ─── 被测代码 ────────────────────────────────────────────────────────
import { runChatFilesCleanup } from '@/lib/jobs/chatFilesCleanupJob';

// ─── Fixtures ────────────────────────────────────────────────────────
function makeAttachment(overrides: Partial<{
  id: string;
  userId: string;
  bytes: bigint;
  cloudrevePath: string;
  extractedTextPath: string | null;
}> = {}) {
  return {
    id: 'a1',
    userId: 'u1',
    bytes: BigInt(1024),
    cloudrevePath: '/u1/chat-uploads/c1/foo.pdf',
    extractedTextPath: null,
    ...overrides,
  };
}

function setSiteSetting(map: Record<string, string | null>) {
  siteSettingFindUniqueMock.mockImplementation(
    async ({ where }: { where: { key: string } }) => {
      const value = map[where.key];
      return value !== undefined && value !== null
        ? { key: where.key, value }
        : null;
    }
  );
}

// ─── 测试 ────────────────────────────────────────────────────────────
describe('runChatFilesCleanup', () => {
  beforeEach(() => {
    chatAttachmentFindManyMock.mockReset();
    chatAttachmentDeleteMock.mockReset().mockResolvedValue(undefined);
    userQueryRawMock.mockReset().mockResolvedValue([]);
    executeRawMock.mockReset().mockResolvedValue(undefined);
    // deleteAttachment 现把"删行 + 扣字节"包进 $transaction([...])，原子化。
    // mock 把传入的 operations 数组 await 掉，使内部 delete/executeRaw 仍被求值、
    // 各自断言保持有效；任一 operation reject 时整个事务 reject（原子语义）。
    transactionMock
      .mockReset()
      .mockImplementation(async (operations: unknown[]) => Promise.all(operations));
    siteSettingFindUniqueMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('aging cleanup: 只删 createdAt < cutoff 的附件且 bytesReleased 等于过期附件 bytes 和', async () => {
    setSiteSetting({
      chat_files_retention_days: '14',
      chat_files_soft_cap_percent: '0', // 关掉 soft-cap 路径以聚焦
    });

    const stale = [
      makeAttachment({ id: 'old-1', bytes: BigInt(1000) }),
      makeAttachment({ id: 'old-2', bytes: BigInt(2000), userId: 'u2' }),
    ];

    chatAttachmentFindManyMock.mockResolvedValueOnce(stale);

    const result = await runChatFilesCleanup();

    expect(result.agingDeleted).toBe(2);
    expect(result.softCapDeleted).toBe(0);
    expect(result.bytesReleased).toBe(BigInt(3000));
    expect(result.errors).toBe(0);

    // 验证 findMany 是按 cutoff 查的（最近 14 天之前），且同时约束 createdAt 与
    // lastAccessedAt —— 只看 createdAt 会把近期仍在使用的旧附件误删。
    expect(chatAttachmentFindManyMock).toHaveBeenCalledTimes(1);
    const findArgs = chatAttachmentFindManyMock.mock.calls[0][0];
    expect(findArgs.where.createdAt.lt).toBeInstanceOf(Date);
    expect(findArgs.where.lastAccessedAt.lt).toBeInstanceOf(Date);

    // 验证每条都被 delete 调到
    expect(chatAttachmentDeleteMock).toHaveBeenCalledTimes(2);
    expect(chatAttachmentDeleteMock).toHaveBeenNthCalledWith(1, {
      where: { id: 'old-1' },
    });
    expect(chatAttachmentDeleteMock).toHaveBeenNthCalledWith(2, {
      where: { id: 'old-2' },
    });

    // 验证配额释放 SQL 被调
    expect(executeRawMock).toHaveBeenCalledTimes(2);
  });

  it('retention_days=0 时 agingDeleted = 0 且不查 ChatAttachment', async () => {
    setSiteSetting({
      chat_files_retention_days: '0',
      chat_files_soft_cap_percent: '0',
    });

    const result = await runChatFilesCleanup();

    expect(result.agingDeleted).toBe(0);
    expect(result.softCapDeleted).toBe(0);
    expect(result.bytesReleased).toBe(BigInt(0));
    expect(chatAttachmentFindManyMock).not.toHaveBeenCalled();
    expect(chatAttachmentDeleteMock).not.toHaveBeenCalled();
  });

  it('soft_cap_percent=0 时 softCapDeleted = 0 且不查 over-cap 用户', async () => {
    setSiteSetting({
      chat_files_retention_days: '0', // 关掉 aging 路径
      chat_files_soft_cap_percent: '0',
    });

    const result = await runChatFilesCleanup();

    expect(result.softCapDeleted).toBe(0);
    expect(userQueryRawMock).not.toHaveBeenCalled();
  });

  it('soft-cap LRU: 删最老的（按 lastAccessedAt asc）直到 used < target', async () => {
    setSiteSetting({
      chat_files_retention_days: '0', // 关掉 aging
      chat_files_soft_cap_percent: '90',
    });

    // 一个用户用了 950 字节，配额 1000 —— 95% > 90%，需要清理到 80% (= 800)
    userQueryRawMock.mockResolvedValueOnce([
      {
        id: 'u-over',
        storageBytesUsed: BigInt(950),
        storageBytesLimit: BigInt(1000),
      },
    ]);

    // 三个附件，分别 200/100/50 bytes，按 lastAccessedAt asc 排
    chatAttachmentFindManyMock.mockResolvedValueOnce([
      makeAttachment({ id: 'lru-1', userId: 'u-over', bytes: BigInt(200) }),
      makeAttachment({ id: 'lru-2', userId: 'u-over', bytes: BigInt(100) }),
      makeAttachment({ id: 'lru-3', userId: 'u-over', bytes: BigInt(50) }),
    ]);

    const result = await runChatFilesCleanup();

    // 950 - 200 = 750 ≤ 800，停。只删第一条。
    expect(result.softCapDeleted).toBe(1);
    expect(result.bytesReleased).toBe(BigInt(200));
    expect(chatAttachmentDeleteMock).toHaveBeenCalledTimes(1);
    expect(chatAttachmentDeleteMock).toHaveBeenCalledWith({
      where: { id: 'lru-1' },
    });
  });

  it('soft-cap LRU: 多个用户独立处理；并验证 findMany 是按 lastAccessedAt 升序', async () => {
    setSiteSetting({
      chat_files_retention_days: '0',
      chat_files_soft_cap_percent: '90',
    });

    userQueryRawMock.mockResolvedValueOnce([
      { id: 'u-a', storageBytesUsed: BigInt(1000), storageBytesLimit: BigInt(1000) },
      { id: 'u-b', storageBytesUsed: BigInt(950), storageBytesLimit: BigInt(1000) },
    ]);

    chatAttachmentFindManyMock
      // u-a 的附件
      .mockResolvedValueOnce([
        makeAttachment({ id: 'a-1', userId: 'u-a', bytes: BigInt(300) }),
      ])
      // u-b 的附件
      .mockResolvedValueOnce([
        makeAttachment({ id: 'b-1', userId: 'u-b', bytes: BigInt(200) }),
      ]);

    const result = await runChatFilesCleanup();

    expect(result.softCapDeleted).toBe(2);
    expect(chatAttachmentFindManyMock).toHaveBeenCalledTimes(2);

    const firstCallArgs = chatAttachmentFindManyMock.mock.calls[0][0];
    expect(firstCallArgs.where.userId).toBe('u-a');
    expect(firstCallArgs.orderBy).toEqual({ lastAccessedAt: 'asc' });

    const secondCallArgs = chatAttachmentFindManyMock.mock.calls[1][0];
    expect(secondCallArgs.where.userId).toBe('u-b');
  });

  it('单个附件删除抛错时计入 errors 但不中断其他附件清理', async () => {
    setSiteSetting({
      chat_files_retention_days: '14',
      chat_files_soft_cap_percent: '0',
    });

    chatAttachmentFindManyMock.mockResolvedValueOnce([
      makeAttachment({ id: 'good-1', bytes: BigInt(100) }),
      makeAttachment({ id: 'bad', bytes: BigInt(200) }),
      makeAttachment({ id: 'good-2', bytes: BigInt(300) }),
    ]);

    // 第二条 DB delete 抛错
    chatAttachmentDeleteMock
      .mockResolvedValueOnce(undefined) // good-1
      .mockRejectedValueOnce(new Error('db locked')) // bad
      .mockResolvedValueOnce(undefined); // good-2

    const result = await runChatFilesCleanup();

    expect(result.agingDeleted).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.bytesReleased).toBe(BigInt(400)); // good-1 + good-2 = 100+300
  });

  it('SiteSetting 缺失时使用 fallback（retention 14, softCap 90）', async () => {
    // 全部 setting 返回 null（U13 还没上线的情形）
    siteSettingFindUniqueMock.mockResolvedValue(null);

    // 没过期附件
    chatAttachmentFindManyMock.mockResolvedValueOnce([]);
    // 没人 over-cap
    userQueryRawMock.mockResolvedValueOnce([]);

    const result = await runChatFilesCleanup();

    expect(result.agingDeleted).toBe(0);
    expect(result.softCapDeleted).toBe(0);
    expect(result.errors).toBe(0);

    // 至关重要：必须查过 aging path（即 retention > 0 走了 findMany）
    expect(chatAttachmentFindManyMock).toHaveBeenCalledTimes(1);
    // 也必须查过 soft-cap path（softCap > 0 走了 queryRaw）
    expect(userQueryRawMock).toHaveBeenCalledTimes(1);
  });
});
