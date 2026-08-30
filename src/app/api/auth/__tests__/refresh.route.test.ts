import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  familyFindUnique: vi.fn(),
  familyCreate: vi.fn(),
  familyUpdateMany: vi.fn(),
  familyUpsert: vi.fn(),
  getRedisClient: vi.fn(),
  getSiteSettings: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    authTokenFamily: {
      findUnique: mocks.familyFindUnique,
      create: mocks.familyCreate,
      updateMany: mocks.familyUpdateMany,
      upsert: mocks.familyUpsert,
    },
  },
}));
vi.mock('@/lib/redis', () => ({ getRedisClient: mocks.getRedisClient }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: mocks.getSiteSettings }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));

import { GET, POST } from '@/app/api/auth/refresh/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import {
  diagnoseEstablishedAuthFamilyToken,
  getAuthTokenSessionBinding,
  issueAuthToken,
  revokeToken,
  signToken,
  verifyAuthToken,
  verifyEstablishedAuthFamilyToken,
} from '@/lib/auth';

const JWT_SECRET = process.env.JWT_SECRET as string;
const COOKIE_NAME = 'lecture-live-token';
const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVE_USER = {
  id: 'user-1',
  email: 'user@example.com',
  displayName: 'User One',
  role: 'PRO' as const,
  tokenVersion: 0,
  status: 1,
};

interface FamilyRow {
  id: string;
  userId: string;
  currentJtiHash: string;
  legacyJtiHash: string | null;
  generation: number;
  sessionStartedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

const families = new Map<string, FamilyRow>();

function p2002(): Error & { code: string } {
  return Object.assign(new Error('unique constraint'), { code: 'P2002' });
}

function installFamilyDb() {
  mocks.familyFindUnique.mockImplementation(async ({ where }) => {
    if (where.id) return families.get(where.id) ?? null;
    if (where.legacyJtiHash) {
      return (
        [...families.values()].find(
          (row) => row.legacyJtiHash === where.legacyJtiHash
        ) ?? null
      );
    }
    return null;
  });

  mocks.familyCreate.mockImplementation(async ({ data }) => {
    if (
      families.has(data.id) ||
      [...families.values()].some(
        (row) =>
          row.currentJtiHash === data.currentJtiHash ||
          (data.legacyJtiHash && row.legacyJtiHash === data.legacyJtiHash)
      )
    ) {
      throw p2002();
    }
    const row: FamilyRow = {
      id: data.id,
      userId: data.userId,
      currentJtiHash: data.currentJtiHash,
      legacyJtiHash: data.legacyJtiHash ?? null,
      generation: data.generation ?? 0,
      sessionStartedAt: data.sessionStartedAt,
      expiresAt: data.expiresAt,
      revokedAt: data.revokedAt ?? null,
      revokedReason: data.revokedReason ?? null,
    };
    families.set(row.id, row);
    return row;
  });

  mocks.familyUpdateMany.mockImplementation(async ({ where, data }) => {
    let count = 0;
    for (const row of families.values()) {
      if (where.id !== undefined && row.id !== where.id) continue;
      if (where.userId !== undefined && row.userId !== where.userId) continue;
      if (
        where.currentJtiHash !== undefined &&
        row.currentJtiHash !== where.currentJtiHash
      ) continue;
      if (
        where.generation !== undefined &&
        row.generation !== where.generation
      ) {
        continue;
      }
      if (where.revokedAt === null && row.revokedAt !== null) continue;
      if (
        where.expiresAt?.equals &&
        row.expiresAt.getTime() !== where.expiresAt.equals.getTime()
      ) continue;
      if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) continue;
      if (data.currentJtiHash !== undefined) {
        row.currentJtiHash = data.currentJtiHash;
      }
      if (typeof data.generation === 'object') {
        row.generation += data.generation.increment;
      } else if (data.generation !== undefined) {
        row.generation = data.generation;
      }
      if (data.revokedAt !== undefined) row.revokedAt = data.revokedAt;
      if (data.revokedReason !== undefined) row.revokedReason = data.revokedReason;
      count += 1;
    }
    return { count };
  });
}

function makeRequest(token: string): Request {
  const binding = getAuthTokenSessionBinding(token) ?? 'invalid-binding';
  return new Request('http://localhost:3000/api/auth/refresh', {
    method: 'POST',
    headers: {
      Cookie: `${COOKIE_NAME}=${token}`,
      'X-Lecture-Live-Auth-Session': binding,
    },
  });
}

