import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  CLIENT_SESSION_TOKEN,
  getJwtExpiryConfig,
  setAuthCookie,
  signToken,
} from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { consumeEmailToken } from '@/lib/email/tokens';
import { sendWelcomeEmail } from '@/lib/email';

/**
 * POST /api/auth/verify-email  body: { token }
 * 消费邮箱验证令牌 → 标记 emailVerifiedAt → 自动登录（签发会话）→ 发欢迎邮件。
 * 令牌为 256bit 随机、单次、24h 过期；轻度 IP 限流兜底防刷（穷举本不可行）。
 */
export async function POST(req: Request) {
  const clientIp = resolveRequestClientIp(req);
  if (clientIp !== 'unknown') {
    const limited = await enforceRateLimit(req, {
      scope: 'auth:verify-email:ip',
      limit: 30,
      windowMs: 10 * 60_000,
      key: `ip:${clientIp}`,
    });
    if (limited) return limited;
  }

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return NextResponse.json({ error: '缺少验证令牌' }, { status: 400 });
  }

  const consumed = await consumeEmailToken({ rawToken: token, type: 'VERIFY_EMAIL' });
  if (!consumed) {
    return NextResponse.json(
      { error: '验证链接无效或已过期，请重新获取' },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { id: consumed.userId } });
  if (!user || user.status !== 1) {
    // 账号已被删除/封禁：令牌已消费但不放行。
    return NextResponse.json({ error: '账号不可用' }, { status: 400 });
  }

  // 标记已验证（幂等：仅在未验证时写）。
  if (user.emailVerifiedAt == null) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
  }

  logAction(req, 'user.email.verified', {
    user: { id: user.id, email: user.email, role: user.role },
    userName: user.displayName,
  });

  const siteSettings = await getSiteSettings().catch(() => null);

  // 欢迎邮件（事务类，fire-and-forget）
  void sendWelcomeEmail(
    { id: user.id, email: user.email, displayName: user.displayName },
    { settings: siteSettings ?? undefined }
  );

  // 自动登录：签发会话 cookie。
  const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry);
  const sessionToken = signToken(
    { id: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion },
    { expiresInDays: jwtConfig.expiresInDays }
  );

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
    token: CLIENT_SESSION_TOKEN,
    verified: true,
  });
  setAuthCookie(response, sessionToken, { maxAge: jwtConfig.cookieMaxAge });
  return response;
}
