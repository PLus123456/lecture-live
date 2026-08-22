import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// U12 回归：深度 readiness 即使仅对内部开放，依赖故障也只回固定 'unavailable'；
// 原始错误（含内网主机名/端口/连接串）只进 logger，绝不出现在报告里。
vi.mock('server-only', () => ({}));

const { queryRawMock, getRedisClientMock, getSiteSettingsMock, loggerErrorMock } = vi.hoisted(
  () => ({
    queryRawMock: vi.fn(),
    getRedisClientMock: vi.fn(),
    getSiteSettingsMock: vi.fn(),
    loggerErrorMock: vi.fn(),
  })
);

vi.mock('@/lib/prisma', () => ({ prisma: { $queryRawUnsafe: queryRawMock } }));
vi.mock('@/lib/redis', () => ({ getRedisClient: getRedisClientMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  serializeError: (e: unknown) => ({ message: e instanceof Error ? e.message : String(e) }),
}));

import { getHealthReport } from '@/lib/health';

describe('getHealthReport — unauthenticated detail masking (U12)', () => {
  const SECRET = 'ECONNREFUSED 10.1.2.3:3306 internal-db.local';
  const origCloudreveUrl = process.env.CLOUDREVE_BASE_URL;
  const origWsProbe = process.env.HEALTH_CHECK_WEBSOCKET;

  beforeEach(() => {
    queryRawMock.mockReset();
    getRedisClientMock.mockReset();
    getSiteSettingsMock.mockReset();
    loggerErrorMock.mockReset();
    queryRawMock.mockRejectedValue(new Error(SECRET));
    getRedisClientMock.mockReturnValue(null); // redis disabled
    getSiteSettingsMock.mockResolvedValue({ storage_mode: 'local', cloudreve_url: '' }); // cloudreve disabled
    delete process.env.CLOUDREVE_BASE_URL;
    process.env.HEALTH_CHECK_WEBSOCKET = '0';
  });

  afterEach(() => {
    if (origCloudreveUrl === undefined) delete process.env.CLOUDREVE_BASE_URL;
    else process.env.CLOUDREVE_BASE_URL = origCloudreveUrl;
    if (origWsProbe === undefined) delete process.env.HEALTH_CHECK_WEBSOCKET;
    else process.env.HEALTH_CHECK_WEBSOCKET = origWsProbe;
    vi.useRealTimers();
  });

  it('marks db down with a fixed "unavailable" detail and never leaks the raw error', async () => {
    const report = await getHealthReport();
    expect(report.dependencies.database.status).toBe('down');
    expect(report.dependencies.database.detail).toBe('unavailable');

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('internal-db.local');
    // raw error must still reach the server log for ops
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it('masks a non-standard Redis PING response', async () => {
    const redisSecret = 'internal-redis-primary.example:6379';
    queryRawMock.mockResolvedValue([{ 1: 1 }]);
    getRedisClientMock.mockReturnValue({
      ping: vi.fn().mockResolvedValue(redisSecret),
    });

    const report = await getHealthReport();
    expect(report.dependencies.redis).toMatchObject({
      status: 'down',
      detail: 'unavailable',
    });
    expect(JSON.stringify(report)).not.toContain(redisSecret);
  });

  it('does not accumulate uncancellable probes after logical timeouts', async () => {
    vi.useFakeTimers();
    let finishQuery!: (value: unknown) => void;
    queryRawMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishQuery = resolve;
        })
    );

    const first = getHealthReport();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await first).dependencies.database.status).toBe('down');

    const second = getHealthReport();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await second).dependencies.database.status).toBe('down');
    expect(queryRawMock).toHaveBeenCalledTimes(1);

    finishQuery([{ 1: 1 }]);
    await vi.runAllTimersAsync();
  });
});
