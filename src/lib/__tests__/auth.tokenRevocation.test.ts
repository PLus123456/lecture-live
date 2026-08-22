import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  familyFindUnique: vi.fn(),
  familyCreate: vi.fn(),
  familyUpdateMany: vi.fn(),
  familyUpsert: vi.fn(),
  getRedisClient: vi.fn(),
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

import {
  type AuthTokenPayload,
  getAuthTokenSessionBinding,
  issueAuthToken,
  revokeAuthSessionByBinding,
  resolveLogoutAuthToken,
  revokeToken,
  rotateAuthToken,
  signToken,
  verifyAuthToken,
} from '@/lib/auth';

const JWT_SECRET = process.env.JWT_SECRET as string;
const USER = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'PRO' as const,
  tokenVersion: 0,
};

interface FamilyRow {
  id: string;
  userId: string;
  currentJtiHash: string;
  legacyJtiHash: string | null;
  generation: number;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

const families = new Map<string, FamilyRow>();

function decode(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

function decodeCapability(binding: string): Record<string, unknown> {
  const [, payload] = binding.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function signCapability(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url'
  );
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`v1.${encoded}`, 'utf8')
    .digest('base64url');
  return `v1.${encoded}.${signature}`;
}

function makeFakeRedis() {
  const keys = new Set<string>();
  return {
    status: 'ready' as string,
    keys,
    exists: vi.fn(async (key: string) => (keys.has(key) ? 1 : 0)),
    set: vi.fn(async (key: string) => {
      keys.add(key);
      return 'OK';
    }),
  };
}

function installFamilyDb() {
  mocks.familyCreate.mockImplementation(async ({ data }) => {
    if (
      [...families.values()].some(
        (row) =>
          row.currentJtiHash === data.currentJtiHash ||
          (data.legacyJtiHash && row.legacyJtiHash === data.legacyJtiHash)
      )
    ) {
      throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
    }
    const row: FamilyRow = {
      id: data.id,
      userId: data.userId,
      currentJtiHash: data.currentJtiHash,
      legacyJtiHash: data.legacyJtiHash ?? null,
      generation: data.generation ?? 0,
      expiresAt: data.expiresAt,
      revokedAt: data.revokedAt ?? null,
      revokedReason: data.revokedReason ?? null,
    };
    families.set(row.id, row);
    return row;
  });
  mocks.familyFindUnique.mockImplementation(async ({ where }) => {
    if (where.id) return families.get(where.id) ?? null;
    return (
      [...families.values()].find(
        (row) => row.legacyJtiHash === where.legacyJtiHash
      ) ?? null
    );
  });
  mocks.familyUpdateMany.mockImplementation(async ({ where, data }) => {
    let count = 0;
    for (const row of families.values()) {
      if (where.id && row.id !== where.id) continue;
      if (where.userId && row.userId !== where.userId) continue;
      if (where.revokedAt === null && row.revokedAt !== null) continue;
      if (
        where.expiresAt instanceof Date &&
        row.expiresAt.getTime() !== where.expiresAt.getTime()
      ) {
        continue;
      }
      if (
        where.expiresAt?.equals &&
        row.expiresAt.getTime() !== where.expiresAt.equals.getTime()
      ) {
        continue;
      }
      if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) continue;
      if (data.revokedAt !== undefined) row.revokedAt = data.revokedAt;
      if (data.revokedReason !== undefined) row.revokedReason = data.revokedReason;
      count += 1;
    }
    return { count };
  });
  mocks.familyUpsert.mockImplementation(async ({ where, update, create }) => {
    const existing = [...families.values()].find(
      (row) => row.legacyJtiHash === where.legacyJtiHash
    );
    if (existing) {
      existing.revokedAt = update.revokedAt;
      existing.revokedReason = update.revokedReason;
      return existing;
    }
    const row: FamilyRow = {
      id: create.id,
      userId: create.userId,
      currentJtiHash: create.currentJtiHash,
      legacyJtiHash: create.legacyJtiHash,
      generation: create.generation,
      expiresAt: create.expiresAt,
      revokedAt: create.revokedAt,
      revokedReason: create.revokedReason,
    };
    families.set(row.id, row);
    return row;
  });
}

