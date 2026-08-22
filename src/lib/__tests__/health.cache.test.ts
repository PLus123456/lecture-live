import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M23：`/api/health` 被 middleware 显式放行、无鉴权，而每次调用要做
 * DB `SELECT 1` + Redis PING + **对 Cloudreve 的出站 HTTP HEAD** + WS 端口 TCP 连接。
 * 脚本化高频打它就是一台放大器（尤其那次出站请求），响应还披露依赖拓扑与各依赖延迟。
 *
 * 修法：短 TTL + singleflight 去抖（放大倍数从 O(请求数) 变成 O(时间)），
 * 明细只给带内部凭据的调用方。**不加 enforceRateLimit** —— 429 会让
 * Dockerfile 的 HEALTHCHECK 转红并触发容器重启，等于把 DoS 升级成重启开关。
 */

vi.mock('server-only', () => ({}));

const { queryRawMock, getRedisClientMock, getSiteSettingsMock, netConnectMock } =
  vi.hoisted(() => ({
    queryRawMock: vi.fn(),
    getRedisClientMock: vi.fn(),
    getSiteSettingsMock: vi.fn(),
    netConnectMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({ prisma: { $queryRawUnsafe: queryRawMock } }));
vi.mock('@/lib/redis', () => ({ getRedisClient: getRedisClientMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  serializeError: (e: unknown) => ({ message: String(e) }),
}));
vi.mock('node:net', () => ({ connect: netConnectMock }));

import {
  __resetHealthCache,
  getCachedHealthReport,
  isHealthDetailAuthorized,
  redactHealthReport,
} from '@/lib/health';

function fakeSocket(event: 'connect' | 'error') {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const socket = {
    setTimeout: () => socket,
    once: (name: string, fn: (arg?: unknown) => void) => {
      handlers[name] = fn;
      if (name === event) queueMicrotask(() => fn(new Error('nope')));
      return socket;
    },
    removeAllListeners: () => socket,
    destroy: () => socket,
  };
  return socket;
}

const ENV_KEYS = ['CLOUDREVE_BASE_URL', 'HEALTH_CACHE_TTL_MS', 'HEALTH_DETAIL_TOKEN'];
const saved: Record<string, string | undefined> = {};

describe('M23 getCachedHealthReport —— 去抖 + singleflight', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.clearAllMocks();
    __resetHealthCache();
    queryRawMock.mockResolvedValue([{ 1: 1 }]);
    getRedisClientMock.mockReturnValue(null);
    getSiteSettingsMock.mockResolvedValue({ storage_mode: 'local', cloudreve_url: '' });
    netConnectMock.mockImplementation(() => fakeSocket('connect'));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    __resetHealthCache();
  });

  it('TTL 内的重复调用只体检一次（DB / WS 探针不再被逐次触发）', async () => {
    await getCachedHealthReport();
    await getCachedHealthReport();
    await getCachedHealthReport();

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(netConnectMock).toHaveBeenCalledTimes(1);
  });

  it('并发风暴也只体检一次（singleflight）', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => getCachedHealthReport())
    );
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it('TTL 过期后重新体检（Docker HEALTHCHECK 仍能看到新鲜结论）', async () => {
    process.env.HEALTH_CACHE_TTL_MS = '0';
    await getCachedHealthReport();
    await getCachedHealthReport();
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  });

  it('缓存命中的报告内容与首次一致', async () => {
    const first = await getCachedHealthReport();
    const second = await getCachedHealthReport();
    expect(second).toEqual(first);
  });
});

describe('M23 公开视图裁剪', () => {
  it('默认响应只有 status / checkedAt，不含依赖拓扑与延迟', () => {
    const report = {
      status: 'degraded' as const,
      checkedAt: '2026-08-22T00:00:00.000Z',
      dependencies: {
        database: { status: 'up' as const, latencyMs: 3 },
        redis: { status: 'disabled' as const, latencyMs: null, detail: 'REDIS_URL not configured' },
        cloudreve: { status: 'disabled' as const, latencyMs: null, detail: 'Cloudreve not configured' },
        websocket: { status: 'down' as const, latencyMs: 12, detail: 'unavailable' },
      },
    };

    const publicView = redactHealthReport(report);
    expect(publicView).toEqual({
      status: 'degraded',
      checkedAt: '2026-08-22T00:00:00.000Z',
    });
    const serialized = JSON.stringify(publicView);
    expect(serialized).not.toContain('REDIS_URL');
    expect(serialized).not.toContain('Cloudreve');
    expect(serialized).not.toContain('latencyMs');
  });

  it('未配置 HEALTH_DETAIL_TOKEN 时任何请求都拿不到明细', () => {
    delete process.env.HEALTH_DETAIL_TOKEN;
    const req = new Request('http://localhost/api/health', {
      headers: { 'x-health-token': 'anything' },
    });
    expect(isHealthDetailAuthorized(req)).toBe(false);
  });

  it('配了凭据且匹配才放明细', () => {
    process.env.HEALTH_DETAIL_TOKEN = 'internal-health-token';
    try {
      expect(
        isHealthDetailAuthorized(
          new Request('http://localhost/api/health', {
            headers: { 'x-health-token': 'internal-health-token' },
          })
        )
      ).toBe(true);

      expect(
        isHealthDetailAuthorized(
          new Request('http://localhost/api/health', {
            headers: { 'x-health-token': 'internal-health-tokeN' },
          })
        )
      ).toBe(false);

      expect(
        isHealthDetailAuthorized(new Request('http://localhost/api/health'))
      ).toBe(false);
    } finally {
      delete process.env.HEALTH_DETAIL_TOKEN;
    }
  });
});
