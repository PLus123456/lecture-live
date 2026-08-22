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

/* ------------------------------------------------------------------ */
/*  L51：singleflight + 失效时序保护                                      */
/* ------------------------------------------------------------------ */

/**
 * 同一 key 的并发 miss 只跑一次 loader（cache stampede / 缓存击穿）。
 * 旧实现里 N 个并发请求 miss 同一个键就是 N 次全量 DB 查询——列表页在缓存过期的
 * 那一瞬间会把 DB 打出一个尖峰，键越热尖峰越高。
 */
const inFlightLoads = new Map<string, Promise<unknown>>();

/**
 * 「读 miss → loader 读到旧值 → 另一个请求提交写入并删 key → 我们把旧值写回」
 * 这条时序会让**已经失效**的数据复活最多一个 TTL。
 *
 * 这里记下每个前缀最近一次失效的时刻：loader 开始之前先取一次时间戳，
 * 写回缓存前若发现该前缀在这期间被失效过，就**只返回值、不写缓存**。
 * 注意这是**进程内**的保护 —— 多实例部署下另一个进程的失效仍看不到，
 * 残留窗口 ≤ TTL（30s），与正常缓存陈旧度同量级，故不再加分布式墓碑。
 */
const lastInvalidatedAt = new Map<string, number>();

/** 仅供测试：重置进程内状态。 */
export function __resetApiCacheState(): void {
  inFlightLoads.clear();
  lastInvalidatedAt.clear();
}

function markInvalidated(prefix: string) {
  lastInvalidatedAt.set(prefix, Date.now());
  // 前缀数量随用户数增长，做个上界防泄漏（超限时丢最旧的一半）
  if (lastInvalidatedAt.size > 10_000) {
    const entries = Array.from(lastInvalidatedAt.entries()).sort(
      (a, b) => a[1] - b[1]
    );
    for (let i = 0; i < entries.length / 2; i += 1) {
      lastInvalidatedAt.delete(entries[i][0]);
    }
  }
}

/** key 落在哪些已记录的失效前缀下 —— 取其中最新的一次失效时刻。 */
function latestInvalidationFor(key: string): number {
  let latest = 0;
  lastInvalidatedAt.forEach((at, prefix) => {
    if (key.startsWith(prefix) && at > latest) latest = at;
  });
  return latest;
}

async function deleteByPrefix(prefix: string): Promise<number> {
  // 失效时刻要先记，且不受 Redis 可用性影响 —— 否则 Redis 抖动期间的失效
  // 会被后续写回悄悄抹掉。
  markInvalidated(prefix);

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

  // L51 singleflight：同一 key 已有在途 loader 就搭它的车，不再各自打 DB。
  const existing = inFlightLoads.get(namespacedKey);
  if (existing) {
    return { hit: false, value: (await existing) as T };
  }

  const startedAt = Date.now();
  const load = (async () => {
    const value = await loader();

    // L51 时序保护：loader 期间该前缀被失效过 → 这份值可能已经过时，只返回不写回。
    const invalidatedDuringLoad = latestInvalidationFor(key) >= startedAt;

    if (!invalidatedDuringLoad) {
      const writeRedis = getRedisClient();
      if (writeRedis && writeRedis.status === 'ready') {
        try {
          await writeRedis.set(
            namespacedKey,
            JSON.stringify(value),
            'EX',
            ttlSeconds
          );
        } catch {
          // 写缓存失败不影响主流程。
        }
      }
    }

    return value;
  })();

  inFlightLoads.set(namespacedKey, load);
  try {
    const value = await load;
    return { hit: false, value };
  } finally {
    inFlightLoads.delete(namespacedKey);
  }
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