beforeEach(() => {
  families.clear();
  vi.clearAllMocks();
  installFamilyDb();
  mocks.userFindUnique.mockResolvedValue({ ...USER, status: 1 });
  mocks.getRedisClient.mockReturnValue(null);
  delete (globalThis as Record<string, unknown>).__lectureLiveTokenBlacklistStore;
});

describe('持久 token family 撤销（SEC-008）', () => {
  it('Redis 断连时 logout 仍持久撤销；换进程/Redis 恢复后不会复活', async () => {
    const redis = makeFakeRedis();
    redis.status = 'end';
    mocks.getRedisClient.mockReturnValue(redis);
    const token = await issueAuthToken(USER);
    const payload = decode(token);

    await revokeToken(payload, { reason: 'logout' });
    expect(redis.set).not.toHaveBeenCalled();
    expect(await verifyAuthToken(token)).toBeNull();

    // 模拟另一个进程：本地黑名单为空，Redis 也从未拿到记录；DB family 仍是权威。
    delete (globalThis as Record<string, unknown>).__lectureLiveTokenBlacklistStore;
    redis.status = 'ready';
    expect(await verifyAuthToken(token)).toBeNull();
  });

  it('单设备 logout 只撤自己的 family，不影响同用户另一设备', async () => {
    const deviceA = await issueAuthToken(USER);
    const deviceB = await issueAuthToken(USER);
    await revokeToken(decode(deviceA), { reason: 'logout' });

    expect(await verifyAuthToken(deviceA)).toBeNull();
    expect((await verifyAuthToken(deviceB))?.user.id).toBe(USER.id);
  });

  it('binding 是固定 purpose/family/user/绝对 exp 的 HMAC revoke-only capability', async () => {
    const token = await issueAuthToken(USER);
    const tokenPayload = decode(token);
    const binding = getAuthTokenSessionBinding(token);

    expect(binding).not.toBeNull();
    expect(binding).not.toContain(token);
    expect(binding?.split('.')).toHaveLength(3);
    expect(decodeCapability(binding as string)).toEqual({
      purpose: 'auth-family-revoke',
      familyId: tokenPayload.familyId,
      userId: USER.id,
      absoluteExpiresAt:
        tokenPayload.sessionStartedAt + 30 * 24 * 60 * 60 * 1000,
    });
    expect(JSON.stringify(decodeCapability(binding as string))).not.toContain(
      tokenPayload.jti
    );
    // capability 不是 JWT，且任何认证 verifier 都不能用它取得 session。
    expect(await verifyAuthToken(binding as string)).toBeNull();
  });

  it('capability 只撤被签名绑定的 family；篡改为任意另一 family 会在 DB 前拒绝', async () => {
    const deviceA = await issueAuthToken(USER);
    const deviceB = await issueAuthToken(USER);
    const payloadA = decode(deviceA);
    const payloadB = decode(deviceB);
    const bindingA = getAuthTokenSessionBinding(deviceA) as string;
    const [, , signatureA] = bindingA.split('.');
    const tamperedPayload = {
      ...decodeCapability(bindingA),
      familyId: payloadB.familyId,
    };
    const tampered = `v1.${Buffer.from(
      JSON.stringify(tamperedPayload),
      'utf8'
    ).toString('base64url')}.${signatureA}`;

    mocks.familyUpdateMany.mockClear();
    await expect(revokeAuthSessionByBinding(tampered)).resolves.toEqual({
      status: 'invalid',
    });
    expect(mocks.familyUpdateMany).not.toHaveBeenCalled();
    expect(families.get(payloadA.familyId as string)?.revokedAt).toBeNull();
    expect(families.get(payloadB.familyId as string)?.revokedAt).toBeNull();

    await expect(revokeAuthSessionByBinding(bindingA)).resolves.toMatchObject({
      status: 'revoked',
      familyId: payloadA.familyId,
      userId: USER.id,
    });
    expect(families.get(payloadA.familyId as string)?.revokedAt).not.toBeNull();
    expect(families.get(payloadB.familyId as string)?.revokedAt).toBeNull();
  });

  it('错 purpose、user 错配及旧 hash binding 全部拒绝且不撤族', async () => {
    const token = await issueAuthToken(USER);
    const payload = decode(token);
    const binding = getAuthTokenSessionBinding(token) as string;
    const capability = decodeCapability(binding);
    const variants = [
      signCapability({ ...capability, purpose: 'auth-family-authorize' }),
      signCapability({ ...capability, userId: 'another-user' }),
      'a'.repeat(64),
    ];

    for (const candidate of variants) {
      await expect(revokeAuthSessionByBinding(candidate)).resolves.toEqual({
        status: 'invalid',
      });
    }
    expect(families.get(payload.familyId as string)?.revokedAt).toBeNull();
  });

  it('过期 capability 绝不写 DB：仅对权威已过期/缺失目标幂等成功，active 错目标拒绝', async () => {
    const expiredToken = await issueAuthToken(USER);
    const expiredPayload = decode(expiredToken);
    const expiredFamily = families.get(expiredPayload.familyId as string);
    if (!expiredFamily) throw new Error('family missing');
    const expiredAt = Date.now() - 1;
    expiredFamily.expiresAt = new Date(expiredAt);
    const expiredCapability = signCapability({
      ...decodeCapability(getAuthTokenSessionBinding(expiredToken) as string),
      absoluteExpiresAt: expiredAt,
    });

    mocks.familyUpdateMany.mockClear();
    await expect(
      revokeAuthSessionByBinding(expiredCapability)
    ).resolves.toMatchObject({ status: 'already_invalid' });
    expect(mocks.familyUpdateMany).not.toHaveBeenCalled();

    families.delete(expiredPayload.familyId as string);
    await expect(
      revokeAuthSessionByBinding(expiredCapability)
    ).resolves.toMatchObject({ status: 'already_invalid' });
    expect(mocks.familyUpdateMany).not.toHaveBeenCalled();

    const activeToken = await issueAuthToken(USER);
    const activePayload = decode(activeToken);
    const expiredForActive = signCapability({
      ...decodeCapability(getAuthTokenSessionBinding(activeToken) as string),
      absoluteExpiresAt: expiredAt,
    });
    await expect(revokeAuthSessionByBinding(expiredForActive)).resolves.toEqual({
      status: 'invalid',
    });
    expect(families.get(activePayload.familyId as string)?.revokedAt).toBeNull();
    expect(mocks.familyUpdateMany).not.toHaveBeenCalled();
  });

  it('过期 capability 的幂等确认仍依赖 DB；查询故障必须失败关闭', async () => {
    const token = await issueAuthToken(USER);
    const payload = decode(token);
    const family = families.get(payload.familyId as string);
    if (!family) throw new Error('family missing');
    const expiredAt = Date.now() - 1;
    family.expiresAt = new Date(expiredAt);
    const expiredCapability = signCapability({
      ...decodeCapability(getAuthTokenSessionBinding(token) as string),
      absoluteExpiresAt: expiredAt,
    });
    mocks.familyFindUnique.mockRejectedValueOnce(
      new Error('database unavailable')
    );

    await expect(revokeAuthSessionByBinding(expiredCapability)).rejects.toThrow(
      'database unavailable'
    );
    expect(mocks.familyUpdateMany).not.toHaveBeenCalled();
  });

  it('长 userId capability 仍可完整 round-trip，不因编码长度被服务端截断', async () => {
    const longUser = { ...USER, id: `user-${'x'.repeat(300)}` };
    const token = await issueAuthToken(longUser);
    const binding = getAuthTokenSessionBinding(token) as string;

    expect(binding.length).toBeGreaterThan(256);
    expect(decodeCapability(binding).userId).toBe(longUser.id);
    await expect(revokeAuthSessionByBinding(binding)).resolves.toMatchObject({
      status: 'revoked',
      userId: longUser.id,
    });
  });

  it('capability DB 读写故障与无法解释的 active count=0 都失败关闭', async () => {
    const token = await issueAuthToken(USER);
    const binding = getAuthTokenSessionBinding(token) as string;

    mocks.familyFindUnique.mockRejectedValueOnce(
      new Error('database unavailable')
    );
    await expect(revokeAuthSessionByBinding(binding)).rejects.toThrow(
      'database unavailable'
    );

    mocks.familyUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(revokeAuthSessionByBinding(binding)).rejects.toThrow(
      'could not be persistently revoked'
    );
  });

  it('两个并发 capability logout 都先读 active 时，count1 winner/count0 follower 均幂等成功', async () => {
    const token = await issueAuthToken(USER);
    const payload = decode(token);
    const binding = getAuthTokenSessionBinding(token) as string;
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
      if (args.where.id === payload.familyId && preflightReads < 2) {
        const row = await defaultFind(args);
        const snapshot = row ? { ...row } : null;
        preflightReads += 1;
        if (preflightReads === 2) markBothStarted();
        await holdPreflights;
        return snapshot;
      }
      return defaultFind(args);
    });

    const first = revokeAuthSessionByBinding(binding);
    const second = revokeAuthSessionByBinding(binding);
    await bothStarted;
    releasePreflights();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'already_invalid',
      'revoked',
    ]);
    expect(families.get(payload.familyId as string)?.revokedReason).toBe(
      'logout'
    );
  });

  it('logout 200 丢包后，同一签名 cookie 能确认已撤 family 并幂等重试', async () => {
    const token = await issueAuthToken(USER);
    expect((await resolveLogoutAuthToken(token)).status).toBe('active');

    await revokeToken(decode(token), { reason: 'logout' });
    delete (globalThis as Record<string, unknown>).__lectureLiveTokenBlacklistStore;

    const retry = await resolveLogoutAuthToken(token);
    expect(retry.status).toBe('already_invalid');
    expect(await verifyAuthToken(token)).toBeNull();
  });

  it('revokeToken 遇到并发赢家造成的 count=0 会权威复查并幂等成功', async () => {
    const token = await issueAuthToken(USER);
    const payload = decode(token);

    await revokeToken(payload, { reason: 'logout' });
    await expect(
      revokeToken(payload, { reason: 'logout' })
    ).resolves.toBeUndefined();
    expect(families.get(payload.familyId as string)?.revokedReason).toBe(
      'logout'
    );
  });

  it('legacy cookie 在 cutover 后不可授权，也不能绕过入口自行写撤销哨兵', async () => {
    const legacy = signToken(USER);
    expect(await verifyAuthToken(legacy)).toBeNull();
    await expect(
      revokeToken(decode(legacy), { reason: 'logout' })
    ).rejects.toThrow('require reauthentication');
    expect(mocks.familyCreate).not.toHaveBeenCalled();
  });

  it('rotateAuthToken 对 legacy leaf 直接拒绝迁移并要求重登', async () => {
    const legacy = signToken(USER);
    const rotation = await rotateAuthToken(decode(legacy), USER);
    expect(rotation).toEqual({ status: 'reused' });
    expect(families.size).toBe(0);
  });

  it('family DB 无法确认时，新 token 校验失败关闭', async () => {
    const token = await issueAuthToken(USER);
    mocks.familyFindUnique.mockRejectedValue(new Error('database unavailable'));
    expect(await verifyAuthToken(token)).toBeNull();
  });

  it('持久撤销写失败会向上传播，且不会谎称仅 Redis 撤销成功', async () => {
    const redis = makeFakeRedis();
    mocks.getRedisClient.mockReturnValue(redis);
    const token = await issueAuthToken(USER);
    mocks.familyUpdateMany.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(revokeToken(decode(token), { reason: 'logout' })).rejects.toThrow(
      'database unavailable'
    );
    expect(redis.set).not.toHaveBeenCalled();
  });
});
