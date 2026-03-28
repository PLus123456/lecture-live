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
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { resolvePublicRegistrationRole } from '@/lib/userRoles';

export async function POST(req: Request) {
  const siteSettings = await getSiteSettings().catch(() => null);
  const rateLimited = await enforceRateLimit(req, {
    scope: 'auth:register',
    limit: siteSettings?.rate_limit_auth ?? 5,
    windowMs: 10 * 60_000,
  });
  if (rateLimited) {
    return rateLimited;
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

    const { email, password, displayName } = await req.json();

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
