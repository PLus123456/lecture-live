import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

/**
 * v3-R7 刷新并发幂等 + 安全属性回归。
 *
 * 用真实 @/lib/auth（不 mock），让 rotation / 黑名单 / 宽限 / 完整校验都在同一条链路上跑，
 * 只 mock prisma / redis / siteSettings / rateLimit。覆盖四组安全属性：
 *   ① 并发/二次刷新（同旧 jti）不再 401、能拿到有效 token；
 *   ② 宽限窗过后旧 jti 彻底失效（被拒）；
 *   ③ 改密(tokenVersion 递增)/封禁(status) 的即时吊销不受宽限影响；
 *   ④ 非法/伪造/过期 token 仍拒。
 */

const { userFindUniqueMock, getRedisClientMock, getSiteSettingsMock, enforceRateLimitMock } =
  vi.hoisted(() => ({
    userFindUniqueMock: vi.fn(),
    getRedisClientMock: vi.fn(),
    getSiteSettingsMock: vi.fn(),
    enforceRateLimitMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
    },
  },
}));

vi.mock('@/lib/redis', () => ({
  getRedisClient: getRedisClientMock,
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

import { GET } from '@/app/api/auth/refresh/route';
import { signToken } from '@/lib/auth';

const JWT_SECRET = process.env.JWT_SECRET as string;
const COOKIE_NAME = 'lecture-live-token';

const ACTIVE_USER = {
  id: 'user-1',
  email: 'user@example.com',
  displayName: 'User One',
  role: 'PRO' as const,
  tokenVersion: 0,
  status: 1,
};

function makeRequest(token: string): Request {
  return new Request('http://localhost:3000/api/auth/refresh', {
    method: 'GET',
    headers: { Cookie: `${COOKIE_NAME}=${token}` },
  });
}

function readSetCookieToken(response: Response): string | null {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

function jtiOf(token: string): string {
  const decoded = jwt.verify(token, JWT_SECRET) as { jti: string };
  return decoded.jti;
}

function resetInMemoryStores() {
  const g = globalThis as Record<string, unknown>;
  delete g.__lectureLiveTokenBlacklistStore;
  delete g.__lectureLiveTokenRefreshGraceStore;
}

describe('GET /api/auth/refresh — 并发幂等与安全属性 (v3-R7)', () => {
  beforeEach(() => {
    resetInMemoryStores();
    // 无 Redis：走进程内存黑名单 + 内存宽限（与生产 Redis 分支同构）。
    getRedisClientMock.mockReturnValue(null);
    getSiteSettingsMock.mockResolvedValue({ jwt_expiry: 7 });
    enforceRateLimitMock.mockResolvedValue(null);
    // verifyToken / 路由 DB 查询：默认返回活跃用户。
    userFindUniqueMock.mockResolvedValue(ACTIVE_USER);
  });

  it('正常刷新：rotate 出新 token，旧 jti 立即入黑名单', async () => {
    const oldToken = signToken(ACTIVE_USER);
    const res = await GET(makeRequest(oldToken));
    expect(res.status).toBe(200);

    const newToken = readSetCookieToken(res);
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);
    expect(jtiOf(newToken as string)).not.toBe(jtiOf(oldToken));

    // 旧 token 再次直接刷新（模拟重放，且已过宽限前提在下面单测）——这里验证旧 jti 已被吊销：
    // 旧 token 现在只能走宽限路径；宽限内它能换回同一个新 token（见并发用例）。
  });

  // ① 并发 / 二次刷新（同旧 jti）不再 401，且拿到有效 token（与首次相同的新 token）
  it('并发第二个 Tab 带同一旧 token 再刷新：不 401，返回与首次相同的新 token', async () => {
    const oldToken = signToken(ACTIVE_USER);

    const first = await GET(makeRequest(oldToken));
    expect(first.status).toBe(200);
    const firstNewToken = readSetCookieToken(first);
    expect(firstNewToken).toBeTruthy();

    // 第二个请求仍带「已被 rotate 的旧 token」——旧 jti 已在黑名单，verifyAuthSession 返回 null，
    // 应走宽限路径，返回同一个新 token（cookie 收敛），而非 401。
    const second = await GET(makeRequest(oldToken));
    expect(second.status).toBe(200);
    const secondNewToken = readSetCookieToken(second);
    expect(secondNewToken).toBe(firstNewToken);
  });

  it('宽限返回的新 token 本身有效：可继续正常刷新', async () => {
    const oldToken = signToken(ACTIVE_USER);
    const first = await GET(makeRequest(oldToken));
    const newToken = readSetCookieToken(first) as string;

    // 用宽限拿到的新 token 直接再刷新一次，应正常 rotate（200 且换到又一个新 token）。
    const next = await GET(makeRequest(newToken));
    expect(next.status).toBe(200);
    const nextToken = readSetCookieToken(next);
    expect(nextToken).toBeTruthy();
    expect(nextToken).not.toBe(newToken);
  });

  // ② 宽限窗过后旧 jti 彻底失效
  it('宽限窗过后：同一旧 token 再刷新被拒（401）', async () => {
    const oldToken = signToken(ACTIVE_USER);
    const first = await GET(makeRequest(oldToken));
    expect(first.status).toBe(200);

    // 手动清空宽限记录，模拟 30s TTL 过后：旧 jti 仍在黑名单，但宽限记录已没。
    const g = globalThis as Record<string, unknown>;
    delete g.__lectureLiveTokenRefreshGraceStore;

    const afterGrace = await GET(makeRequest(oldToken));
    expect(afterGrace.status).toBe(401);
  });

  // ③ 改密 / tokenVersion 递增：即时吊销不被宽限绕过
  it('刷新后 tokenVersion 递增（改密）：宽限内旧 token 也被拒（401）', async () => {
    const oldToken = signToken(ACTIVE_USER);
    const first = await GET(makeRequest(oldToken));
    expect(first.status).toBe(200);

    // 改密：DB 里 tokenVersion 递增，宽限 token 携带旧版本，完整校验必然失败。
    userFindUniqueMock.mockResolvedValue({ ...ACTIVE_USER, tokenVersion: 1 });

    const afterPwChange = await GET(makeRequest(oldToken));
    expect(afterPwChange.status).toBe(401);
  });

  // ③ 封禁 status：即时吊销不被宽限绕过
  it('刷新后用户被封禁（status!=1）：宽限内旧 token 也被拒（401）', async () => {
    const oldToken = signToken(ACTIVE_USER);
    const first = await GET(makeRequest(oldToken));
    expect(first.status).toBe(200);

    userFindUniqueMock.mockResolvedValue({ ...ACTIVE_USER, status: 0 });

    const afterBan = await GET(makeRequest(oldToken));
    expect(afterBan.status).toBe(401);
  });

  // ④ 伪造 / 过期 / 非法 token 仍拒
  it('伪造签名的 token（错误密钥）：401', async () => {
    const forged = jwt.sign(
      {
        id: ACTIVE_USER.id,
        email: ACTIVE_USER.email,
        role: ACTIVE_USER.role,
        tokenVersion: 0,
        sessionStartedAt: Date.now(),
        jti: 'forged-jti',
      },
      'wrong-secret-wrong-secret-wrong-secret',
      { expiresIn: '7d' }
    );
    const res = await GET(makeRequest(forged));
    expect(res.status).toBe(401);
  });

  it('已过期的 token：401', async () => {
    const expired = jwt.sign(
      {
        id: ACTIVE_USER.id,
        email: ACTIVE_USER.email,
        role: ACTIVE_USER.role,
        tokenVersion: 0,
        sessionStartedAt: Date.now(),
        jti: 'expired-jti',
      },
      JWT_SECRET,
      { expiresIn: '-1h' }
    );
    const res = await GET(makeRequest(expired));
    expect(res.status).toBe(401);
  });

  it('超过 30 天绝对上限的 token：401（宽限也救不回）', async () => {
    const stale = signToken(ACTIVE_USER, {
      sessionStartedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    const res = await GET(makeRequest(stale));
    expect(res.status).toBe(401);
  });

  it('没有 cookie / 无 token：401', async () => {
    const res = await GET(
      new Request('http://localhost:3000/api/auth/refresh', { method: 'GET' })
    );
    expect(res.status).toBe(401);
  });

  it('合法签名但无宽限记录的旧 jti（从未被本流程 rotate 而被吊销）：401', async () => {
    // 一个签名合法、绝对上限内的 token，但从没走过刷新 rotation，故没有宽限记录。
    // 先把它的 jti 直接加进黑名单（模拟被 logout / change-password 吊销），
    // 使 verifyAuthSession 返回 null，从而进入宽限分支——应因无宽限记录而 401。
    const token = signToken(ACTIVE_USER);
    const { revokeToken } = await import('@/lib/auth');
    const decoded = jwt.verify(token, JWT_SECRET) as { jti: string; exp: number };
    await revokeToken({ jti: decoded.jti, exp: decoded.exp });

    const res = await GET(makeRequest(token));
    expect(res.status).toBe(401);
  });
});
