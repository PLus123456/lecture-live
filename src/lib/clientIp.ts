import { isIP } from 'node:net';

import { logger } from './logger';

const TRUSTED_PROXY_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const clientIpLogger = logger.child({ component: 'client-ip' });

/* ------------------------------------------------------------------ */
/*  IP 字面量校验与归一化                                                */
/* ------------------------------------------------------------------ */

/**
 * M22：把头里的值收敛成「合法 IP 字面量」再使用。
 *
 * 反代头是**部署形态**决定可信度的，代码层面验不了对端网段（Next App Router 的 Request
 * 拿不到 socket 远端地址，见 resolveRequestClientIp 的说明）。但至少可以做到：
 *  - 非 IP 的任意字符串（含超长串）不再被当作 IP —— 否则它们会直接变成限流桶 key、
 *    审计日志字段与登录提醒正文，是一条无界的 key 注入面；
 *  - `[::1]:1234` / `1.2.3.4:5678` 这类带端口/方括号的写法归一到裸地址，
 *    避免同一来源因端口不同被拆成无数个桶；
 *  - IPv4-mapped IPv6（`::ffff:1.2.3.4`）折回 IPv4，与 nginx 的 $remote_addr 口径一致。
 */
export function normalizeClientIpLiteral(
  value: string | null | undefined
): string | null {
  if (!value) return null;

  let candidate = value.trim();
  if (!candidate) return null;
  // 长度先兜一刀：合法 IPv6 最长 45 字符（IPv4-mapped 全写形式）。
  if (candidate.length > 64) return null;

  // `[::1]` / `[::1]:8080`
  if (candidate.startsWith('[')) {
    const closing = candidate.indexOf(']');
    if (closing === -1) return null;
    candidate = candidate.slice(1, closing);
  } else if (candidate.includes(':') && candidate.split(':').length === 2) {
    // `1.2.3.4:5678`（IPv6 裸写法一定不止一个冒号，故只在恰好一个冒号时剥端口）
    candidate = candidate.slice(0, candidate.indexOf(':'));
  }

  candidate = candidate.toLowerCase();

  // IPv4-mapped IPv6 折回 IPv4
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(candidate);
  if (mapped && isIP(mapped[1]) === 4) {
    return mapped[1];
  }

  return isIP(candidate) === 0 ? null : candidate;
}

/* ------------------------------------------------------------------ */
/*  trusted_proxy 数据库缓存（同步读取，异步刷新）                       */
/*  使用动态 import 避免 WebSocket 服务器加载 prisma 路径别名问题         */
/* ------------------------------------------------------------------ */

let _trustedProxyFromDb: boolean | null = null;
let _trustedProxyCacheTime = 0;
let _refreshing = false;
const TRUSTED_PROXY_CACHE_TTL_MS = 60_000;

function envTrustedProxy(): boolean {
  const configured = process.env.TRUSTED_PROXY?.trim().toLowerCase();
  return configured ? TRUSTED_PROXY_TRUE_VALUES.has(configured) : false;
}

/** 异步从数据库加载 trusted_proxy（不阻塞调用方） */
function refreshTrustedProxyCache(): void {
  if (_refreshing) return;
  _refreshing = true;

  import('@/lib/prisma')
    .then(({ prisma }) =>
      prisma.siteSetting.findUnique({ where: { key: 'trusted_proxy' } })
    )
    .then((row) => {
      if (row) {
        const normalized = row.value.trim().toLowerCase();
        _trustedProxyFromDb = TRUSTED_PROXY_TRUE_VALUES.has(normalized);
      } else {
        _trustedProxyFromDb = null;
      }
      _trustedProxyCacheTime = Date.now();
    })
    .catch(() => {
      // prisma 不可用（如 WS 服务器进程），静默回退到环境变量
    })
    .finally(() => {
      _refreshing = false;
    });
}

/** 手动失效缓存（设置 API 更新后调用） */
export function invalidateTrustedProxyCache(): void {
  _trustedProxyFromDb = null;
  _trustedProxyCacheTime = 0;
}

export function shouldTrustProxyHeaders(): boolean {
  const now = Date.now();

  // 缓存过期或未初始化时，触发异步刷新
  if (now - _trustedProxyCacheTime > TRUSTED_PROXY_CACHE_TTL_MS) {
    refreshTrustedProxyCache();
  }

  // DB 值优先，回退到环境变量
  return _trustedProxyFromDb ?? envTrustedProxy();
}

export function getTrustedForwardedIp(
  forwardedHeader: string | null | undefined
): string | null {
  if (!forwardedHeader) {
    return null;
  }

  const entries = forwardedHeader
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return null;
  }

  // 安全：取【最后】一段，而非最左。nginx 用 `$proxy_add_x_forwarded_for` 会把客户端
  // 自带的 X-Forwarded-For 原样透传 + 在末尾追加真实 $remote_addr，故最左段是攻击者
  // 可伪造的（用来绕过 IP 限流/连接上限或污染审计日志），最后一段才是本机反代写入的
  // 真实来源。多级可信代理场景下应优先用 X-Real-IP（见 resolveRequestClientIp）。
  //
  // M22：最后一段也必须是合法 IP 字面量，否则宁可当「拿不到」——伪造者塞任意字符串
  // 进来就能换一个全新的限流桶。
  return normalizeClientIpLiteral(entries[entries.length - 1]);
}

