import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { enforceRateLimit } from '@/lib/rateLimit';

export const PUBLIC_AUTH_BODY_MAX_BYTES = 8 * 1024;

const PUBLIC_AUTH_GLOBAL_LIMIT = 600;
const PUBLIC_AUTH_GLOBAL_WINDOW_MS = 60_000;
const PUBLIC_AUTH_IP_LIMIT = 120;
const PUBLIC_AUTH_IP_WINDOW_MS = 60_000;

interface PublicAuthPreludeOptions {
  scope: string;
  endpointIpLimit: number;
  endpointWindowMs: number;
}

export interface PublicAuthPreludeResult {
  clientIp: string;
  response: NextResponse | null;
}

/**
 * Cheap gates for anonymous authentication routes.
 *
 * This must run before reading the request body, loading site settings, or
 * deriving an account-specific key. The global bucket remains active even
 * when the proxy topology cannot safely identify a client IP.
 *
 * 顺序：先按来源 IP 的两个桶，再全站桶，且只有通过 IP 桶的请求才计入全站预算。
 * 旧顺序（全站桶在前）下，单个客户端每分钟 600 个请求（正文都不必合法——这一层在解析
 * 正文之前）就能把 `auth:public:global` 打满，全站所有人的登录 / 注册 / 找回密码一起 429；
 * 它自己的 IP 桶（120/min）只在请求已被全站桶计数之后才生效，拦不住这种消耗。
 * IP 解析不出来（拓扑无法安全识别来源）时仍只剩全站桶这一道固定基数的闸，与旧口径一致。
 */
export async function enforcePublicAuthPrelude(
  req: Request,
  options: PublicAuthPreludeOptions
): Promise<PublicAuthPreludeResult> {
  const clientIp = resolveRequestClientIp(req);

  if (clientIp !== 'unknown') {
    const sharedIpLimited = await enforceRateLimit(req, {
      scope: 'auth:public:ip',
      limit: PUBLIC_AUTH_IP_LIMIT,
      windowMs: PUBLIC_AUTH_IP_WINDOW_MS,
      key: `ip:${clientIp}`,
    });
    if (sharedIpLimited) {
      return { clientIp, response: sharedIpLimited };
    }

    const endpointIpLimited = await enforceRateLimit(req, {
      scope: `auth:${options.scope}:prelude:ip`,
      limit: options.endpointIpLimit,
      windowMs: options.endpointWindowMs,
      key: `ip:${clientIp}`,
    });
    if (endpointIpLimited) {
      return { clientIp, response: endpointIpLimited };
    }
  }

  const globallyLimited = await enforceRateLimit(req, {
    scope: 'auth:public:global',
    limit: PUBLIC_AUTH_GLOBAL_LIMIT,
    windowMs: PUBLIC_AUTH_GLOBAL_WINDOW_MS,
    key: 'global',
  });
  return { clientIp, response: globallyLimited };
}

export function publicAuthAccountKey(
  kind: 'email' | 'token',
  normalizedValue: string
): string {
  const digest = createHash('sha256').update(normalizedValue, 'utf8').digest('hex');
  return `${kind}:sha256:${digest}`;
}

type PublicAuthJsonResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

function invalidBodyResponse(): NextResponse {
  return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
}

/**
 * 公开认证路由的字符串字段准入：缺省 / null 视为「未填」，交给各路由按业务口径处理；
 * 其余非字符串（数字、数组、对象……）一律是畸形请求 → 400。必须排在任何 normalizeEmail /
 * `.trim()` 之前——那些调用大多在 try 之外，对非字符串抛 TypeError 会直接变成框架 500。
 */
export function rejectMalformedStringFields(
  body: Record<string, unknown>,
  fields: readonly string[]
): NextResponse | null {
  const malformed = fields.some((field) => {
    const value = body[field];
    return value !== undefined && value !== null && typeof value !== 'string';
  });
  return malformed ? invalidBodyResponse() : null;
}

function oversizedBodyResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Request body too large' },
    { status: 413 }
  );
}

function authMutationRejection(message: string, status: 403 | 415): NextResponse {
  const response = NextResponse.json({ error: message }, { status });
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return response;
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null;
}

