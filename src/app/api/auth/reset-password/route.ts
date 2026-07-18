import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { validatePassword } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { consumeEmailToken } from '@/lib/email/tokens';
import { sendSecurityAlertEmail } from '@/lib/email';

/**
 * POST /api/auth/reset-password  body: { token, password }
 * 消费重置令牌 → 校验新密码强度 → 改密 + tokenVersion++（吊销全部旧会话）→ 发改密安全提醒。
 * 不自动登录：重置成功后要求用新密码重新登录（更保守，且重置常发生在异设备）。
 */
export async function POST(req: Request) {
  const siteSettings = await getSiteSettings().catch(() => null);

  const clientIp = resolveRequestClientIp(req);
  if (clientIp !== 'unknown') {
    const limited = await enforceRateLimit(req, {
      scope: 'auth:reset-password:ip',
      limit: 20,
      windowMs: 15 * 60_000,
      key: `ip:${clientIp}`,
    });
    if (limited) return limited;
  }

  let body: { token?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!token || !password) {
    return NextResponse.json({ error: '缺少令牌或新密码' }, { status: 400 });
  }

  const passwordError = validatePassword(password, {
    minLength: siteSettings?.password_min_length,
  });
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  // 先校验令牌再改密：consume 成功即认领该令牌（单次）。
  const consumed = await consumeEmailToken({ rawToken: token, type: 'RESET_PASSWORD' });
  if (!consumed) {
    return NextResponse.json(
      { error: '重置链接无效或已过期，请重新申请' },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { id: consumed.userId } });
  if (!user || user.status !== 1) {
    return NextResponse.json({ error: '账号不可用' }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, siteSettings?.bcrypt_rounds ?? 12);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      tokenVersion: { increment: 1 }, // 吊销所有已签发会话
      // 借重置完成同时视为邮箱已验证（能收到重置邮件即证明邮箱可达）。
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    },
  });

  logAction(req, 'user.password.reset', {
    user: { id: user.id, email: user.email, role: user.role },
    userName: user.displayName,
  });

  // 改密安全提醒（事务类，fire-and-forget）
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  void sendSecurityAlertEmail(
    { id: user.id, email: user.email, displayName: user.displayName },
    { kind: 'password_changed', ip: clientIp === 'unknown' ? null : clientIp, when },
    { settings: siteSettings ?? undefined }
  );

  return NextResponse.json({ ok: true, message: '密码已重置，请用新密码登录' });
}
