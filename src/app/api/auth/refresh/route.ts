import { NextResponse } from 'next/server';
import {
  AUTH_SESSION_BINDING_HEADER,
  CLIENT_SESSION_TOKEN,
  clearAuthCookie,
  extractTokenFromCookieHeader,
  getAuthTokenSessionBinding,
  getJwtExpiryConfig,
  rotateAuthToken,
  setAuthCookie,
  verifyRefreshAuthToken,
} from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getSiteSettings } from '@/lib/siteSettings';
import { guardAuthMutationRequest } from '@/lib/publicAuth';

/**
 * POST /api/auth/refresh
 * 从 HttpOnly cookie 中读取 JWT，验证后返回用户信息并续签 cookie。
 * 用于页面加载时自动恢复会话，无需重新登录。
 *
 * 每个登录/设备有独立 AuthTokenFamily。数据库 CAS 保证当前叶子只能消费一次；CAS loser
 * 是旧 refresh 凭据重用，持久撤销该 family。数据库只存 jti SHA-256，不缓存/返回后继 JWT。
 */
export async function POST(req: Request) {
  const requestGuard = guardAuthMutationRequest(req);
  if (requestGuard) return requestGuard;
  const expectedBinding = req.headers.get(AUTH_SESSION_BINDING_HEADER);
  // Authenticate the browser mutation before emitting *any* cookie-changing
  // response. A cross-site form POST carries no custom header, but the browser
  // would still apply a target-origin Max-Age=0 response and allow logout CSRF.
  if (!expectedBinding) {
    return buildRefreshError('Session binding required', 428);
  }
  const rawToken = extractTokenFromCookieHeader(req.headers.get('Cookie'));
  if (!rawToken) {
    return buildRefreshError('Unauthorized', 401);
  }
  const cookieBinding = getAuthTokenSessionBinding(rawToken);
  // refresh 会消费一次性 leaf，不能允许 SameSite=Lax 顶层跨站 GET/表单请求触发。
  // 自定义 family binding 既触发 CORS preflight，又把迟到请求绑定到其发起会话。
  if (!cookieBinding) {
    return buildRefreshError('Unauthorized', 401, { clearCookie: true });
  }
  if (expectedBinding !== cookieBinding) {
    return buildRefreshError('Session changed', 409);
  }
  let session;
  try {
    session = await verifyRefreshAuthToken(rawToken);
  } catch (error) {
    console.error('Refresh token verification persistence unavailable:', error);
    // 与坏 token 的 401 区分：DB 暂时不可判定时失败关闭但保留 cookie，用户恢复后仍能
    // 重试或持久撤族，不能把唯一凭据删掉而让攻击者保存的副本日后复活。
    return buildRefreshError('Session verification unavailable', 503);
  }
  if (!session) {
    return buildRefreshError('Unauthorized', 401, { clearCookie: true });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'auth:refresh',
    limit: 60,
    windowMs: 60_000,
    key: `user:${session.user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // 从数据库获取最新用户信息（角色可能已变更）
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      tokenVersion: true,
      status: true,
    },
  });

  if (!user) {
    return buildRefreshError('Unauthorized', 401, { clearCookie: true });
  }
  if (
    user.status !== 1 ||
    user.tokenVersion !== session.token.tokenVersion
  ) {
    return buildRefreshError('Unauthorized', 401, { clearCookie: true });
  }

  // 签发新 token（滑动过期 + 绝对过期：保留初始会话起点）。
  // U51：把 exp / cookieMaxAge 一并钳到剩余绝对寿命——会话起点不变，滑动窗不能超过它。
  const siteSettings = await getSiteSettings().catch(() => null);
  const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry, {
    sessionStartedAt: session.token.sessionStartedAt,
  });
  let rotation;
  try {
    rotation = await rotateAuthToken(session.token, user, {
      expiresInDays: jwtConfig.expiresInDays,
    });
  } catch (error) {
    console.error('Refresh token family rotation failed:', error);
    // DB 无法完成 CAS 时绝不签出一个无权威状态的 token；保留旧 cookie 供故障恢复后重试。
    return buildRefreshError('Session refresh unavailable', 503);
  }
  if (rotation.status === 'reused') {
    return buildRefreshError('Unauthorized', 401, { clearCookie: true });
  }

  const response = buildRefreshResponse(
    user,
    rotation.token,
    jwtConfig.cookieMaxAge
  );
  return response;
}

/** 跨站顶层导航只能发 GET；明确拒绝且绝不轮换/清 cookie。 */
export async function GET() {
  const response = NextResponse.json(
    { error: 'Method not allowed' },
    { status: 405 }
  );
  response.headers.set('Allow', 'POST');
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return response;
}

function buildRefreshError(
  message: string,
  status: number,
  options?: { clearCookie?: boolean }
): NextResponse {
  const response = NextResponse.json({ error: message }, { status });
  if (options?.clearCookie) {
    clearAuthCookie(response);
    response.headers.set('Clear-Site-Data', '"cache"');
  }
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return response;
}

function buildRefreshResponse(
  user: { id: string; email: string; displayName: string | null; role: string },
  token: string,
  cookieMaxAge: number
): NextResponse {
  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
    token: CLIENT_SESSION_TOKEN,
    sessionBinding: getAuthTokenSessionBinding(token),
  });

  // 续签 cookie
  setAuthCookie(response, token, { maxAge: cookieMaxAge });

  // 防止浏览器缓存会话恢复响应
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.headers.set('Clear-Site-Data', '"cache"');

  return response;
}
