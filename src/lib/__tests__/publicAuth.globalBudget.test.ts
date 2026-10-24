import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 真实限流器（Redis 不可用 → 进程内内存桶）下的端到端回归：
 * 旧顺序先扣全站桶再看 IP 桶，单个客户端 600 个请求就能把 `auth:public:global` 打满，
 * 其后任何 IP 的登录 / 注册 / 找回密码都 429。
 */

vi.mock('@/lib/redis', () => ({ getRedisClient: () => null }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: async () => ({}) }));
vi.mock('@/lib/logger', () => {
  const noop = () => undefined;
  const child = () => ({ warn: noop, info: noop, error: noop, debug: noop });
  return {
    logger: { child, warn: noop, info: noop, error: noop, debug: noop },
    serializeError: (error: unknown) => error,
  };
});

import { enforcePublicAuthPrelude } from '@/lib/publicAuth';

const MEMORY_STORE_KEY = '__lectureLiveRateLimitStore';

function fromIp(ip: string): Request {
  // 默认 TRUSTED_PROXY_HOPS=1：取 X-Forwarded-For 最右一跳（标准拓扑由本机 nginx 覆盖写入）。
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });
}

const LOGIN_PRELUDE = { scope: 'login', endpointIpLimit: 50, endpointWindowMs: 60_000 };

describe('public auth 全站预算不能被单个客户端耗尽', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[MEMORY_STORE_KEY];
  });

  it('同一 IP 连发 650 次后，其他 IP 的认证请求仍然放行', async () => {
    let attackerRejected = 0;
    for (let i = 0; i < 650; i += 1) {
      const result = await enforcePublicAuthPrelude(fromIp('203.0.113.66'), LOGIN_PRELUDE);
      if (result.response?.status === 429) attackerRejected += 1;
    }

    // 攻击者自己被按 IP 节流（50/min 的端点桶先触发）……
    expect(attackerRejected).toBe(600);
    // ……但它被拒的请求不计入全站桶，别人照常可用。
    const victim = await enforcePublicAuthPrelude(fromIp('198.51.100.7'), LOGIN_PRELUDE);
    expect(victim.response).toBeNull();
    expect(victim.clientIp).toBe('198.51.100.7');
  });

  it('IP 无法解析时全站桶仍是兜底闸门（600/min 后 429）', async () => {
    const unknownIp = () =>
      new Request('http://localhost/api/auth/login', { method: 'POST' });
    let limited = 0;
    for (let i = 0; i < 601; i += 1) {
      const result = await enforcePublicAuthPrelude(unknownIp(), LOGIN_PRELUDE);
      if (result.response?.status === 429) limited += 1;
    }
    expect(limited).toBe(1);
  });
});
