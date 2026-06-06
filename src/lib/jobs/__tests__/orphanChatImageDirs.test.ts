import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readdirMock, rmMock, findManyMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  rmMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { readdir: readdirMock, rm: rmMock },
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
    vi.clearAllMocks();
    rmMock.mockResolvedValue(undefined);
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
