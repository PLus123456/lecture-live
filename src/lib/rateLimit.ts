import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { NextResponse } from 'next/server';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logger } from '@/lib/logger';
import { getRedisClient } from '@/lib/redis';
import { getSiteSettings } from '@/lib/siteSettings';

interface RateLimitOptions {
  scope: string;
  limit: number;
  windowMs: number;
  key?: string;
}

const rateLimitLogger = logger.child({ component: 'rate-limit' });

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
/*  H7：默认桶维度解析                                                   */
/* ------------------------------------------------------------------ */

/**
 * H7（= AUDIT_MERGED_BACKLOG_20260815 的 C1 根因簇）：
 * 旧实现的默认 key 是 `ip:${resolveRequestClientIp(req)}`，而 TRUSTED_PROXY 缺省为 false
 * 时该函数**恒返回 'unknown'** —— 于是所有不带自定义 key 的路由（share/view、llm/report、
 * setup、soniox/temporary-key、share/create…）全站塌缩成**一个**桶
 * `ratelimit:{scope}:ip:unknown`：任何匿名者打满它，全站所有人一起 429。
 *
 * C1 给的修法是「回落 socket 远端地址」，**在 Next App Router 里做不到**：Route Handler
 * 只拿得到 Web `Request`，没有 socket 句柄；Next 自己那句
 * `req.headers['x-forwarded-for'] ??= socket.remoteAddress` 是 `??=`，客户端自带 XFF 时
 * 不会追加，无法与伪造值区分（详见 clientIp.ts 的注释）。
 * （server/websocket.ts 是自建 HTTP 服务器、拿得到 `socket.handshake.address`，
 *   那一侧本来就没有塌缩，C1 里「每 IP 50 连接变全站 50」的说法与代码不符。）
 *
 * 所以这里按「能拿到多少身份就分多细」分三层，任何一层都**不会**把互不相干的调用方
 * 塞进同一个桶：
 *
 *  1. `ip:<addr>`  —— 可信代理已开启且解析出合法 IP。最理想，行为与旧实现完全一致。
 *  2. `sub:<userId>` —— 拿不到 IP，但请求带着**签名有效**的会话 JWT。
 *     受保护路由（middleware 已验签才放行）几乎都落在这一层：llm/report、share/create、
 *     soniox/temporary-key、regenerate-title…… 「一人用尽全站额度」就此消失。
 *     这里独立验签（HS256 + exp），伪造 token 拿不到别人的桶，也换不出新桶。
 *  3. `anon:<sha256(pathname)>` —— 公开无鉴权路由的兜底。**按资源分桶**：
 *     `/api/share/view/AAA` 与 `/api/share/view/BBB` 是两个桶，打爆一个分享链接
 *     再也影响不到另一个（旧实现打任意 token 就能 429 掉全站分享页）。
 *     路径里可能含分享 token 这类机密，故落 Redis key 前先哈希。
 *
 * 残留取舍（已知、刻意保留）：
 *  - 第 3 层对**同一路径**仍是共享桶（`/api/setup` 只有一条路径）。setup 保护的本来就是
 *    全局的一次性引导资源，共享桶在语义上是对的；被打满 10 分钟可自愈，且真正的门禁是
 *    requireSetupAuthorization。
 *  - 拿不到真实 IP 时，匿名者的**总量**依然限不住（换路径即换桶）。这不是代码能补的：
 *    没有可信来源标识就没有「同一个人」的概念。正解是把 TRUSTED_PROXY 打开
 *    （deploy/ 模板与 .env.example 已改为推荐 true），未开启且检测到反代头时
 *    clientIp.ts 会打一次告警。聚合层面的兜底应由反代承担（nginx limit_req，
 *    已写进 deploy/nginx-lecturelive.conf）。
 */
export function resolveRateLimitClientKey(req: Request): string {
  const ip = resolveRequestClientIp(req);
  if (ip !== 'unknown') {
    return `ip:${ip}`;
  }

  const subject = readVerifiedTokenSubject(req);
  if (subject) {
    return `sub:${subject}`;
  }

  return `anon:${hashRequestPath(req)}`;
}

