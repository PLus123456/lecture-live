import { NextResponse } from 'next/server';
import {
  changePassword,
  getJwtExpiryConfig,
  revokeToken,
  setAuthCookie,
  signToken,
  validatePassword,
  verifyAuthSession,
} from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';

export async function POST(req: Request) {
  try {
    const session = await verifyAuthSession(req);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const siteSettings = await getSiteSettings().catch(() => null);

    const rateLimited = await enforceRateLimit(req, {
      scope: 'auth:change-password',
      limit: siteSettings?.rate_limit_auth ?? 5,
      windowMs: 10 * 60_000,
      key: `user:${session.user.id}`,
    });
    if (rateLimited) {
      return rateLimited;
    }

    const { currentPassword, newPassword } = await req.json();

    if (!siteSettings) {
      throw new Error('Site settings unavailable');
    }

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Current password and new password are required' },
        { status: 400 }
      );
    }

    const passwordError = validatePassword(newPassword, {
      minLength: siteSettings.password_min_length,
    });
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const updatedUser = await changePassword(
      session.user.id,
      currentPassword,
      newPassword,
      { bcryptRounds: siteSettings.bcrypt_rounds }
    );

    logAction(req, 'user.password.change', { user: session.user });

    await revokeToken(session.token);

    const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry);
    const response = NextResponse.json({
      message: 'Password changed successfully',
    });
    setAuthCookie(
      response,
      signToken(updatedUser, {
        sessionStartedAt: Date.now(),
        expiresInDays: jwtConfig.expiresInDays,
      }),
      { maxAge: jwtConfig.cookieMaxAge }
    );
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === 'Current password is incorrect') {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('Change password error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
