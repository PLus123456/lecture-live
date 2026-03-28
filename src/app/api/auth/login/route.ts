import { NextResponse } from 'next/server';
import { CLIENT_SESSION_TOKEN, getJwtExpiryConfig, login, setAuthCookie } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  const siteSettings = await getSiteSettings().catch(() => null);
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  // 使用 email+IP 组合键进行限流，避免共享 IP 环境下误伤其他用户
  const emailKey = (body.email ?? '').trim().toLowerCase().slice(0, 255);
  const rateLimited = await enforceRateLimit(req, {
    scope: 'auth:login',
    limit: siteSettings?.rate_limit_auth ?? 10,
    windowMs: 60_000,
    ...(emailKey ? { key: `email:${emailKey}` } : {}),
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: 'email and password are required' },
        { status: 400 }
      );
    }

    const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry);
    const { user, token } = await login(email, password, {
      jwtExpiryDays: jwtConfig.expiresInDays,
    });

    logAction(req, 'user.login', {
      user: { id: user.id, email: user.email, role: user.role },
      userName: user.displayName,
    });

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      token: CLIENT_SESSION_TOKEN,
    });

    // 设置 HttpOnly cookie（使用数据库配置的过期天数）
    setAuthCookie(response, token, { maxAge: jwtConfig.cookieMaxAge });

    return response;
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid credentials') {
      logAction(req, 'user.login.failed', { detail: `邮箱: ${emailKey || 'unknown'}` });
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
