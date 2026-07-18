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

// 事务内用于回滚的哨兵错误（事务回调只能靠抛错回滚，返回值一律提交）。
const TOKEN_INVALID = 'verify-email:token-invalid';
const ACCOUNT_UNAVAILABLE = 'verify-email:account-unavailable';

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

  // 认领与「标记已验证」放在同一事务里：先烧后用的话，认领成功之后任何一步抛错
  // （瞬时 DB 故障、账号被封）都会留下一枚已 consumedAt 但没生效的令牌，链接永久报废，
  // 用户还可能撞在重发限流里干等。事务内抛错即回滚认领，链接在 TTL 内仍然可用。
  let user: NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
  try {
    user = await prisma.$transaction(async (tx) => {
      const consumed = await consumeEmailToken({ rawToken: token, type: 'VERIFY_EMAIL', db: tx });
      if (!consumed) throw new Error(TOKEN_INVALID);

      const found = await tx.user.findUnique({ where: { id: consumed.userId } });
      // 账号已被删除/封禁：回滚认领，令牌留着（解封后仍在 TTL 内就还能用）。
      if (!found || found.status !== 1) throw new Error(ACCOUNT_UNAVAILABLE);

      // 标记已验证（幂等：仅在未验证时写）。
      if (found.emailVerifiedAt == null) {
        await tx.user.update({
          where: { id: found.id },
          data: { emailVerifiedAt: new Date() },
        });
      }
      return found;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === TOKEN_INVALID) {
      return NextResponse.json(
        { error: '验证链接无效或已过期，请重新获取' },
        { status: 400 }
      );
    }
    if (message === ACCOUNT_UNAVAILABLE) {
      return NextResponse.json({ error: '账号不可用' }, { status: 400 });
    }
    // 其余（DB 故障等）：令牌已随事务回滚，可安全重试同一链接。
    console.error('Verify email error:', error);
    return NextResponse.json({ error: '验证失败，请稍后重试' }, { status: 500 });
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
