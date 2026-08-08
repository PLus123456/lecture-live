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
  buildSessionsApiCacheKey,
  getOrSetApiCache,
  invalidateFoldersApiCache,
} from '@/lib/apiResponseCache';

// P4-4：缓存签名只纳入真正影响 SQL 的白名单参数。
// 旧实现把整串查询参数塞进签名，而 GET /api/sessions 的 SQL 只看
// unarchived/folderId/limit/cursor —— 任意垃圾参数都换一个新键、必然 miss、还各自驻留 30 秒，
// 一条 400 字节的请求换来数百 KB 常驻内存（10³-10⁴ 倍放大），且 Redis 与限流/鉴权黑名单共用。
describe('P4-4 会话列表缓存键基数', () => {
  const key = (qs: string) =>
    buildSessionsApiCacheKey('user-1', new URLSearchParams(qs));

  it('垃圾参数不进签名（同一 SQL ⇒ 同一个键）', () => {
    const base = key('');
    expect(key('junk=1')).toBe(base);
    expect(key('junk=2&other=x')).toBe(base);
    expect(key('_=1699999999999')).toBe(base);
  });

  it('白名单参数照常参与签名（不同 SQL ⇒ 不同键）', () => {
    const base = key('');
    expect(key('unarchived=true')).not.toBe(base);
    expect(key('folderId=f1')).not.toBe(key('folderId=f2'));
    expect(key('limit=50')).not.toBe(key('limit=100'));
    expect(key('cursor=a')).not.toBe(key('cursor=b'));
  });

  it('垃圾参数与白名单参数混合时，只按白名单部分分桶', () => {
    expect(key('limit=50&junk=1')).toBe(key('limit=50'));
    expect(key('junk=9&limit=50')).toBe(key('limit=50'));
  });
});

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
