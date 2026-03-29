import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  redisGetMock,
  redisSetMock,
  redisScanMock,
  redisDelMock,
  getRedisClientMock,
} = vi.hoisted(() => ({
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
  redisScanMock: vi.fn(),
  redisDelMock: vi.fn(),
  getRedisClientMock: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  getRedisClient: getRedisClientMock,
}));

import {
  getOrSetApiCache,
  invalidateFoldersApiCache,
} from '@/lib/apiResponseCache';

describe('apiResponseCache', () => {
  beforeEach(() => {
    getRedisClientMock.mockReturnValue({
      status: 'ready',
      get: redisGetMock,
      set: redisSetMock,
      scan: redisScanMock,
      del: redisDelMock,
    });
  });

  it('命中 Redis 时直接返回缓存内容', async () => {
    redisGetMock.mockResolvedValue(JSON.stringify({ items: [1, 2, 3] }));

    const loader = vi.fn().mockResolvedValue({ items: [9] });
    const result = await getOrSetApiCache('sessions:user:user-1:list:base', 30, loader);

    expect(result).toEqual({
      hit: true,
      value: { items: [1, 2, 3] },
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it('未命中时回源并写入 Redis', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');

    const loader = vi.fn().mockResolvedValue({ items: ['fresh'] });
    const result = await getOrSetApiCache('folders:user:user-1:list', 30, loader);

    expect(result).toEqual({
      hit: false,
      value: { items: ['fresh'] },
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalledWith(
      'lecturelive:api-response:v1:folders:user:user-1:list',
      JSON.stringify({ items: ['fresh'] }),
      'EX',
      30
    );
  });

  it('按前缀清理文件夹列表缓存', async () => {
    redisScanMock
      .mockResolvedValueOnce([
        '1',
        [
          'lecturelive:api-response:v1:folders:user:user-1:list',
          'lecturelive:api-response:v1:folders:user:user-1:list:detail',
        ],
      ])
      .mockResolvedValueOnce(['0', []]);
    redisDelMock.mockResolvedValue(2);

    await invalidateFoldersApiCache('user-1');

    expect(redisScanMock).toHaveBeenNthCalledWith(
      1,
      '0',
      'MATCH',
      'lecturelive:api-response:v1:folders:user:user-1:*',
      'COUNT',
      '100'
    );
    expect(redisDelMock).toHaveBeenCalledWith(
      'lecturelive:api-response:v1:folders:user:user-1:list',
      'lecturelive:api-response:v1:folders:user:user-1:list:detail'
    );
  });
});
