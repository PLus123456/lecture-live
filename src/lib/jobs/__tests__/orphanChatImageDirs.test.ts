import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readdirMock,
  rmMock,
  statMock,
  findManyMock,
  findBillableStoredArtifactsByConversationsMock,
  findBillableStoredArtifactsByOwnerMock,
  releaseStoredArtifactMock,
} = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  rmMock: vi.fn(),
  statMock: vi.fn(),
  findManyMock: vi.fn(),
  findBillableStoredArtifactsByConversationsMock: vi.fn(),
  findBillableStoredArtifactsByOwnerMock: vi.fn(),
  releaseStoredArtifactMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { readdir: readdirMock, rm: rmMock, stat: statMock },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { conversation: { findMany: findManyMock } },
}));

vi.mock('@/lib/llm/chatImageStorage', () => ({
  CHAT_IMAGE_ROOT: '/fake/chatimages',
}));

vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  loadCloudreveContext: vi.fn(),
  deleteCloudreveFile: vi.fn(),
}));

vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_TYPE: {
    CHAT_EXTRACTED: 'chat_extracted',
    INLINE_IMAGE: 'inline_image',
  },
  findBillableStoredArtifactsByConversations:
    findBillableStoredArtifactsByConversationsMock,
  findBillableStoredArtifactsByOwner: findBillableStoredArtifactsByOwnerMock,
  markStoredArtifactOrphan: vi.fn(),
  releaseStoredArtifact: releaseStoredArtifactMock,
}));

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

import { cleanupOrphanChatImageDirs } from '@/lib/jobs/chatFilesCleanupJob';

describe('cleanupOrphanChatImageDirs', () => {
  beforeEach(() => {
  // L52：孤儿目录必须"足够旧"才会被删。默认给一天前，宽限期本身另有用例覆盖。
  statMock.mockResolvedValue({ mtimeMs: Date.now() - 24 * 60 * 60 * 1000 });
    vi.clearAllMocks();
    rmMock.mockResolvedValue(undefined);
    findBillableStoredArtifactsByConversationsMock.mockResolvedValue([]);
    findBillableStoredArtifactsByOwnerMock.mockResolvedValue([]);
    releaseStoredArtifactMock.mockResolvedValue(true);
  });

  it('根目录不存在 → 返回 0，不查 DB', async () => {
    readdirMock.mockRejectedValueOnce(new Error('ENOENT'));
    const n = await cleanupOrphanChatImageDirs();
    expect(n).toBe(0);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('空目录 → 返回 0，不查 DB', async () => {
    readdirMock.mockResolvedValueOnce([]);
    const n = await cleanupOrphanChatImageDirs();
    expect(n).toBe(0);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('仅删 Conversation 表中已不存在的孤儿目录', async () => {
    readdirMock.mockResolvedValueOnce(['c1', 'c2', 'c3']);
    findManyMock.mockResolvedValueOnce([{ id: 'c2' }]); // 仅 c2 仍存在
    const n = await cleanupOrphanChatImageDirs();
    expect(n).toBe(2);
    expect(rmMock).toHaveBeenCalledWith('/fake/chatimages/c1', {
      recursive: true,
      force: true,
    });
    expect(rmMock).toHaveBeenCalledWith('/fake/chatimages/c3', {
      recursive: true,
      force: true,
    });
    expect(rmMock).not.toHaveBeenCalledWith(
      '/fake/chatimages/c2',
      expect.anything()
    );
  });

  it('单条 rm 失败不抛，继续删其余并计已成功数', async () => {
    readdirMock.mockResolvedValueOnce(['c1', 'c2']);
    findManyMock.mockResolvedValueOnce([]); // 都是孤儿
    rmMock.mockRejectedValueOnce(new Error('EACCES')); // c1 删失败
    const n = await cleanupOrphanChatImageDirs();
    expect(n).toBe(1); // 仅 c2 成功
    expect(rmMock).toHaveBeenCalledTimes(2);
  });
});