/* ------------------------------------------------------------------ */
/*  一次性告警（避免每请求刷屏）                                          */
/* ------------------------------------------------------------------ */

const warnedOnce = new Set<string>();

function warnOnce(key: string, payload: Record<string, unknown>, message: string) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  clientIpLogger.warn(payload, message);
}

/** 仅供测试：清空一次性告警去重集合。 */
export function __resetClientIpWarnings(): void {
  warnedOnce.clear();
}

/**
 * M22：可信代理模式下用哪个头取客户端 IP。
 *  - `auto`（默认）：X-Real-IP 优先，回退 X-Forwarded-For 最后一段（历史行为）。
 *  - `x-real-ip` / `x-forwarded-for`：**只**认这一个头，另一个即使存在也不看。
 *
 * 反代只加了 XFF、忘了设置/清洗 X-Real-IP 是常见疏漏；此时攻击者每次换一个
 * `X-Real-IP` 就能拿到无限个新桶。运维把这里钉死成 `x-forwarded-for`，伪造的
 * X-Real-IP 就彻底不参与解析。两个头取值不一致时会打一次告警提示钉死。
 */
type TrustedProxyIpHeader = 'auto' | 'x-real-ip' | 'x-forwarded-for';

function trustedProxyIpHeader(): TrustedProxyIpHeader {
  const configured = process.env.TRUSTED_PROXY_IP_HEADER?.trim().toLowerCase();
  if (configured === 'x-real-ip' || configured === 'x-forwarded-for') {
    return configured;
  }
  return 'auto';
}

/**
 * 从请求头解析客户端 IP。取不到（或不信任代理头）时返回 `'unknown'`。
 *
 * **语义刻意保持不变**：多处调用方（auth/login、auth/register、审计日志、登录提醒）
 * 依赖「拿不到就是 'unknown'」这个约定来决定要不要走 IP 维度的分支。限流不再因此
 * 塌缩成全站单桶 —— 那一层在 rateLimit.ts 的 resolveRateLimitClientKey 里解决。
 *
 * 为什么不能像 server/websocket.ts 那样回落 socket 远端地址：Next App Router 的
 * Route Handler 只拿得到 Web `Request`，没有 socket 句柄。Next 自身虽然在
 * base-server.js 里做过 `req.headers['x-forwarded-for'] ??= socket.remoteAddress`，
 * 但那是 `??=`（只在头缺失时补），客户端自带 XFF 时不会追加，因此**无法**从头部区分
 * 「Next 补的 socket 地址」与「客户端伪造的值」。故此处只能维持 'unknown'。
 */
export function resolveRequestClientIp(req: Request): string {
  const realIpHeader = req.headers.get('x-real-ip');
  const forwardedHeader = req.headers.get('x-forwarded-for');

  if (shouldTrustProxyHeaders()) {
    // 安全：优先 X-Real-IP（nginx 设为 $remote_addr，会覆盖客户端伪造值，不可伪造），
    // 再回退到 X-Forwarded-For 的最后一段。反代后 socket 远端恒为 nginx 自身，故信任
    // 代理头是拿到真实客户端 IP 的唯一途径——这也是生产必须 TRUSTED_PROXY=true 的原因。
    const mode = trustedProxyIpHeader();
    const realIp = normalizeClientIpLiteral(realIpHeader);
    const forwardedIp = getTrustedForwardedIp(forwardedHeader);

    if (mode === 'x-real-ip') return realIp ?? 'unknown';
    if (mode === 'x-forwarded-for') return forwardedIp ?? 'unknown';

    if (realIp && forwardedIp && realIp !== forwardedIp) {
      warnOnce(
        'trusted-proxy-header-mismatch',
        { realIp, forwardedIp },
        'X-Real-IP 与 X-Forwarded-For 末段不一致：至少有一个头没有被反代覆盖，可被伪造以绕过 IP 限流。' +
          '请确认反代同时设置 X-Real-IP $remote_addr 与 X-Forwarded-For $proxy_add_x_forwarded_for，' +
          '或用 TRUSTED_PROXY_IP_HEADER 钉死只信任其中一个。'
      );
    }

    return realIp ?? forwardedIp ?? 'unknown';
  }

  // H7：不信任代理头时**不能**直接用这些头，但可以据此提示运维姿态配错了。
  if (realIpHeader || forwardedHeader) {
    warnOnce(
      'proxy-headers-without-trust',
      {},
      '请求带有 X-Forwarded-For / X-Real-IP 但 TRUSTED_PROXY 未开启：' +
        '所有 IP 维度的限流与告警都会退化（登录/注册的 IP 桶被跳过，通用限流退到路径维度）。' +
        '若本实例确实跑在反代之后，请把 TRUSTED_PROXY 设为 true（或在后台「可信代理」开关打开）。'
    );
  }

  return 'unknown';
}
