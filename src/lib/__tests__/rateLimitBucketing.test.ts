import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

/**
 * H7（= AUDIT_MERGED_BACKLOG_20260815 的 C1 根因簇）：
 * `resolveRequestClientIp` 在 TRUSTED_PROXY 缺省（false）时恒返回 'unknown'，
 * 于是 `enforceRateLimit` 的默认 key `ip:unknown` 让**所有不带自定义 key 的路由**
 * 塌缩成全站一个桶：
 *   - 匿名者连打 120 次 /api/share/view/任意token → 全站分享页一起 429；
 *   - 所有用户的 LLM 报告生成共享 10 次/分钟。
 *
 * 这里的验收标准就一条：**trusted_proxy=false 时，两个不相干的来源不得落进同一个桶。**
 */

const fakeRedis = {
  status: 'ready' as string,
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
};

vi.mock('@/lib/redis', () => ({ getRedisClient: () => fakeRedis }));
// 代理拓扑现在完全来自环境变量（TRUSTED_PROXY_HOPS / TRUSTED_PROXY_CIDRS），
// 不再有数据库 trusted_proxy 布尔；prisma 桩仅为满足模块依赖。
vi.mock('@/lib/prisma', () => ({
  prisma: { siteSetting: { findUnique: async () => null } },
}));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: async () => ({ rate_limit_api: 60 }) }));

import { enforceRateLimit, resolveRateLimitClientKey } from '@/lib/rateLimit';

const TEST_SECRET = 'test-jwt-secret-for-rate-limit-bucketing-0123456789';

function signFor(userId: string): string {
  return jwt.sign(
    { id: userId, email: `${userId}@example.com`, role: 'FREE', tokenVersion: 0 },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

const OPTS = { scope: 'test:scope', limit: 5, windowMs: 60_000 };

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['TRUSTED_PROXY_HOPS', 'TRUSTED_PROXY_CIDRS', 'JWT_SECRET'];

beforeEach(() => {
  for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];
  process.env.JWT_SECRET = TEST_SECRET;
  // 缺省按「直连、不经代理」跑：HTTP 侧不采信任何代理头，等价于旧的 TRUSTED_PROXY=false。
  process.env.TRUSTED_PROXY_HOPS = '0';
  delete process.env.TRUSTED_PROXY_CIDRS;

  fakeRedis.status = 'ready';
  fakeRedis.incr.mockReset().mockResolvedValue(1);
  fakeRedis.expire.mockReset().mockResolvedValue(1);
  fakeRedis.ttl.mockReset().mockResolvedValue(30);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key]!;
  }
});

/** 拿到本次 enforceRateLimit 实际用的 Redis bucket key。 */
async function bucketKeyFor(request: Request): Promise<string> {
  fakeRedis.incr.mockClear();
  await enforceRateLimit(request, OPTS);
  expect(fakeRedis.incr).toHaveBeenCalledTimes(1);
  return fakeRedis.incr.mock.calls[0][0] as string;
}

