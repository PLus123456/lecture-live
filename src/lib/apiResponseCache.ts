import { getRedisClient } from '@/lib/redis';

const API_RESPONSE_CACHE_PREFIX = 'lecturelive:api-response:v1';

export const API_RESPONSE_CACHE_TTL = {
  folders: 30,
  sessions: 30,
  shareLinks: 30,
} as const;

function buildNamespacedKey(key: string): string {
  return `${API_RESPONSE_CACHE_PREFIX}:${key}`;
}

async function deleteByPrefix(prefix: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') {
    return 0;
  }

  const match = `${buildNamespacedKey(prefix)}*`;
  let cursor = '0';
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      match,
      'COUNT',
      '100'
    );
    cursor = nextCursor;

    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');

  return deleted;
}

export async function getOrSetApiCache<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<{ hit: boolean; value: T }> {
  const redis = getRedisClient();
  const namespacedKey = buildNamespacedKey(key);

  if (redis && redis.status === 'ready') {
    try {
      const cached = await redis.get(namespacedKey);
      if (cached !== null) {
        return {
          hit: true,
          value: JSON.parse(cached) as T,
        };
      }
    } catch {
      // Redis 不可用时回退到直读数据库。
    }
  }

  const value = await loader();

  if (redis && redis.status === 'ready') {
    try {
      await redis.set(namespacedKey, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // 写缓存失败不影响主流程。
    }
  }

  return {
    hit: false,
    value,
  };
}

export function buildFoldersApiCacheKey(userId: string): string {
  return `folders:user:${userId}:list`;
}

export function buildSessionsApiCacheKey(
  userId: string,
  searchParams: URLSearchParams
): string {
  return `sessions:user:${userId}:list:${buildSearchParamsSignature(searchParams)}`;
}

export function buildShareLinksApiCacheKey(userId: string): string {
  return `share-links:user:${userId}:list`;
}

export async function invalidateFoldersApiCache(userId: string) {
  await deleteByPrefix(`folders:user:${userId}:`);
}

export async function invalidateSessionsApiCache(userId: string) {
  await deleteByPrefix(`sessions:user:${userId}:`);
}

export async function invalidateShareLinksApiCache(userId: string) {
  await deleteByPrefix(`share-links:user:${userId}:`);
}

export async function invalidateLibraryApiCache(userId: string) {
  await Promise.all([
    invalidateFoldersApiCache(userId),
    invalidateSessionsApiCache(userId),
  ]);
}

function buildSearchParamsSignature(searchParams: URLSearchParams): string {
  const entries = Array.from(searchParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) {
      return leftValue.localeCompare(rightValue);
    }
    return leftKey.localeCompare(rightKey);
  });

  if (entries.length === 0) {
    return 'base';
  }

  const serialized = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return Buffer.from(serialized).toString('base64url');
}
