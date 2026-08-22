import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L7：单容器部署里 WS 进程崩掉后 readiness 必须转红，供容器健康检查摘除。
 * 这里锁定 health 报告新增的 websocket 探针，以及 HEALTH_WS_REQUIRED 下的 down 升级。
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
  serializeError: (e: unknown) => ({
    message: e instanceof Error ? e.message : String(e),
  }),
}));
vi.mock('node:net', () => ({ connect: netConnectMock }));

import { getHealthReport } from '@/lib/health';

/** 极简 socket 替身：按 outcome 在下一 tick 派发 connect 或 error。 */
function fakeSocket(outcome: 'connect' | 'error') {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const socket = {
    setTimeout: vi.fn(),
    once: (ev: string, cb: (arg?: unknown) => void) => {
      handlers.set(ev, cb);
      return socket;
    },
    removeAllListeners: vi.fn(),
    destroy: vi.fn(),
  };
  queueMicrotask(() => {
    if (outcome === 'connect') handlers.get('connect')?.();
    else handlers.get('error')?.(new Error('ECONNREFUSED 127.0.0.1:3001'));
  });
  return socket;
}

const ENV_KEYS = [
  'HEALTH_WS_REQUIRED',
  'HEALTH_CHECK_WEBSOCKET',
  'LIVE_SHARE_WS_INTERNAL_URL',
  'WS_PORT',
  'CLOUDREVE_BASE_URL',
] as const;
const saved: Record<string, string | undefined> = {};

describe('getHealthReport — websocket 探针 (L7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    queryRawMock.mockResolvedValue([{ 1: 1 }]);
    getRedisClientMock.mockReturnValue(null);
    getSiteSettingsMock.mockResolvedValue({
      storage_mode: 'local',
      cloudreve_url: '',
    });
    netConnectMock.mockImplementation(() => fakeSocket('connect'));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('WS 端口可连 → websocket up，整体 ok', async () => {
    const report = await getHealthReport();
    expect(report.dependencies.websocket.status).toBe('up');
    expect(report.status).toBe('ok');
    expect(netConnectMock).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3001 });
  });

  it('WS 拒连 → websocket down；默认只降到 degraded', async () => {
    netConnectMock.mockImplementation(() => fakeSocket('error'));
    const report = await getHealthReport();
    expect(report.dependencies.websocket.status).toBe('down');
    expect(report.status).toBe('degraded');
    // 探针错误同样不得把内网地址泄给未授权调用方
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
  });

  it('单容器镜像（HEALTH_WS_REQUIRED=1）下 WS 挂掉 → 整体 down（→ readiness 503）', async () => {
    process.env.HEALTH_WS_REQUIRED = '1';
    netConnectMock.mockImplementation(() => fakeSocket('error'));
    const report = await getHealthReport();
    expect(report.status).toBe('down');
  });

  it('HEALTH_CHECK_WEBSOCKET=0 → disabled，不发起连接也不影响整体状态', async () => {
    process.env.HEALTH_CHECK_WEBSOCKET = '0';
    process.env.HEALTH_WS_REQUIRED = '1';
    const report = await getHealthReport();
    expect(report.dependencies.websocket.status).toBe('disabled');
    expect(report.status).toBe('ok');
    expect(netConnectMock).not.toHaveBeenCalled();
  });

  it('LIVE_SHARE_WS_INTERNAL_URL 优先于 WS_PORT', async () => {
    process.env.WS_PORT = '3001';
    process.env.LIVE_SHARE_WS_INTERNAL_URL = 'http://ws-host:9001';
    await getHealthReport();
    expect(netConnectMock).toHaveBeenCalledWith({ host: 'ws-host', port: 9001 });
  });
});
