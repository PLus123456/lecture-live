const TRUSTED_PROXY_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
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

  // 取第一个 IP（最原始的客户端），最后一个通常是最近的代理
  return entries[0] ?? null;
}

export function resolveRequestClientIp(req: Request): string {
  if (shouldTrustProxyHeaders()) {
    return (
      getTrustedForwardedIp(req.headers.get('x-forwarded-for')) ??
      normalizeIp(req.headers.get('x-real-ip')) ??
      'unknown'
    );
  }

  return 'unknown';
}