/**
 * Origins a browser may legitimately have addressed this request to.
 *
 * `new URL(req.url).origin` is NOT one of them on its own: in a Next standalone
 * server `req.url` is rebuilt from the process bind address (HOSTNAME/PORT), not
 * from the public Host header, so behind nginx it is always `http://localhost:3000`
 * while the browser sends the real site origin. Comparing the two rejected every
 * authenticated mutation in production.
 *
 * Deriving the expected origin from Host / X-Forwarded-Host keeps the CSRF property
 * intact: in a cross-site attack the attacker cannot forge `Origin` (the browser sets
 * it), and the browser derives `Host` from the URL the user actually visited, so the
 * two only agree for a genuine same-origin request.
 */
export function acceptableAuthMutationOrigins(req: Request): Set<string> {
  const origins = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) return;
    try {
      origins.add(new URL(value).origin);
    } catch {
      /* not a usable origin — ignore */
    }
  };

  let requestUrl: URL | null = null;
  try {
    requestUrl = new URL(req.url);
  } catch {
    requestUrl = null;
  }

  const protocol =
    firstHeaderValue(req.headers.get('x-forwarded-proto'))?.replace(/:$/, '') ||
    requestUrl?.protocol.replace(/:$/, '') ||
    'http';

  for (const host of [
    firstHeaderValue(req.headers.get('x-forwarded-host')),
    firstHeaderValue(req.headers.get('host')),
  ]) {
    if (host) add(`${protocol}://${host}`);
  }

  // Configured canonical origin, and the bind-address origin so that direct local
  // development and the e2e harness keep working without a proxy in front.
  add(process.env.NEXT_PUBLIC_APP_URL?.trim());
  if (requestUrl) add(requestUrl.origin);

  return origins;
}

/**
 * Browser-side auth mutations must be same-origin. In particular, a sibling
 * subdomain can submit a no-CORS text/plain login form and the browser will
 * still apply a Set-Cookie response unless Origin/Fetch-Metadata are checked.
 *
 * Requests without browser metadata remain available to trusted CLI/bootstrap
 * clients, but JSON endpoints still require an explicit application/json media
 * type. This guard never emits Set-Cookie or Clear-Site-Data.
 */
export function guardAuthMutationRequest(
  req: Request,
  options: { requireJson?: boolean } = {}
): NextResponse | null {
  const fetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    return authMutationRejection('Cross-origin auth mutation rejected', 403);
  }

  const origin = req.headers.get('origin');
  if (origin) {
    let normalizedOrigin: string;
    try {
      normalizedOrigin = new URL(origin).origin;
    } catch {
      return authMutationRejection('Cross-origin auth mutation rejected', 403);
    }
    if (!acceptableAuthMutationOrigins(req).has(normalizedOrigin)) {
      return authMutationRejection('Cross-origin auth mutation rejected', 403);
    }
  }

  if (options.requireJson) {
    const mediaType = req.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== 'application/json') {
      return authMutationRejection('Content-Type must be application/json', 415);
    }
  }

  return null;
}

/**
 * Parse a small JSON object without ever buffering an unbounded chunked body.
 * Content-Length is an early rejection only; actual streamed bytes are always
 * counted because the header may be missing or dishonest.
 */
export async function readPublicAuthJson<T extends Record<string, unknown>>(
  req: Request,
  maxBytes = PUBLIC_AUTH_BODY_MAX_BYTES
): Promise<PublicAuthJsonResult<T>> {
  const requestGuard = guardAuthMutationRequest(req, { requireJson: true });
  if (requestGuard) return { ok: false, response: requestGuard };

  const declaredLength = req.headers.get('content-length')?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      return { ok: false, response: oversizedBodyResponse() };
    }
  }

  if (!req.body) {
    return { ok: false, response: invalidBodyResponse() };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('public auth body exceeds byte limit').catch(() => undefined);
        return { ok: false, response: oversizedBodyResponse() };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: invalidBodyResponse() };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: invalidBodyResponse() };
    }
    return { ok: true, body: parsed as T };
  } catch {
    return { ok: false, response: invalidBodyResponse() };
  }
}
