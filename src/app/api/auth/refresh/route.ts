import { NextResponse } from 'next/server';
import {
  CLIENT_SESSION_TOKEN,
  getJwtExpiryConfig,
  revokeToken,
  setAuthCookie,
  signToken,
  verifyAuthSession,
} from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getSiteSettings } from '@/lib/siteSettings';

/**
 * GET /api/auth/refresh
 * 从 HttpOnly cookie 中读取 JWT，验证后返回用户信息并续签 cookie。
 * 用于页面加载时自动恢复会话，无需重新登录。
 */
export async function GET(req: Request) {
  const session = await verifyAuthSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // 签发新 token（滑动过期 + 绝对过期：保留初始会话起点）
  const siteSettings = await getSiteSettings().catch(() => null);
  const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry);
  const newToken = signToken(user, {
    sessionStartedAt: session.token.sessionStartedAt,
    expiresInDays: jwtConfig.expiresInDays,
  });
  await revokeToken(session.token);

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
    token: CLIENT_SESSION_TOKEN,
  });

  // 续签 cookie
  setAuthCookie(response, newToken, { maxAge: jwtConfig.cookieMaxAge });

  // 防止浏览器缓存会话恢复响应
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  return response;
}
