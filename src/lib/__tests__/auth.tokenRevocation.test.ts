import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P6-3 回归：token 吊销必须在「Redis 断连 → 恢复」这条轨迹上活下来。
 *
 * 旧实现里 isTokenRevoked 在 redis.status === 'ready' 时直接返回 Redis 的答案，
 * revokeToken 对称地只写一处 → 降级期（Redis 断连）记录的吊销在 Redis 恢复的那一刻
 * 集体失效：登出过的 token 又能用了，而且能反复 refresh 续命。
 */

const { userFindUniqueMock, getRedisClientMock } = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  getRedisClientMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
  },
}));

vi.mock('@/lib/redis', () => ({
  getRedisClient: getRedisClientMock,
}));

import { revokeToken, signToken, verifyAuthToken } from '@/lib/auth';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET as string;

const USER = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'PRO' as const,
  tokenVersion: 0,
};

/** 可切换 status 的假 Redis：exists/set 都由内部 Map 支撑，便于模拟「Redis 里没有这条记录」。 */
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

function decodeJti(token: string): { jti: string; exp: number } {
  const decoded = jwt.verify(token, JWT_SECRET) as { jti: string; exp: number };
  return { jti: decoded.jti, exp: decoded.exp };
}

describe('token 吊销：Redis 与内存表双写/双查 (P6-3)', () => {
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.__lectureLiveTokenBlacklistStore;
    userFindUniqueMock.mockReset();
    userFindUniqueMock.mockResolvedValue({
      id: USER.id,
      email: USER.email,
      role: USER.role,
      tokenVersion: 0,
      status: 1,
    });
    getRedisClientMock.mockReset();
  });

  it('Redis 断连期间的吊销，在 Redis 恢复后仍然有效', async () => {
    const redis = makeFakeRedis();
    getRedisClientMock.mockReturnValue(redis);

    const token = signToken(USER);
    const payload = decodeJti(token);

    // ① Redis 断连（ioredis 放弃重连后的终态）→ 吊销只能落内存表
    redis.status = 'end';
    await revokeToken(payload);
    expect(redis.set).not.toHaveBeenCalled();
    expect(await verifyAuthToken(token)).toBeNull();

    // ② Redis 恢复：它从没见过这个 jti，exists 返回 0。
    //    旧实现会直接采信 Redis 的 0 并放行 → 吊销凭空蒸发。
    redis.status = 'ready';
    expect(await verifyAuthToken(token)).toBeNull();
  });

  it('Redis 正常时也写内存表：Redis 侧记录丢失（重启/flush）不导致吊销失效', async () => {
    const redis = makeFakeRedis();
    getRedisClientMock.mockReturnValue(redis);

    const token = signToken(USER);
    await revokeToken(decodeJti(token));
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(await verifyAuthToken(token)).toBeNull();

    // 模拟 Redis 数据丢失（重启无持久化 / FLUSHALL）
    redis.keys.clear();
    expect(await verifyAuthToken(token)).toBeNull();
  });

  it('未吊销的 token 仍然放行（双查不会把正常会话误杀）', async () => {
    const redis = makeFakeRedis();
    getRedisClientMock.mockReturnValue(redis);

    const token = signToken(USER);
    const session = await verifyAuthToken(token);
    expect(session?.user.id).toBe(USER.id);
  });

  it('Redis 抛错时不误判为已吊销（未吊销的 token 照常放行）', async () => {
    const redis = makeFakeRedis();
    redis.exists = vi.fn(async () => {
      throw new Error('connection is closed');
    });
    getRedisClientMock.mockReturnValue(redis);

    const token = signToken(USER);
    expect((await verifyAuthToken(token))?.user.id).toBe(USER.id);
  });
});