function makeLogoutRequest(token: string): Request {
  const binding = getAuthTokenSessionBinding(token);
  if (!binding) throw new Error('family binding missing');
  return new Request('http://localhost:3000/api/auth/logout', {
    method: 'POST',
    headers: {
      Cookie: `${COOKIE_NAME}=${token}`,
      'X-Lecture-Live-Auth-Session': binding,
    },
  });
}

function readSetCookieToken(response: Response): string | null {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie?.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

function decode(token: string) {
  return jwt.verify(token, JWT_SECRET) as {
    id: string;
    jti: string;
    exp: number;
    sessionStartedAt: number;
    familyId?: string;
    generation?: number;
  };
}

beforeEach(() => {
  families.clear();
  vi.clearAllMocks();
  installFamilyDb();
  mocks.userFindUnique.mockResolvedValue(ACTIVE_USER);
  mocks.getRedisClient.mockReturnValue(null);
  mocks.getSiteSettings.mockResolvedValue({ jwt_expiry: 7 });
  mocks.enforceRateLimit.mockResolvedValue(null);
  delete (globalThis as Record<string, unknown>).__lectureLiveTokenBlacklistStore;
});

describe('POST /api/auth/refresh — 持久 family / CAS / reuse', () => {
  it('跨站顶层 GET 即使并发也只返回 405，不轮换、不撤族、不清 cookie', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    const familyId = decode(token).familyId as string;

    const responses = await Promise.all([GET(), GET()]);

    expect(responses.map((response) => response.status)).toEqual([405, 405]);
    expect(responses.every((response) => !response.headers.has('set-cookie'))).toBe(true);
    expect(families.get(familyId)).toMatchObject({
      generation: 0,
      revokedAt: null,
    });
    expect((await verifyAuthToken(token))?.user.id).toBe(ACTIVE_USER.id);
  });

  it('POST 缺失或错配 family binding 时在 DB/CAS 前拒绝且不清 cookie', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    const familyId = decode(token).familyId as string;
    const withoutBinding = new Request(
      'http://localhost:3000/api/auth/refresh',
      {
        method: 'POST',
        headers: { Cookie: `${COOKIE_NAME}=${token}` },
      }
    );
    const mismatched = new Request(
      'http://localhost:3000/api/auth/refresh',
      {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_NAME}=${token}`,
          'X-Lecture-Live-Auth-Session': 'binding-for-another-family',
        },
      }
    );

    const missingResponse = await POST(withoutBinding);
    const mismatchResponse = await POST(mismatched);

    expect(missingResponse.status).toBe(428);
    expect(mismatchResponse.status).toBe(409);
    expect(missingResponse.headers.get('set-cookie')).toBeNull();
    expect(mismatchResponse.headers.get('set-cookie')).toBeNull();
    expect(families.get(familyId)).toMatchObject({
      generation: 0,
      revokedAt: null,
    });
  });

  it('跨站 form POST 无 cookie/自定义 binding 时返回 403，响应不得清目标站 cookie/cache', async () => {
    mocks.familyFindUnique.mockClear();
    mocks.familyUpdateMany.mockClear();
    const crossSiteForm = new Request(
      'http://localhost:3000/api/auth/refresh',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: 'rotate=1',
      }
    );

    const response = await POST(crossSiteForm);

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
    expect(mocks.familyFindUnique).not.toHaveBeenCalled();
    expect(mocks.familyUpdateMany).not.toHaveBeenCalled();
  });

  it('正常刷新只 CAS 轮换同一 family 的 current leaf', async () => {
    const oldToken = await issueAuthToken(ACTIVE_USER);
    const old = decode(oldToken);

    const response = await POST(makeRequest(oldToken));
    expect(response.status).toBe(200);
    expect(response.headers.get('clear-site-data')).toBe('"cache"');
    const nextToken = readSetCookieToken(response) as string;
    const next = decode(nextToken);

    expect(next.familyId).toBe(old.familyId);
    expect(next.generation).toBe(1);
    expect(next.jti).not.toBe(old.jti);
    expect(families.get(old.familyId as string)).toMatchObject({
      generation: 1,
      revokedAt: null,
    });
    expect(await verifyAuthToken(oldToken)).toBeNull();
    expect((await verifyEstablishedAuthFamilyToken(oldToken))?.user.id).toBe(
      ACTIVE_USER.id
    );
    expect((await verifyAuthToken(nextToken))?.user.id).toBe(ACTIVE_USER.id);
  });

  it('既有连接在 routine rotation 后保活，但该设备 logout 后立即拒绝旧 leaf', async () => {
    const oldToken = await issueAuthToken(ACTIVE_USER);
    const response = await POST(makeRequest(oldToken));
    const successor = readSetCookieToken(response) as string;

    expect(response.status).toBe(200);
    expect(await verifyAuthToken(oldToken)).toBeNull();
    expect((await verifyEstablishedAuthFamilyToken(oldToken))?.user.id).toBe(
      ACTIVE_USER.id
    );

    await revokeToken(decode(successor), { reason: 'logout' });

    expect(await verifyEstablishedAuthFamilyToken(oldToken)).toBeNull();
    expect(await verifyEstablishedAuthFamilyToken(successor)).toBeNull();
  });

  it('同一叶子并发刷新只签出一个 winner；loser 检测重用并撤整族', async () => {
    const oldToken = await issueAuthToken(ACTIVE_USER);
    const familyId = decode(oldToken).familyId as string;

    const responses = await Promise.all([
      POST(makeRequest(oldToken)),
      POST(makeRequest(oldToken)),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 401]);
    expect(families.get(familyId)?.revokedReason).toBe('refresh_reuse');

    const winner = responses.find((res) => res.status === 200) as Response;
    const successor = readSetCookieToken(winner) as string;
    expect(await verifyAuthToken(successor)).toBeNull();
    expect(await verifyEstablishedAuthFamilyToken(oldToken)).toBeNull();
    expect(await verifyEstablishedAuthFamilyToken(successor)).toBeNull();
  });

  it('refresh 先赢 CAS 时，受害者仍可用已消费旧 leaf logout 撤整族', async () => {
    const victimToken = await issueAuthToken(ACTIVE_USER);
    const familyId = decode(victimToken).familyId as string;
    const findFamily = mocks.familyFindUnique.getMockImplementation();
    if (!findFamily) throw new Error('family DB mock missing');

    let releaseLogoutLookup!: () => void;
    let markLogoutLookupStarted!: () => void;
    const logoutLookupStarted = new Promise<void>((resolve) => {
      markLogoutLookupStarted = resolve;
    });
    const holdLogoutLookup = new Promise<void>((resolve) => {
      releaseLogoutLookup = resolve;
    });
    mocks.familyFindUnique.mockImplementationOnce(async (args) => {
      markLogoutLookupStarted();
      await holdLogoutLookup;
      return findFamily(args);
    });

    // victim 的 logout 已带 g0/binding，但其 family 查询暂时卡住；攻击者用窃取的
    // 同一个 g0 完成 CAS→g1。释放后 logout 必须允许已消费 g0 并按 familyId 撤整族。
    const victimLogout = logout(makeLogoutRequest(victimToken));
    await logoutLookupStarted;
    const attackerRefresh = await POST(makeRequest(victimToken));
    expect(attackerRefresh.status).toBe(200);
    const attackerSuccessor = readSetCookieToken(attackerRefresh) as string;

    releaseLogoutLookup();
    const logoutResponse = await victimLogout;

    expect(logoutResponse.status).toBe(200);
    expect(families.get(familyId)).toMatchObject({
      generation: 1,
      revokedReason: 'logout',
    });
    expect(await verifyAuthToken(attackerSuccessor)).toBeNull();
  });

  it('旧 leaf 自然过期后仍可作为 logout 凭据撤销同 family 的 live successor', async () => {
    const oldToken = await issueAuthToken(ACTIVE_USER);
    const refreshed = await POST(makeRequest(oldToken));
    const successor = readSetCookieToken(refreshed) as string;
    const payload = jwt.decode(oldToken) as Record<string, unknown>;
    const expiredOldLeaf = jwt.sign(
      { ...payload, exp: Math.floor(Date.now() / 1000) - 1 },
      JWT_SECRET,
      { algorithm: 'HS256', noTimestamp: true }
    );

    const response = await logout(makeLogoutRequest(expiredOldLeaf));

    expect(response.status).toBe(200);
    expect(await verifyAuthToken(successor)).toBeNull();
  });

  it('浏览器当前 cookie 已是 B 时，迟到 binding-A 仍只撤 A 且绝不写/清 B', async () => {
    const deviceA = await issueAuthToken(ACTIVE_USER);
    const deviceB = await issueAuthToken(ACTIVE_USER);
    const bindingA = getAuthTokenSessionBinding(deviceA);
    if (!bindingA) throw new Error('family binding missing');

    const response = await logout(
      new Request('http://localhost:3000/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_NAME}=${deviceB}`,
          'X-Lecture-Live-Auth-Session': bindingA,
        },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
    expect(await verifyAuthToken(deviceA)).toBeNull();
    expect((await verifyAuthToken(deviceB))?.user.id).toBe(ACTIVE_USER.id);
  });

  it('两个 logout 都先读到 active 时，count1 winner/count0 follower 均返回幂等 2xx', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    const familyId = decode(token).familyId as string;
    const binding = getAuthTokenSessionBinding(token);
    if (!binding) throw new Error('family binding missing');
    const defaultFind = mocks.familyFindUnique.getMockImplementation();
    if (!defaultFind) throw new Error('family DB mock missing');

    let preflightReads = 0;
    let releasePreflights!: () => void;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const holdPreflights = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    mocks.familyFindUnique.mockImplementation(async (args) => {
      if (args.where.id === familyId && preflightReads < 2) {
        const row = await defaultFind(args);
        const snapshot = row ? { ...row } : null;
        preflightReads += 1;
        if (preflightReads === 2) markBothStarted();
        await holdPreflights;
        return snapshot;
      }
      return defaultFind(args);
    });

    const first = logout(makeLogoutRequest(token));
    const second = logout(makeLogoutRequest(token));
    await bothStarted;
    releasePreflights();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.every((response) => !response.headers.has('set-cookie'))).toBe(
      true
    );
    expect(families.get(familyId)?.revokedReason).toBe('logout');
  });

  it('重放只撤被重用的设备 family，不影响同一用户另一登录', async () => {
    const deviceA = await issueAuthToken(ACTIVE_USER);
    const deviceB = await issueAuthToken(ACTIVE_USER);
    const first = await POST(makeRequest(deviceA));
    expect(first.status).toBe(200);
    const successorA = readSetCookieToken(first) as string;

    expect((await POST(makeRequest(deviceA))).status).toBe(401);
    expect(await verifyAuthToken(successorA)).toBeNull();
    expect((await verifyAuthToken(deviceB))?.user.id).toBe(ACTIVE_USER.id);
  });

  it('cutover 后所有 legacy cookie 强制重登，Redis miss/down 也绝不复活', async () => {
    const redis = {
      status: 'end',
      exists: vi.fn(async () => 0),
      set: vi.fn(async () => 'OK'),
    };
    mocks.getRedisClient.mockReturnValue(redis);
    const legacy = signToken(ACTIVE_USER);
    expect(decode(legacy).familyId).toBeUndefined();

    const response = await POST(makeRequest(legacy));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(families.size).toBe(0);
    expect(await verifyAuthToken(legacy)).toBeNull();

    redis.status = 'ready';
    expect(await verifyAuthToken(legacy)).toBeNull();
    expect(redis.exists).not.toHaveBeenCalled();
  });

  it('不向 Redis/内存写入 raw successor JWT', async () => {
    const redis = {
      status: 'ready',
      exists: vi.fn(async () => 0),
      set: vi.fn(async () => 'OK'),
    };
    mocks.getRedisClient.mockReturnValue(redis);
    const oldToken = await issueAuthToken(ACTIVE_USER);
    const response = await POST(makeRequest(oldToken));
    const successor = readSetCookieToken(response) as string;

    expect(response.status).toBe(200);
    expect(redis.set).not.toHaveBeenCalled();
    expect(JSON.stringify([...families.values()])).not.toContain(successor);
  });

  it('CAS 数据库故障不签 token，返回 503 且不消费原叶子', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    mocks.familyUpdateMany.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(makeRequest(token));
    expect(response.status).toBe(503);
    expect(readSetCookieToken(response)).toBeNull();
    expect((await verifyAuthToken(token))?.user.id).toBe(ACTIVE_USER.id);
  });

  it('family 验证查询故障返回 503 并保留 cookie，不误判为无效 401', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    mocks.familyFindUnique.mockRejectedValueOnce(
      new Error('family database unavailable')
    );

    const response = await POST(makeRequest(token));

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(families.get(decode(token).familyId as string)?.revokedAt).toBeNull();
  });

  it('user 验证查询故障同样返回 503，不删除仍可撤销的唯一 cookie', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    mocks.userFindUnique.mockRejectedValueOnce(
      new Error('user database unavailable')
    );

    const response = await POST(makeRequest(token));

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('既有连接复核遇到 family DB 故障时失败关闭', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    mocks.familyFindUnique.mockRejectedValue(
      new Error('database unavailable')
    );

    expect(await verifyEstablishedAuthFamilyToken(token)).toBeNull();
    await expect(diagnoseEstablishedAuthFamilyToken(token)).resolves.toEqual({
      status: 'revoked',
    });
  });

  it('既有连接诊断只把 raw leaf 自然过期区分为可 strict 重握手，撤族后仍是 revoked', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    const payload = jwt.decode(token) as Record<string, unknown>;
    const expired = jwt.sign(
      {
        ...payload,
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      JWT_SECRET,
      { algorithm: 'HS256', noTimestamp: true }
    );

    await expect(diagnoseEstablishedAuthFamilyToken(expired)).resolves.toEqual({
      status: 'leaf_expired',
    });

    await revokeToken(decode(token), { reason: 'logout' });
    await expect(diagnoseEstablishedAuthFamilyToken(expired)).resolves.toEqual({
      status: 'revoked',
    });

    const expiredLegacy = jwt.sign(
      {
        ...decode(signToken(ACTIVE_USER)),
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      JWT_SECRET,
      { algorithm: 'HS256', noTimestamp: true }
    );
    await expect(
      diagnoseEstablishedAuthFamilyToken(expiredLegacy)
    ).resolves.toEqual({ status: 'revoked' });
  });

  it('改密 tokenVersion 或封禁后拒绝 refresh', async () => {
    const token = await issueAuthToken(ACTIVE_USER);
    mocks.userFindUnique.mockResolvedValue({ ...ACTIVE_USER, tokenVersion: 1 });
    expect((await POST(makeRequest(token))).status).toBe(401);

    mocks.userFindUnique.mockResolvedValue({ ...ACTIVE_USER, status: 0 });
    expect((await POST(makeRequest(token))).status).toBe(401);
  });

  it('伪造、过期、超过绝对上限均拒绝，缺绑定时先失败关闭', async () => {
    const forged = jwt.sign(
      { ...ACTIVE_USER, sessionStartedAt: Date.now(), jti: 'forged' },
      'wrong-secret-wrong-secret-wrong-secret',
      { expiresIn: '7d' }
    );
    const expired = jwt.sign(
      { ...ACTIVE_USER, sessionStartedAt: Date.now(), jti: 'expired' },
      JWT_SECRET,
      { expiresIn: '-1h' }
    );
    const stale = signToken(ACTIVE_USER, {
      sessionStartedAt: Date.now() - 31 * DAY_MS,
    });

    expect((await POST(makeRequest(forged))).status).toBe(401);
    expect((await POST(makeRequest(expired))).status).toBe(401);
    expect((await POST(makeRequest(stale))).status).toBe(401);
    const missingBinding = await POST(
      new Request('http://localhost:3000/api/auth/refresh', { method: 'POST' })
    );
    expect(missingBinding.status).toBe(428);
    expect(missingBinding.headers.get('set-cookie')).toBeNull();
    expect(missingBinding.headers.get('clear-site-data')).toBeNull();
  });
});