function readVerifiedTokenSubject(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const token = header.slice(7).trim();
  // 前端用这个哨兵值表示「会话在 HttpOnly cookie 里」，不是真 token。
  if (!token || token === '__cookie_session__') return null;

  // 懒读 env：首次部署（JWT_SECRET 尚未配置）时 serverSecrets 会在模块求值阶段抛，
  // 而 rateLimit 被公开的 /api/setup 依赖，不能让它连累引导流程。
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) return null;

  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!payload || typeof payload !== 'object') return null;
    const id = (payload as { id?: unknown }).id;
    return typeof id === 'string' && id ? id.slice(0, 64) : null;
  } catch {
    // 签名无效/过期：当匿名处理（不给它换出一个新桶）。
    return null;
  }
}

function hashRequestPath(req: Request): string {
  let pathname = '/';
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    // req.url 异常时退回常量，效果等同旧的全局桶，但只影响这一种畸形请求。
  }
  return createHash('sha256').update(pathname).digest('hex').slice(0, 16);
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

/**
 * L50：Redis 不可用时限流退化为「进程内内存」。多实例部署下实际限额 = 配置 × 实例数，
 * 进程重启即清零，攻击者制造 Redis 抖动就能把限流整体降级。
 * 这是刻意的 fail-open（限流挂掉不该顺带把站点打死），但必须**可观测**且**可选择**：
 *  - 每 60s 至多告警一次，让运维知道限流当前是降级状态；
 *  - 高安全部署可置 RATE_LIMIT_FAIL_CLOSED=1 改为 fail-closed（Redis 挂即 429）。
 */
const DEGRADED_WARN_INTERVAL_MS = 60_000;
let lastDegradedWarnAt = 0;

function warnDegraded(scope: string, reason: string) {
  const now = Date.now();
  if (now - lastDegradedWarnAt < DEGRADED_WARN_INTERVAL_MS) return;
  lastDegradedWarnAt = now;
  rateLimitLogger.warn(
    { scope, reason },
    'Redis 不可用，限流已退化为进程内内存计数：多实例下实际限额 = 配置 × 实例数，重启即清零。' +
      '需要严格限额时可设置 RATE_LIMIT_FAIL_CLOSED=1。'
  );
}

function failClosedEnabled(): boolean {
  const configured = process.env.RATE_LIMIT_FAIL_CLOSED?.trim().toLowerCase();
  return configured === '1' || configured === 'true' || configured === 'yes';
}

function tooManyRequests(retryAfterSeconds: number, limit?: number): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Retry-After': String(Math.max(1, retryAfterSeconds)),
        ...(limit === undefined
          ? {}
          : { 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': '0' }),
      },
    }
  );
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
    return tooManyRequests(Math.ceil((existing.resetAt - now) / 1000));
  }

  existing.count += 1;
  store.set(bucketKey, existing);
  return null;
}

function degradedEnforce(
  bucketKey: string,
  options: RateLimitOptions,
  reason: string
): NextResponse | null {
  warnDegraded(options.scope, reason);
  if (failClosedEnabled()) {
    return tooManyRequests(Math.max(1, Math.ceil(options.windowMs / 1000)), options.limit);
  }
  return memoryEnforce(bucketKey, options);
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
  const clientKey = options.key?.trim() || resolveRateLimitClientKey(req);
  const bucketKey = `ratelimit:${options.scope}:${clientKey}`;
  const windowSec = Math.max(1, Math.ceil(options.windowMs / 1000));

  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') {
    return degradedEnforce(bucketKey, options, 'redis-unavailable');
  }

  try {
    // INCR 计数：
    // - 键不存在时 INCR 自动以 count=1 建键（无 TTL），随即 EXPIRE 设窗口过期；
    //   这天然覆盖「键到期边界被重建」的竞态——重建后的键 count 必为 1，会重新设过期。
    // - 已存在的键（count>1）若发现无 TTL（-1），说明是历史遗留 / 极少数 EXPIRE 失败留下的
    //   「无过期卡死键」（会导致计数只增不减 → 永久 429），此处防御性补设过期以自愈。
    //   （切勿用 `SET key 0 EX win NX`：键将到期时 NX 会空操作、不刷 TTL，随后 INCR 又把它
    //   重建成无 TTL 的键，反而制造永久 429。）
    const count = await redis.incr(bucketKey);
    if (count === 1) {
      await redis.expire(bucketKey, windowSec);
    } else {
      const ttl = await redis.ttl(bucketKey);
      if (ttl === -1) {
        await redis.expire(bucketKey, windowSec);
      }
    }

    if (count > options.limit) {
      const ttl = await redis.ttl(bucketKey);
      return tooManyRequests(ttl, options.limit);
    }

    return null;
  } catch {
    // Redis 异常，回退到内存限速
    return degradedEnforce(bucketKey, options, 'redis-error');
  }
}
