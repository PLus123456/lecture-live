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

// P4-4：进入会话列表缓存签名的参数白名单 —— 必须与 sessions/route.ts GET 里真正影响 SQL 的
// 参数**逐一对应**。旧实现把全部查询串纳入签名，而 SQL 只看这四个：任意垃圾参数
// （?x=1、?x=2…）都换一个新键、必然 miss、还各自驻留 30 秒，等于一条「一请求一驻留」的
// 缓存基数爆炸原语（约 400 字节请求 → 数百 KB 驻留，10³-10⁴ 倍放大）。
const SESSIONS_CACHE_KEY_PARAMS = [
  'unarchived',
  'folderId',
  'limit',
  'cursor',
] as const;

export function buildSessionsApiCacheKey(
  userId: string,
  searchParams: URLSearchParams
): string {
  const filtered = new URLSearchParams();
  for (const name of SESSIONS_CACHE_KEY_PARAMS) {
    const value = searchParams.get(name);
    if (value !== null) {
      filtered.set(name, value);
    }
  }
  return `sessions:user:${userId}:list:${buildSearchParamsSignature(filtered)}`;
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
