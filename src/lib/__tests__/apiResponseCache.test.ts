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

/* ------------------------------------------------------------------ */
/*  L51：singleflight + 失效时序保护                                     */
/* ------------------------------------------------------------------ */

describe('L51 getOrSetApiCache —— 并发 miss 不再击穿', () => {
  beforeEach(async () => {
    const { __resetApiCacheState } = await import('@/lib/apiResponseCache');
    __resetApiCacheState();
    redisGetMock.mockReset().mockResolvedValue(null); // 恒 miss
    redisSetMock.mockReset().mockResolvedValue('OK');
    redisScanMock.mockReset().mockResolvedValue(['0', []]);
    redisDelMock.mockReset().mockResolvedValue(0);
    getRedisClientMock.mockReturnValue({
      status: 'ready',
      get: redisGetMock,
      set: redisSetMock,
      scan: redisScanMock,
      del: redisDelMock,
    });
  });

  it('同一 key 的并发 miss 只跑一次 loader', async () => {
    const { getOrSetApiCache: get } = await import('@/lib/apiResponseCache');
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { n: calls };
    };

    const results = await Promise.all([
      get('folders:user:u1:list', 30, loader),
      get('folders:user:u1:list', 30, loader),
      get('folders:user:u1:list', 30, loader),
    ]);

    expect(calls).toBe(1);
    expect(results.map((r) => r.value)).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
  });

  it('不同 key 各跑各的', async () => {
    const { getOrSetApiCache: get } = await import('@/lib/apiResponseCache');
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { n: calls };
    };

    await Promise.all([
      get('folders:user:u1:list', 30, loader),
      get('folders:user:u2:list', 30, loader),
    ]);

    expect(calls).toBe(2);
  });

  it('loader 期间发生失效 → 值照常返回但不写回缓存（不复活陈旧数据）', async () => {
    const { getOrSetApiCache: get, invalidateFoldersApiCache: invalidate } =
      await import('@/lib/apiResponseCache');

    let releaseLoader: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });

    const pending = get('folders:user:u1:list', 30, async () => {
      await gate;
      return { stale: true };
    });

    // loader 还没返回时，另一个请求提交了写入并失效了这个前缀
    await invalidate('u1');
    releaseLoader!();

    const result = await pending;
    expect(result.value).toEqual({ stale: true });
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('★ 失效发生在**读缓存**挂起期间（不是 loader 期间）→ 同样不得写回', async () => {
    // 全量套件跑起来时真的挂过这条形态：`await redis.get(...)` 是一个真实挂起点，
    // 失效若落在这个窗口里，而基准时刻取在挂起之后，陈旧值就会被判成「本次加载之后
    // 才产生的新值」照常写回，并带上完整 TTL（删/改之后 30 秒内仍读到旧列表）。
    //
    // 必须显式推进系统时钟：两个时刻落在同一毫秒时 `>=` 会恰好兜住，用例就失去分辨力
    // （第一版正是这样写的，把 startedAt 挪回错误位置也照样绿）。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);

      const { getOrSetApiCache: get, invalidateFoldersApiCache: invalidate } =
        await import('@/lib/apiResponseCache');

      let releaseGet: (() => void) | null = null;
      const getGate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      redisGetMock.mockImplementationOnce(async () => {
        await getGate;
        return null; // miss，随后走 loader
      });

      const pending = get('folders:user:u2:list', 30, async () => ({ stale: true }));

      // 读缓存还挂着的时候，另一路提交了写入并失效了这个前缀
      await invalidate('u2');
      // 失效之后时钟继续走：基准时刻若取在这之后，就会漏判
      vi.setSystemTime(1_005);
      releaseGet!();

      const result = await pending;
      expect(result.value).toEqual({ stale: true });
      expect(redisSetMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有并发失效时照常写回缓存', async () => {
    const { getOrSetApiCache: get } = await import('@/lib/apiResponseCache');
    await get('folders:user:u9:list', 30, async () => ({ ok: 1 }));
    expect(redisSetMock).toHaveBeenCalledTimes(1);
  });
});
