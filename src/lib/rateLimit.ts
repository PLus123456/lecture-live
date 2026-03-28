import { NextResponse } from 'next/server';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { getRedisClient } from '@/lib/redis';
import { getSiteSettings } from '@/lib/siteSettings';

interface RateLimitOptions {
  scope: string;
  limit: number;
  windowMs: number;
  key?: string;
}

/**
 * 获取管理员配置的通用 API 速率限制。
 * 用于非 auth 的通用 API 路由，读取数据库中的 rate_limit_api 设置。
 */
export async function getApiRateLimit(): Promise<number> {
  try {
    const settings = await getSiteSettings();
    return settings.rate_limit_api;
  } catch {
    return 60; // 默认 60 次/分钟
  }
}

/**
 * 通用 API 速率限制（使用管理员配置的 rate_limit_api 设置）。
 * 适用于非 auth 的用户 API 路由，limit 自动从数据库读取。
 */
export async function enforceApiRateLimit(
  req: Request,
  options: Omit<RateLimitOptions, 'limit'> & { limit?: never },
): Promise<NextResponse | null> {
  const limit = await getApiRateLimit();
  return enforceRateLimit(req, { ...options, limit });
}

/* ------------------------------------------------------------------ */
/*  内存 fallback（Redis 不可用时）                                      */
/* ------------------------------------------------------------------ */

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const MEMORY_STORE_KEY = '__lectureLiveRateLimitStore';

type MemoryGlobal = typeof globalThis & {
  [MEMORY_STORE_KEY]?: Map<string, RateLimitBucket>;
};

function getMemoryStore(): Map<string, RateLimitBucket> {
  const globalState = globalThis as MemoryGlobal;
  if (!globalState[MEMORY_STORE_KEY]) {
    globalState[MEMORY_STORE_KEY] = new Map<string, RateLimitBucket>();
  }
  return globalState[MEMORY_STORE_KEY] as Map<string, RateLimitBucket>;
}

function pruneExpiredBuckets(store: Map<string, RateLimitBucket>, now: number) {
  store.forEach((bucket, key) => {
    if (bucket.resetAt <= now) {
      store.delete(key);
    }
  });
}

function memoryEnforce(bucketKey: string, options: RateLimitOptions): NextResponse | null {
  const store = getMemoryStore();
  const now = Date.now();

  if (store.size > 5000) {
    pruneExpiredBuckets(store, now);
  }

  const existing = store.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    store.set(bucketKey, { count: 1, resetAt: now + options.windowMs });
    return null;
  }

  if (existing.count >= options.limit) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.max(1, Math.ceil((existing.resetAt - now) / 1000))),
        },
      }
    );
  }

  existing.count += 1;
  store.set(bucketKey, existing);
  return null;
}

/* ------------------------------------------------------------------ */
/*  主函数：优先 Redis，回退内存                                          */
/* ------------------------------------------------------------------ */

/**
 * 分布式限速：优先使用 Redis，Redis 不可用时回退到内存。
 * 所有 API route 中调用此函数时需要 await。
 */
export async function enforceRateLimit(
  req: Request,
  options: RateLimitOptions
): Promise<NextResponse | null> {
  const clientKey = options.key?.trim() || `ip:${resolveRequestClientIp(req)}`;
  const bucketKey = `ratelimit:${options.scope}:${clientKey}`;
  const windowSec = Math.max(1, Math.ceil(options.windowMs / 1000));

  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') {
    return memoryEnforce(bucketKey, options);
  }

  try {
    // INCR + EXPIRE 原子操作
    const count = await redis.incr(bucketKey);

    if (count === 1) {
      await redis.expire(bucketKey, windowSec);
    }

    if (count > options.limit) {
      const ttl = await redis.ttl(bucketKey);
      return NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.max(1, ttl)),
            'X-RateLimit-Limit': String(options.limit),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    return null;
  } catch {
    // Redis 异常，回退到内存限速
    return memoryEnforce(bucketKey, options);
  }
}