describe('POST /api/auth/refresh — exp 钳到剩余绝对寿命', () => {
  function readCookieMaxAge(response: Response): number | null {
    const match = response.headers.get('set-cookie')?.match(/Max-Age=(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  it('jwt_expiry=90、会话已用 10 天：JWT 与 cookie 都不越过 30 天上限', async () => {
    mocks.getSiteSettings.mockResolvedValue({ jwt_expiry: 90 });
    const sessionStartedAt = Date.now() - 10 * DAY_MS;
    const familyToken = await issueAuthToken(ACTIVE_USER, {
      sessionStartedAt,
      expiresInDays: 30,
    });

    const response = await POST(makeRequest(familyToken));
    expect(response.status).toBe(200);
    const successor = decode(readSetCookieToken(response) as string);
    const absoluteDeadline = Math.floor((sessionStartedAt + 30 * DAY_MS) / 1000);
    expect(successor.sessionStartedAt).toBe(sessionStartedAt);
    expect(successor.exp).toBeLessThanOrEqual(absoluteDeadline);
    expect(successor.exp).toBeGreaterThan(absoluteDeadline - 10);
    expect(readCookieMaxAge(response)).toBeLessThanOrEqual(20 * 24 * 60 * 60 + 5);
  });

  it('默认 7 天、会话已用 25 天：只签剩余约 5 天', async () => {
    mocks.getSiteSettings.mockResolvedValue({ jwt_expiry: 7 });
    const sessionStartedAt = Date.now() - 25 * DAY_MS;
    const response = await POST(
      makeRequest(await issueAuthToken(ACTIVE_USER, { sessionStartedAt }))
    );
    expect(response.status).toBe(200);
    const maxAge = readCookieMaxAge(response) as number;
    expect(maxAge).toBeLessThanOrEqual(5 * 24 * 60 * 60 + 5);
    expect(maxAge).toBeGreaterThan(5 * 24 * 60 * 60 - 60);
  });
});
