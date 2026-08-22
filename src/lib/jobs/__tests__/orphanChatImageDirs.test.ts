import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readdirMock, rmMock, statMock, findManyMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  rmMock: vi.fn(),
  statMock: vi.fn(),
  findManyMock: vi.fn(),
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
  /** 默认：所有目录都够老（早于 L52 的新生保护期），行为与旧实现一致 */
  const OLD_MTIME = Date.now() - 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    rmMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mtimeMs: OLD_MTIME });
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

describe('cleanupOrphanChatImageDirs —— L52 新生目录保护', () => {
  const OLD_MTIME = Date.now() - 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    rmMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mtimeMs: OLD_MTIME });
  });

  /**
   * L52：readdir 与 findMany 之间新建会话的图片目录不在 existingSet 里，
   * 旧实现会直接 rm -rf 掉用户刚上传的图（不可逆）。真孤儿目录 mtime 只会越来越旧，
   * 所以「太新就跳过」不会漏收，只会晚一轮 cron。
   */
  it('刚创建的目录（mtime 在保护期内）不被删', async () => {
    readdirMock.mockResolvedValueOnce(['fresh', 'stale']);
    findManyMock.mockResolvedValueOnce([]); // DB 里都查不到
    statMock.mockImplementation(async (dir: string) =>
      dir.endsWith('fresh')
        ? { mtimeMs: Date.now() } // 刚刚建出来（竞态窗口里的新会话）
        : { mtimeMs: OLD_MTIME }
    );

    const n = await cleanupOrphanChatImageDirs();

    expect(n).toBe(1);
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith('/fake/chatimages/stale', {
      recursive: true,
      force: true,
    });
    expect(rmMock).not.toHaveBeenCalledWith(
      '/fake/chatimages/fresh',
      expect.anything()
    );
  });

  it('stat 失败（目录已被别处删掉）时跳过，不误删', async () => {
    readdirMock.mockResolvedValueOnce(['gone']);
    findManyMock.mockResolvedValueOnce([]);
    statMock.mockRejectedValueOnce(new Error('ENOENT'));

    const n = await cleanupOrphanChatImageDirs();

    expect(n).toBe(0);
    expect(rmMock).not.toHaveBeenCalled();
  });
});
