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

export async function middleware(request: NextRequest) {
  // 1. 路径穿越检查：URL 中不应包含 ..
  if (hasTraversalAttempt(request.nextUrl.pathname)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // 2. API 路由鉴权（/api/* 除了 /api/auth/*, /api/share/view/*, /api/setup*）
  const isProtectedApi =
    request.nextUrl.pathname.startsWith('/api/') &&
    !request.nextUrl.pathname.startsWith('/api/auth/') &&
    !request.nextUrl.pathname.startsWith('/api/health') &&
    !request.nextUrl.pathname.startsWith('/api/assets/icons/') &&
    !request.nextUrl.pathname.startsWith('/api/share/view/') &&
    !request.nextUrl.pathname.startsWith('/api/site-config') &&
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
