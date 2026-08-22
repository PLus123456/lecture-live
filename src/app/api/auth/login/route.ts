import { NextResponse } from 'next/server';
import {
  CLIENT_SESSION_TOKEN,
  EMAIL_NOT_VERIFIED_ERROR,
  getAuthTokenSessionBinding,
  getJwtExpiryConfig,
  login,
  setAuthCookie,
} from '@/lib/auth';
import {
  enforcePublicAuthPrelude,
  publicAuthAccountKey,
  readPublicAuthJson,
} from '@/lib/publicAuth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { normalizeEmail } from '@/lib/email/domains';
import { isEmailEnabled } from '@/lib/email';
import { maybeNotifyNewDeviceLogin } from '@/lib/email/loginAlert';

export async function POST(req: Request) {
  const prelude = await enforcePublicAuthPrelude(req, {
    scope: 'login',
    endpointIpLimit: 50,
    endpointWindowMs: 60_000,
  });
  if (prelude.response) return prelude.response;

  const parsed = await readPublicAuthJson<{ email?: string; password?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const siteSettings = await getSiteSettings().catch(() => null);

  // 按 email 维度限流，避免共享 IP 环境下误伤其他用户（针对单账号的暴破被节流）。
  const authLimit = siteSettings?.rate_limit_auth ?? 10;
  const emailKey = normalizeEmail(body.email ?? '').slice(0, 255);
  const rateLimited = emailKey
    ? await enforceRateLimit(req, {
        scope: 'auth:login',
        limit: authLimit,
        windowMs: 60_000,
        key: publicAuthAccountKey('email', emailKey),
      })
    : null;
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const { password } = body;
    const email = normalizeEmail(body.email ?? '');

    if (!email || !password) {
      return NextResponse.json(
        { error: 'email and password are required' },
        { status: 400 }
      );
    }

    const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry);
    // 邮箱验证硬门禁：站点开关开启且邮件系统可用时，未验证账号即使口令正确也拒绝登录。
    const requireEmailVerified =
      !!siteSettings?.email_verification && (await isEmailEnabled(siteSettings ?? undefined));
    const { user, token } = await login(email, password, {
      jwtExpiryDays: jwtConfig.expiresInDays,
      bcryptRounds: siteSettings?.bcrypt_rounds,
      requireEmailVerified,
    });

    logAction(req, 'user.login', {
      user: { id: user.id, email: user.email, role: user.role },
      userName: user.displayName,
    });

    // 新设备/异地登录安全提醒（best-effort，非阻塞；仅 Redis 可用时生效，首登只播种不提醒）。
    void maybeNotifyNewDeviceLogin(
      { id: user.id, email: user.email, displayName: user.displayName, emailPreferences: user.emailPreferences },
      req,
      siteSettings ?? undefined
    );

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

    // 设置 HttpOnly cookie（使用数据库配置的过期天数）
    setAuthCookie(response, token, { maxAge: jwtConfig.cookieMaxAge });
    response.headers.set('Clear-Site-Data', '"cache"');

    return response;
  } catch (error) {
    // 未验证：密码已核对正确才会走到这里（不泄露账号存在性）。返回 403 + needsVerification，
    // 前端据此提示「去邮箱验证 / 重发验证邮件」。
    if (error instanceof Error && error.message === EMAIL_NOT_VERIFIED_ERROR) {
      logAction(req, 'user.login.unverified', { detail: `邮箱: ${emailKey || 'unknown'}` });
      return NextResponse.json(
        {
          error: '邮箱尚未验证，请先完成邮箱验证',
          needsVerification: true,
          email: emailKey,
        },
        { status: 403 }
      );
    }
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
