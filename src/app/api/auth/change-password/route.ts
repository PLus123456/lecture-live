import { NextResponse } from 'next/server';
import {
  changePasswordAndReissueSession,
  getAuthTokenSessionBinding,
  getJwtExpiryConfig,
  isAuthVerificationInfrastructureError,
  setAuthCookie,
  validatePassword,
  verifyAuthSession,
} from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { guardAuthMutationRequest } from '@/lib/publicAuth';

export async function POST(req: Request) {
  const requestGuard = guardAuthMutationRequest(req, { requireJson: true });
  if (requestGuard) return requestGuard;
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
    // 非字符串口令会让 bcrypt.compare 抛 "Illegal arguments" → 落进下面的 500。
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const passwordError = validatePassword(newPassword, {
      minLength: siteSettings.password_min_length,
    });
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    // 改密 + 撤销当前 family + 签发新 family 同一事务提交（见 changePasswordAndReissueSession）：
    // 旧实现三步各自提交，后两步任一步瞬时失败就回 500，而密码其实已经改掉、所有会话都已失效。
    const jwtConfig = getJwtExpiryConfig(siteSettings.jwt_expiry);
    const { token } = await changePasswordAndReissueSession(
      session.token,
      currentPassword,
      newPassword,
      {
        bcryptRounds: siteSettings.bcrypt_rounds,
        expiresInDays: jwtConfig.expiresInDays,
      }
    );

    logAction(req, 'user.password.change', { user: session.user });

    const response = NextResponse.json({
      message: 'Password changed successfully',
      sessionBinding: getAuthTokenSessionBinding(token),
    });
    setAuthCookie(response, token, { maxAge: jwtConfig.cookieMaxAge });
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === 'Current password is incorrect') {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // 认证真源（DB）暂不可判定：503 而不是 401，前端不会因此登出并撤销仍有效的会话。
    if (isAuthVerificationInfrastructureError(error)) {
      return NextResponse.json(
        { error: 'Session verification unavailable' },
        { status: 503 }
      );
    }
    console.error('Change password error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