describe('H7 —— trusted_proxy=false 时默认桶不再塌缩', () => {
  it('两个不同的已登录用户落进两个不同的桶（不再共享 ip:unknown）', async () => {
    const a = await bucketKeyFor(
      req('http://localhost/api/llm/report', {
        authorization: `Bearer ${signFor('user-a')}`,
      })
    );
    const b = await bucketKeyFor(
      req('http://localhost/api/llm/report', {
        authorization: `Bearer ${signFor('user-b')}`,
      })
    );

    expect(a).not.toBe(b);
    expect(a).toContain('sub:user-a');
    expect(b).toContain('sub:user-b');
    // 关键回归点：任何一个都不能是旧的全站单桶
    expect(a).not.toContain('ip:unknown');
    expect(b).not.toContain('ip:unknown');
  });

  it('同一个用户的多次请求仍然共用同一个桶（限流本身要生效）', async () => {
    const token = signFor('user-a');
    const first = await bucketKeyFor(
      req('http://localhost/api/llm/report', { authorization: `Bearer ${token}` })
    );
    const second = await bucketKeyFor(
      req('http://localhost/api/llm/report', { authorization: `Bearer ${token}` })
    );

    expect(first).toBe(second);
  });

  it('匿名公开路由按资源分桶：两个分享 token 互不影响', async () => {
    const a = await bucketKeyFor(req('http://localhost/api/share/view/TOKEN-AAA'));
    const b = await bucketKeyFor(req('http://localhost/api/share/view/TOKEN-BBB'));

    expect(a).not.toBe(b);
    expect(a).not.toContain('ip:unknown');
    expect(b).not.toContain('ip:unknown');
  });

  it('同一个分享链接的多次访问仍然共用一个桶', async () => {
    const a = await bucketKeyFor(req('http://localhost/api/share/view/TOKEN-AAA'));
    const b = await bucketKeyFor(
      req('http://localhost/api/share/view/TOKEN-AAA?x=1')
    );
    expect(a).toBe(b);
  });

  it('分享 token 不会明文落进 Redis key（路径先哈希）', async () => {
    const key = await bucketKeyFor(
      req('http://localhost/api/share/view/SUPER-SECRET-TOKEN')
    );
    expect(key).not.toContain('SUPER-SECRET-TOKEN');
    expect(key).toMatch(/anon:[0-9a-f]{16}$/);
  });

  it('伪造/无效签名的 token 换不出新桶（退回路径维度）', async () => {
    const forged = jwt.sign({ id: 'attacker-1' }, 'wrong-secret-wrong-secret-xx', {
      algorithm: 'HS256',
    });
    const anonymous = await bucketKeyFor(req('http://localhost/api/llm/report'));
    const withForged = await bucketKeyFor(
      req('http://localhost/api/llm/report', { authorization: `Bearer ${forged}` })
    );

    expect(withForged).toBe(anonymous);
    expect(withForged).toMatch(/anon:/);
  });

  it('过期 token 同样不被采信', async () => {
    const expired = jwt.sign({ id: 'user-a' }, TEST_SECRET, {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    const key = await bucketKeyFor(
      req('http://localhost/api/llm/report', {
        authorization: `Bearer ${expired}`,
      })
    );
    expect(key).toMatch(/anon:/);
    expect(key).not.toContain('sub:');
  });

  it('cookie 会话哨兵值不会被当成 token', async () => {
    const key = await bucketKeyFor(
      req('http://localhost/api/llm/report', {
        authorization: 'Bearer __cookie_session__',
      })
    );
    expect(key).toMatch(/anon:/);
  });

  it('显式传 key 的路由完全不受影响（auth/login 等）', async () => {
    fakeRedis.incr.mockClear();
    await enforceRateLimit(req('http://localhost/api/auth/login'), {
      ...OPTS,
      scope: 'auth:login',
      key: 'email:a@b.c',
    });
    expect(fakeRedis.incr.mock.calls[0][0]).toBe(
      'ratelimit:auth:login:email:a@b.c'
    );
  });
});

describe('H7 —— 可信代理开启时行为不变（回归）', () => {
  // 新模型：TRUSTED_PROXY_HOPS=1 表示「客户端 → 本机 nginx → 应用」固定一跳。
  // nginx 模板对两个头都用 proxy_set_header 覆盖成 $remote_addr，所以它们必然一致；
  // 只给 X-Real-IP、不给 XFF 是**配置错误**，此时按 fail-closed 归入 anon 桶。
  function proxied(ip: string, headers: Record<string, string> = {}) {
    return req('http://localhost/api/llm/report', {
      'x-forwarded-for': ip,
      'x-real-ip': ip,
      ...headers,
    });
  }

  it('反代覆盖过的来源 IP 仍然是 ip: 桶', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const key = await bucketKeyFor(proxied('203.0.113.7'));
    expect(key).toBe('ratelimit:test:scope:ip:203.0.113.7');
  });

  it('两个不同来源 IP 分属两个桶', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const a = await bucketKeyFor(proxied('203.0.113.7'));
    const b = await bucketKeyFor(proxied('198.51.100.9'));
    expect(a).not.toBe(b);
  });

  it('真实 IP 优先于 JWT 身份（同一用户换 IP 不共享桶）', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const token = signFor('user-a');
    const key = await bucketKeyFor(
      proxied('203.0.113.7', { authorization: `Bearer ${token}` })
    );
    expect(key).toContain('ip:203.0.113.7');
  });

  it('两个代理头互相矛盾时 fail-closed（攻击者伪造其一换不出桶）', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const key = resolveRateLimitClientKey(
      req('http://localhost/api/x', {
        'x-forwarded-for': '203.0.113.7',
        'x-real-ip': '1.2.3.4',
      })
    );
    expect(key).not.toContain('ip:203.0.113.7');
    expect(key).not.toContain('ip:1.2.3.4');
  });
});

describe('M22 —— 可信代理头的取值收窄', () => {
  function proxied(url: string, ip: string) {
    return req(url, { 'x-forwarded-for': ip, 'x-real-ip': ip });
  }

  it('非 IP 字面量不再被当成来源（换不出无穷个桶）', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const a = resolveRateLimitClientKey(
      proxied('http://localhost/api/share/view/T', 'bucket-aaaa')
    );
    const b = resolveRateLimitClientKey(
      proxied('http://localhost/api/share/view/T', 'bucket-bbbb')
    );
    expect(a).toBe(b);
    expect(a).toMatch(/anon:/);
  });

  it('带端口 / IPv4-mapped 的写法归一到同一个桶', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const plain = resolveRateLimitClientKey(proxied('http://localhost/api/x', '203.0.113.7'));
    const withPort = resolveRateLimitClientKey(
      proxied('http://localhost/api/x', '203.0.113.7:51234')
    );
    const mapped = resolveRateLimitClientKey(
      proxied('http://localhost/api/x', '::ffff:203.0.113.7')
    );
    expect(withPort).toBe(plain);
    expect(mapped).toBe(plain);
  });

  it('HOPS=0（直连部署）时代理头一律不采信', async () => {
    process.env.TRUSTED_PROXY_HOPS = '0';
    const key = resolveRateLimitClientKey(
      req('http://localhost/api/x', {
        'x-forwarded-for': '203.0.113.7',
        'x-real-ip': '203.0.113.7',
      })
    );
    expect(key).not.toContain('ip:203.0.113.7');
  });
});

describe('L50 —— Redis 不可用时的降级姿态可选 fail-closed', () => {
  it('缺省仍 fail-open（退到内存计数，首次放行）', async () => {
    fakeRedis.status = 'end';
    const res = await enforceRateLimit(
      req(`http://localhost/api/x/${Math.random()}`),
      OPTS
    );
    expect(res).toBeNull();
  });

  it('RATE_LIMIT_FAIL_CLOSED=1 时 Redis 不可用直接 429', async () => {
    fakeRedis.status = 'end';
    process.env.RATE_LIMIT_FAIL_CLOSED = '1';
    try {
      const res = await enforceRateLimit(
        req(`http://localhost/api/x/${Math.random()}`),
        OPTS
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(429);
    } finally {
      delete process.env.RATE_LIMIT_FAIL_CLOSED;
    }
  });
});
