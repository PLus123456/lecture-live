import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 未确认报价（QUOTED）的源 PDF 留在本地盘、不计任何存储配额。此前只有「本人下次上传时
 * 懒清理 20 条」：用户停止上传后过期报价永久占盘。现在调度 tick 做全局清扫，上传前另有
 * 单用户未过期报价数量闸。
 */

const { findManyMock, deleteManyMock, countMock, deleteTaskFilesMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
  countMock: vi.fn(),
  deleteTaskFilesMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: {
      findMany: findManyMock,
      deleteMany: deleteManyMock,
      count: countMock,
    },
  },
}));
vi.mock('@/lib/translate/taskStorage', () => ({ deleteTaskFiles: deleteTaskFilesMock }));

import {
  countOutstandingQuotes,
  QUOTE_TTL_MS,
  sweepAllExpiredQuotes,
} from '@/lib/translate/taskApi';

describe('quote sweeping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteTaskFilesMock.mockResolvedValue(undefined);
  });

  it('全局清扫不限用户、只删仍是 QUOTED 的过期行并清它们的文件', async () => {
    findManyMock.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);
    // q2 在清扫期间被并发 confirm 推进 PENDING → 条件删除 0 行，文件必须保留
    deleteManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const before = Date.now();

    await expect(sweepAllExpiredQuotes()).resolves.toBe(1);

    const where = findManyMock.mock.calls[0][0].where as {
      userId?: string;
      status: string;
      createdAt: { lt: Date };
    };
    expect(where.userId).toBeUndefined();
    expect(where.status).toBe('QUOTED');
    expect(where.createdAt.lt.getTime()).toBeLessThanOrEqual(before - QUOTE_TTL_MS + 1000);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: 'q1', status: 'QUOTED' } });
    expect(deleteTaskFilesMock).toHaveBeenCalledTimes(1);
    expect(deleteTaskFilesMock).toHaveBeenCalledWith('q1');
  });

  it('单用户未过期报价计数只数 TTL 内的 QUOTED 行', async () => {
    countMock.mockResolvedValue(3);

    await expect(countOutstandingQuotes('user-1')).resolves.toBe(3);
    expect(countMock).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        status: 'QUOTED',
        createdAt: { gte: expect.any(Date) },
      },
    });
  });
});
