import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #13：设备指纹此前是 sha256(ip|ua)，移动网络换 IP 就判成新设备。
 * 而 security_alert 是 transactional（用户关不掉），误报代价极高。
 */

const { getRedisClientMock, resolveRequestClientIpMock, sendSecurityAlertEmailMock } =
  vi.hoisted(() => ({
    getRedisClientMock: vi.fn(),
    resolveRequestClientIpMock: vi.fn(),
    sendSecurityAlertEmailMock: vi.fn(),
  }));

vi.mock('@/lib/redis', () => ({ getRedisClient: getRedisClientMock }));
vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: resolveRequestClientIpMock,
}));
vi.mock('@/lib/email', () => ({
  sendSecurityAlertEmail: sendSecurityAlertEmailMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => e,
}));

import { maybeNotifyNewDeviceLogin } from '@/lib/email/loginAlert';

/** 够用的内存版 Redis 集合替身（只实现本模块用到的命令）。 */
function createFakeRedis() {
  const sets = new Map<string, Set<string>>();
  return {
    status: 'ready' as const,
    sets,
    sismember: vi.fn(async (key: string, m: string) => (sets.get(key)?.has(m) ? 1 : 0)),
    scard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
    sadd: vi.fn(async (key: string, m: string) => {
      const s = sets.get(key) ?? new Set<string>();
      sets.set(key, s);
      const had = s.has(m);
      s.add(m);
      return had ? 0 : 1;
    }),
    expire: vi.fn(async () => 1),
    spop: vi.fn(async (key: string) => {
      const s = sets.get(key);
      const first = s?.values().next().value;
      if (s && first !== undefined) s.delete(first);
      return first ?? null;
    }),
  };
}

const USER = { id: 'u1', email: 'user@example.com', displayName: '张三' };

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

function requestWith(userAgent: string): Request {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: userAgent ? { 'user-agent': userAgent } : {},
  });
}

/** 登录一次（先设定本次来源 IP）。 */
async function login(ip: string, userAgent: string) {
  resolveRequestClientIpMock.mockReturnValue(ip);
  await maybeNotifyNewDeviceLogin(USER, requestWith(userAgent));
}

describe('maybeNotifyNewDeviceLogin — 设备指纹（#13）', () => {
  let redis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createFakeRedis();
    getRedisClientMock.mockReturnValue(redis);
    sendSecurityAlertEmailMock.mockResolvedValue({ ok: true });
  });

  it('首次登录只播种、不提醒', async () => {
    await login('1.1.1.1', CHROME_MAC);
    expect(sendSecurityAlertEmailMock).not.toHaveBeenCalled();
  });

  // 本 bug 的核心场景：同一台手机在移动网络下每次登录 IP 都不同。
  it('同一 UA 换 IP 不再判为新设备（移动网络不误报）', async () => {
    await login('1.1.1.1', SAFARI_IOS); // 播种
    sendSecurityAlertEmailMock.mockClear();

    await login('2.2.2.2', SAFARI_IOS);
    await login('3.3.3.3', SAFARI_IOS);
    await login('240e:1:2:3::9', SAFARI_IOS);

    expect(sendSecurityAlertEmailMock).not.toHaveBeenCalled();
  });

  it('换 UA 仍然告警（真·新设备不漏报）', async () => {
    await login('1.1.1.1', CHROME_MAC); // 播种
    await login('1.1.1.1', SAFARI_IOS);

    expect(sendSecurityAlertEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSecurityAlertEmailMock.mock.calls[0][1]).toMatchObject({
      kind: 'new_device_login',
      ip: '1.1.1.1', // IP 不进指纹，但仍要出现在告警内容里
    });
  });

  it('UA 为空时整体跳过（指纹无意义）', async () => {
    await login('1.1.1.1', '');
    expect(sendSecurityAlertEmailMock).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
  });

  it('IP 不可解析（unknown）也不影响识别同一设备', async () => {
    await login('unknown', CHROME_MAC);
    sendSecurityAlertEmailMock.mockClear();

    await login('unknown', CHROME_MAC);
    expect(sendSecurityAlertEmailMock).not.toHaveBeenCalled();
  });

  // 换指纹口径必须换 key 代际，否则存量用户下次登录全部命中「未命中且集合非空」→ 全站群发误报。
  it('使用 v2 key 前缀，避免改版时对存量用户群发误报', async () => {
    await login('1.1.1.1', CHROME_MAC);
    expect([...redis.sets.keys()]).toEqual(['auth:known-devices:v2:u1']);
  });

  it('Redis 不可用时静默跳过，不阻塞登录', async () => {
    getRedisClientMock.mockReturnValue(null);
    await expect(login('1.1.1.1', CHROME_MAC)).resolves.toBeUndefined();
    expect(sendSecurityAlertEmailMock).not.toHaveBeenCalled();
  });
});
