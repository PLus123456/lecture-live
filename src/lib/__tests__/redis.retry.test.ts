import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P6-3 回归（下半段）：retryStrategy 不得放弃重连。
 *
 * 旧实现 times > 3 返回 null → ioredis 立刻 close()/setStatus('end') 永久放弃；
 * 而 getRedisClient 把实例缓存在 globalThis 从不重建 → 一次 >1.2s 的 `docker restart redis`
 * 就让该进程余生失去 Redis（token 吊销与限流全线降级到进程内存）。
 */

const { redisCtorMock } = vi.hoisted(() => ({
  redisCtorMock: vi.fn(),
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    options: Record<string, unknown>;
    constructor(url: string, options: Record<string, unknown>) {
      this.options = options;
      redisCtorMock(url, options);
    }
    on() {
      return this;
    }
  }
  return { default: FakeRedis };
});

import { getRedisClient } from '@/lib/redis';

type RetryStrategy = (times: number) => number | null | void;

function buildClientOptions(): Record<string, unknown> {
  getRedisClient();
  expect(redisCtorMock).toHaveBeenCalledTimes(1);
  return redisCtorMock.mock.calls[0][1] as Record<string, unknown>;
}

describe('getRedisClient 的重连策略', () => {
  const originalUrl = process.env.REDIS_URL;

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    delete (globalThis as Record<string, unknown>).__lectureLiveRedisClient;
    redisCtorMock.mockClear();
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;
    delete (globalThis as Record<string, unknown>).__lectureLiveRedisClient;
  });

  it('永不返回 null —— 任何次数的失败后都继续重连', () => {
    const retryStrategy = buildClientOptions().retryStrategy as RetryStrategy;
    for (const times of [1, 2, 3, 4, 5, 10, 100, 10_000]) {
      const delay = retryStrategy(times);
      expect(typeof delay).toBe('number');
      expect(Number.isFinite(delay as number)).toBe(true);
      expect(delay as number).toBeGreaterThan(0);
    }
  });

  it('退避递增且封顶，稳态不会打爆 Redis', () => {
    const retryStrategy = buildClientOptions().retryStrategy as RetryStrategy;
    expect(retryStrategy(1) as number).toBeLessThanOrEqual(
      retryStrategy(4) as number
    );
    expect(retryStrategy(1000) as number).toBeLessThanOrEqual(30_000);
    // 封顶后仍要留出足够间隔，避免重连风暴
    expect(retryStrategy(1000) as number).toBeGreaterThanOrEqual(5_000);
  });

  it('没有 REDIS_URL 时返回 null，不创建客户端', () => {
    delete process.env.REDIS_URL;
    expect(getRedisClient()).toBeNull();
    expect(redisCtorMock).not.toHaveBeenCalled();
  });
});
