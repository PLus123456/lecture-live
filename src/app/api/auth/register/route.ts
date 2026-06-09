import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  CLIENT_SESSION_TOKEN,
  getJwtExpiryConfig,
  registerWithOptions,
  setAuthCookie,
  validatePassword,
} from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { resolvePublicRegistrationRole } from '@/lib/userRoles';

export async function POST(req: Request) {
  const siteSettings = await getSiteSettings().catch(() => null);

  let body: { email?: string; password?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const authLimit = siteSettings?.rate_limit_auth ?? 5;
  // 安全：按 email 维度限流。若退回纯 IP 桶，在 trusted_proxy=false（默认）下所有请求
  // 共用同一个 ip:unknown 全局桶，单一匿名攻击者发几次即可打满、锁死全站注册（自愈但可持续）。
  const emailKey = (body.email ?? '').trim().toLowerCase().slice(0, 255);
  const rateLimited = await enforceRateLimit(req, {
    scope: 'auth:register',
    limit: authLimit,
    windowMs: 10 * 60_000,
    ...(emailKey ? { key: `email:${emailKey}` } : {}),
  });
  if (rateLimited) {
    return rateLimited;
  }

  // 额外按真实来源 IP 限流（仅当 IP 可确定时；trusted_proxy=false 时为 'unknown' 则跳过，
  // 避免再退化成全局桶）。用于挡同一来源批量注册不同 email。
  const clientIp = resolveRequestClientIp(req);
  if (clientIp !== 'unknown') {
    const ipLimited = await enforceRateLimit(req, {
      scope: 'auth:register:ip',
      limit: authLimit * 5,
      windowMs: 10 * 60_000,
      key: `ip:${clientIp}`,
    });
    if (ipLimited) {
      return ipLimited;
    }
  }

  try {
    if (!siteSettings) {
      throw new Error('Site settings unavailable');
    }

    if (!siteSettings.allow_registration) {
      return NextResponse.json(
        { error: 'Registration is disabled' },
        { status: 403 }
      );
    }

    const { email, password, displayName } = body;

    if (!email || !password || !displayName) {
      return NextResponse.json(
        { error: 'email, password, and displayName are required' },
        { status: 400 }
      );
    }

    const passwordError = validatePassword(password, {
      minLength: siteSettings.password_min_length,
    });
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const jwtConfig = getJwtExpiryConfig(siteSettings.jwt_expiry);
    const { user, token } = await registerWithOptions(email, password, displayName, {
      role: resolvePublicRegistrationRole(siteSettings.default_group),
      bcryptRounds: siteSettings.bcrypt_rounds,
      jwtExpiryDays: jwtConfig.expiresInDays,
    });

    logAction(req, 'user.register', {
      user: { id: user.id, email: user.email, role: user.role },
      userName: user.displayName,
    });

    const response = NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
        },
        token: CLIENT_SESSION_TOKEN,
      },
      { status: 201 }
    );

    // 设置 HttpOnly cookie（使用数据库配置的过期天数）
    setAuthCookie(response, token, { maxAge: jwtConfig.cookieMaxAge });

    return response;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'Registration failed' },
        { status: 400 }
      );
    }
    console.error('Register error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
