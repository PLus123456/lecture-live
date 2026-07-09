import { beforeEach, describe, expect, it, vi } from 'vitest';

// 可变的假 redis，各用例自行设定 incr/ttl 返回值
const fakeRedis = {
  status: 'ready' as string,
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
};

vi.mock('@/lib/redis', () => ({
  getRedisClient: () => fakeRedis,
}));
vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: () => '203.0.113.7',
}));

import { enforceRateLimit } from '@/lib/rateLimit';

const req = () => new Request('http://localhost/api/x');
const opts = { scope: 'test:scope', limit: 5, windowMs: 60_000 };

describe('enforceRateLimit — Redis 计数窗口', () => {
  beforeEach(() => {
    fakeRedis.status = 'ready';
    fakeRedis.incr.mockReset();
    fakeRedis.expire.mockReset().mockResolvedValue(1);
    fakeRedis.ttl.mockReset();
  });

  it('新建键(count=1)设置过期窗口并放行', async () => {
    fakeRedis.incr.mockResolvedValue(1);
    const res = await enforceRateLimit(req(), opts);
    expect(res).toBeNull();
    expect(fakeRedis.expire).toHaveBeenCalledWith('ratelimit:test:scope:ip:203.0.113.7', 60);
    expect(fakeRedis.ttl).not.toHaveBeenCalled();
  });

  it('窗口内未超限放行，且不重复设过期(健康键 ttl>0)', async () => {
    fakeRedis.incr.mockResolvedValue(3);
    fakeRedis.ttl.mockResolvedValue(42);
    const res = await enforceRateLimit(req(), opts);
    expect(res).toBeNull();
    expect(fakeRedis.expire).not.toHaveBeenCalled();
  });

  it('自愈：已存在键无 TTL(-1) 时补设过期，避免永久无过期卡死', async () => {
    fakeRedis.incr.mockResolvedValue(9999); // 卡死键计数很高
    fakeRedis.ttl.mockResolvedValue(-1);
    const res = await enforceRateLimit(req(), opts);
    // 补了过期 —— 该键将在窗口后到期恢复，不再永久卡死
    expect(fakeRedis.expire).toHaveBeenCalledWith('ratelimit:test:scope:ip:203.0.113.7', 60);
    // 计数仍超限，本次仍 429（下个窗口才恢复）
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it('超限返回 429', async () => {
    fakeRedis.incr.mockResolvedValue(6);
    fakeRedis.ttl.mockResolvedValue(30);
    const res = await enforceRateLimit(req(), opts);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it('绝不用 SET NX（不调用会制造无 TTL 键的 set）', async () => {
    fakeRedis.incr.mockResolvedValue(1);
    // @ts-expect-error 断言 fakeRedis 上没有被误用的 set 调用
    expect(fakeRedis.set).toBeUndefined();
    await enforceRateLimit(req(), opts);
  });
});
