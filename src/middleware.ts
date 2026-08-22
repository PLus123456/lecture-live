// src/middleware.ts (Next.js Middleware)
// API 安全中间件：路径穿越检查、JWT 鉴权检查（Header + Cookie）、安全 headers

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const AUTH_COOKIE_NAME = 'lecture-live-token';
const CLIENT_SESSION_TOKEN = '__cookie_session__';
const JWT_ALGORITHM = 'HS256';

let jwtSecretKeyPromise: Promise<CryptoKey> | null = null;

function hasTraversalAttempt(pathname: string) {
  if (pathname.includes('..')) {
    return true;
  }

  try {
    return decodeURIComponent(pathname).includes('..');
  } catch {
    return true;
  }
}

function applySecurityHeaders(response: NextResponse) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return response;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const base64 = normalized + padding;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function decodeJwtPart(part: string): unknown {
  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(base64UrlToBytes(part)));
}

async function getJwtSecretKey(): Promise<CryptoKey | null> {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    return null;
  }

  if (!jwtSecretKeyPromise) {
    jwtSecretKeyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
  }

  try {
    return await jwtSecretKeyPromise;
  } catch {
    jwtSecretKeyPromise = null;
    return null;
  }
}

async function isValidJwt(token: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  try {
    const header = decodeJwtPart(headerPart) as {
      alg?: string;
      typ?: string;
    };
    const payload = decodeJwtPart(payloadPart) as {
      exp?: number;
      nbf?: number;
    };

    if (header.alg !== JWT_ALGORITHM) {
      return false;
    }

    const nowSeconds = Date.now() / 1000;
    if (typeof payload.exp === 'number' && payload.exp <= nowSeconds) {
      return false;
    }

    if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) {
      return false;
    }

    const key = await getJwtSecretKey();
    if (!key) {
      return false;
    }

    const signature = new Uint8Array(base64UrlToBytes(signaturePart));
    const data = new Uint8Array(new TextEncoder().encode(`${headerPart}.${payloadPart}`));
    return crypto.subtle.verify('HMAC', key, signature, data);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  L9：CSRF —— Origin 同源校验（SameSite=Lax 之外的第二道门）             */
/* ------------------------------------------------------------------ */

/** 会改状态的方法。GET/HEAD/OPTIONS 天然不该有副作用，不查。 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 机器对机器的入口：调用方是支付网关 / 外部翻译 worker，不带 Origin，
 * 鉴权由各自的验签 / 任务级凭据承担。显式豁免，避免任何 CSRF 判定误伤支付回调。
 */
const CSRF_EXEMPT_PREFIXES = [
  '/api/wallet/callback/',
  '/api/wallet/sandbox/',
  '/api/translate/llm-proxy/',
  '/api/health',
];

function hostnameOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.split(',')[0]?.trim();
  if (!trimmed) return null;
  try {
    // 裸 host（`example.com:3000`）补上 scheme 才能被 URL 解析
    const url = trimmed.includes('://')
      ? new URL(trimmed)
      : new URL(`http://${trimmed}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function allowedCsrfHostnames(request: NextRequest): Set<string> {
  const allowed = new Set<string>();

  // 请求自身声称的 host（经反代时是 x-forwarded-host）
  for (const candidate of [
    request.headers.get('x-forwarded-host'),
    request.headers.get('host'),
    request.nextUrl.host,
  ]) {
    const hostname = hostnameOf(candidate);
    if (hostname) allowed.add(hostname);
  }

  // 部署配置的站点地址 + 可选的额外白名单
  for (const candidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    ...(process.env.CSRF_ALLOWED_ORIGINS?.split(',') ?? []),
  ]) {
    const hostname = hostnameOf(candidate);
    if (hostname) allowed.add(hostname);
  }

  return allowed;
}

/**
 * L9：全站此前只有 cookie 的 `SameSite=Lax` 一层 CSRF 防线，没有任何
 * Origin/Referer 校验。Lax 能挡住跨站表单 POST，但它是**浏览器**的行为：
 * 老浏览器（Chrome<80 / Safari<12，以及部分把 cookie 当 None 处理的实现）
 * 下跨站表单可以带着受害者的 cookie 打任意写接口。
 *
 * 判定口径（刻意保守，优先不误伤生产）：
 *  - 只查会改状态的方法；
 *  - **只在请求带了 Origin 时**才判定。现代浏览器对跨站写请求必带 Origin，
 *    而 curl / 支付网关 / worker 这类非浏览器调用方不带 —— 不带就放行，
 *    它们本来也不受 CSRF 影响（没有受害者的 cookie）。
 *  - 只比 **hostname**，不比 scheme/port。反代漏配 x-forwarded-proto 时
 *    「算出 http:// 而 Origin 是 https://」会把全站写操作打死，
 *    那是比 CSRF 更严重的可用性事故，不值得为此收紧一档。
 */
function isCsrfViolation(request: NextRequest): boolean {
  if (!UNSAFE_METHODS.has(request.method)) return false;
  if (!request.nextUrl.pathname.startsWith('/api/')) return false;
  if (
    CSRF_EXEMPT_PREFIXES.some((prefix) =>
      request.nextUrl.pathname.startsWith(prefix)
    )
  ) {
    return false;
  }

  const origin = request.headers.get('origin');
  if (!origin) return false;

  // `Origin: null`（sandboxed iframe / 某些跨站跳转）没有可校验的来源，按不同源处理
  const originHostname = origin === 'null' ? null : hostnameOf(origin);
  if (!originHostname) return true;

  return !allowedCsrfHostnames(request).has(originHostname);
}

export async function middleware(request: NextRequest) {
  // 1. 路径穿越检查：URL 中不应包含 ..
  if (hasTraversalAttempt(request.nextUrl.pathname)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // 1.5 CSRF：跨站来源的写请求一律拒绝（详见 isCsrfViolation）
  if (isCsrfViolation(request)) {
    return NextResponse.json(
      { error: 'Cross-site request blocked' },
      { status: 403 }
    );
  }

  // 2. API 路由鉴权（/api/* 除了 /api/auth/*, /api/share/view/*, /api/setup* 等公开端点）
  //    充值支付回调 /api/wallet/callback/* 与沙箱确认页 /api/wallet/sandbox/* 也放行：
  //    网关异步通知/浏览器跳转不带用户 JWT，鉴权由各 provider 的验签（verifyCallback）承担。
  //    翻译 LLM 代理 /api/translate/llm-proxy/* 同理：调用方是外部翻译 worker（无用户 JWT），
  //    鉴权由端点校验任务级代理凭据（TranslationTask.proxyTokenHash）承担。
  const isProtectedApi =
    request.nextUrl.pathname.startsWith('/api/') &&
    !request.nextUrl.pathname.startsWith('/api/auth/') &&
    !request.nextUrl.pathname.startsWith('/api/health') &&
    !request.nextUrl.pathname.startsWith('/api/assets/icons/') &&
    !request.nextUrl.pathname.startsWith('/api/share/view/') &&
    !request.nextUrl.pathname.startsWith('/api/site-config') &&
    !request.nextUrl.pathname.startsWith('/api/wallet/callback/') &&
    !request.nextUrl.pathname.startsWith('/api/wallet/sandbox/') &&
    !request.nextUrl.pathname.startsWith('/api/translate/llm-proxy/') &&
    !request.nextUrl.pathname.startsWith('/api/setup');

  const authHeader = request.headers.get('Authorization');
  const bearerToken =
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const hasBearerHeader =
    Boolean(bearerToken) && bearerToken !== CLIENT_SESSION_TOKEN;
  const cookieToken = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (isProtectedApi) {
    // 优先用 Authorization header，其次用 cookie
    if (!hasBearerHeader && !cookieToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const tokenToValidate = hasBearerHeader ? bearerToken : cookieToken;
    if (!tokenToValidate || !(await isValidJwt(tokenToValidate))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // 3. 如果没有 Authorization header 但有 cookie，将 cookie 中的 token 注入到
  //    请求 header 中，这样下游 API route 的 verifyAuth() 可以统一从 header 读取。
  if (!hasBearerHeader && cookieToken) {
    // Clone request headers with the injected Authorization
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('Authorization', `Bearer ${cookieToken}`);
    return applySecurityHeaders(NextResponse.next({
      request: { headers: requestHeaders },
    }));
  }

  // 4. 安全 headers
  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ['/api/:path*', '/session/:path*/view'],
};
