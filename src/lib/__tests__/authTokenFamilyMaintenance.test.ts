import { describe, expect, it, vi } from 'vitest';

const deleteMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/prisma', () => ({
  prisma: { authTokenFamily: { deleteMany } },
}));

import {
  AUTH_TOKEN_FAMILY_DELETE_GRACE_MS,
  pruneExpiredAuthTokenFamilies,
} from '@/lib/authTokenFamilyMaintenance';

describe('pruneExpiredAuthTokenFamilies', () => {
  it('只删除绝对过期并超过 24h 安全缓冲的 family', async () => {
    deleteMany.mockResolvedValueOnce({ count: 3 });
    const now = new Date('2026-08-20T12:00:00.000Z');

    await expect(pruneExpiredAuthTokenFamilies(now)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: {
          lt: new Date(now.getTime() - AUTH_TOKEN_FAMILY_DELETE_GRACE_MS),
        },
      },
    });
  });
});
