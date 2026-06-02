import { beforeEach, describe, expect, it, vi } from 'vitest';

// 封禁/会员相关回归测试：被禁用用户（status !== 1）既不能凭旧 token 通过 verifyToken，
// 也不能用正确密码重新登录拿新 token。需在导入 @/lib/auth 前 mock prisma / redis。

const { userFindUniqueMock, getRedisClientMock } = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  getRedisClientMock: vi.fn(),
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

import bcrypt from 'bcryptjs';
import { login, signToken, verifyAuthToken } from '@/lib/auth';

const PASSWORD = 'Abcd1234';

describe('被禁用用户封禁', () => {
  beforeEach(() => {
    // 无 Redis（走内存黑名单分支）
    getRedisClientMock.mockReturnValue(null);
  });

  it('verifyToken：status=1 的正常用户通过', async () => {
    userFindUniqueMock.mockResolvedValue({
      id: 'user-1',
      email: 'active@example.com',
      role: 'PRO',
      tokenVersion: 0,
      status: 1,
    });

    const token = signToken({
      id: 'user-1',
      email: 'active@example.com',
      role: 'PRO',
      tokenVersion: 0,
    });

    const session = await verifyAuthToken(token);
    expect(session).not.toBeNull();
    expect(session?.user).toEqual({
      id: 'user-1',
      email: 'active@example.com',
      role: 'PRO',
    });
  });

  it('verifyToken：status=0 的被禁用用户返回 null（旧 token 立即失效）', async () => {
    userFindUniqueMock.mockResolvedValue({
      id: 'user-2',
      email: 'banned@example.com',
      role: 'PRO',
      tokenVersion: 0,
      status: 0,
    });

    const token = signToken({
      id: 'user-2',
      email: 'banned@example.com',
      role: 'PRO',
      tokenVersion: 0,
    });

    const session = await verifyAuthToken(token);
    expect(session).toBeNull();
  });

  it('verifyToken 的 select 包含 status 字段', async () => {
    userFindUniqueMock.mockResolvedValue({
      id: 'user-3',
      email: 'check@example.com',
      role: 'FREE',
      tokenVersion: 0,
      status: 1,
    });
    const token = signToken({
      id: 'user-3',
      email: 'check@example.com',
      role: 'FREE',
      tokenVersion: 0,
    });
    await verifyAuthToken(token);
    expect(userFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ status: true }),
      })
    );
  });

  it('login：正确密码但 status=0 的用户被拒绝（防重新登录）', async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    userFindUniqueMock.mockResolvedValue({
      id: 'user-4',
      email: 'banned@example.com',
      role: 'PRO',
      tokenVersion: 0,
      status: 0,
      passwordHash,
    });

    await expect(login('banned@example.com', PASSWORD)).rejects.toThrow(
      'Invalid credentials'
    );
  });

  it('login：正确密码且 status=1 的用户成功登录', async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    userFindUniqueMock.mockResolvedValue({
      id: 'user-5',
      email: 'active@example.com',
      role: 'PRO',
      tokenVersion: 0,
      status: 1,
      passwordHash,
    });

    const result = await login('active@example.com', PASSWORD);
    expect(result.user.id).toBe('user-5');
    expect(typeof result.token).toBe('string');
  });
});
