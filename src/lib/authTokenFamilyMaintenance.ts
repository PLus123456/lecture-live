import { prisma } from '@/lib/prisma';

// 绝对过期后再保留 24h：容纳跨节点时钟偏差、在途请求与事件排查，同时保证表不会纯增长。
export const AUTH_TOKEN_FAMILY_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;

export async function pruneExpiredAuthTokenFamilies(
  now = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - AUTH_TOKEN_FAMILY_DELETE_GRACE_MS);
  const result = await prisma.authTokenFamily.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
