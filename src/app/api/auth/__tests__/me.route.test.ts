import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 认证查询本身失败（连接池超时 / MySQL 重启）时绝不能回 401：AuthSessionMonitor 把任何
 * 普通 API 的 401 当作会话失效，会立刻登出、持久撤销仍然有效的 token family，并在撤销确认前
 * 阻止重新登录。真正无效的会话仍然是 401。
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  familyFindUnique: vi.fn(),
  familyCreate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    authTokenFamily: {
      findUnique: mocks.familyFindUnique,
      create: mocks.familyCreate,
    },
  },
}));
vi.mock('@/lib/redis', () => ({ getRedisClient: () => null }));

import { issueAuthToken } from '@/lib/auth';
import { GET } from '@/app/api/auth/me/route';

const meRequest = (token: string) =>
  new Request('http://localhost/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });

describe('GET /api/auth/me — 认证真源故障', () => {
  let token: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.familyCreate.mockResolvedValue({});
    token = await issueAuthToken({
      id: 'u1',
      email: 'user@example.com',
      role: 'FREE',
      tokenVersion: 0,
    });
  });

  it('DB 查询失败时回 503，而不是会触发前端登出的 401', async () => {
    const poolTimeout = new Error('P2024: Timed out fetching a new connection');
    mocks.userFindUnique.mockRejectedValue(poolTimeout);
    mocks.familyFindUnique.mockRejectedValue(poolTimeout);

    const res = await GET(meRequest(token));

    expect(res.status).toBe(503);
  });

  it('真正无效的会话仍回 401', async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.familyFindUnique.mockResolvedValue(null);

    const res = await GET(meRequest(token));

    expect(res.status).toBe(401);
  });
});
