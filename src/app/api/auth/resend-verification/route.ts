import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logAction } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
import { getSiteSettings } from '@/lib/siteSettings';
import { normalizeEmail, isValidEmailAddress } from '@/lib/email/domains';
import { isEmailEnabled, sendVerificationEmail } from '@/lib/email';

/**
 * POST /api/auth/resend-verification  body: { email }
 * 重发邮箱验证邮件。防枚举：无论账号是否存在/是否已验证，一律返回相同的通用成功响应。
 * 双重限流（email + IP），窗口比登录更紧，防止被当作发信炸弹。
 */
const GENERIC_OK = {
  ok: true,
  message: '如果该邮箱对应待验证的账号，我们已重新发送验证邮件，请查收',
};

export async function POST(req: Request) {
  const siteSettings = await getSiteSettings().catch(() => null);

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const email = normalizeEmail(body.email ?? '').slice(0, 255);

  // 限流：每邮箱 3 次 / 10 分钟；每 IP 10 次 / 10 分钟。
  const emailLimited = email
    ? await enforceRateLimit(req, {
        scope: 'auth:resend-verification',
        limit: 3,
        windowMs: 10 * 60_000,
        key: `email:${email}`,
      })
    : null;
  if (emailLimited) return emailLimited;

  const clientIp = resolveRequestClientIp(req);
  if (clientIp !== 'unknown') {
    const ipLimited = await enforceRateLimit(req, {
      scope: 'auth:resend-verification:ip',
      limit: 10,
      windowMs: 10 * 60_000,
      key: `ip:${clientIp}`,
    });
    if (ipLimited) return ipLimited;
  }

  // 无效邮箱或邮件系统未启用：静默返回通用成功（不泄露差异）。
  if (!email || !isValidEmailAddress(email) || !(await isEmailEnabled(siteSettings ?? undefined))) {
    return NextResponse.json(GENERIC_OK);
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, displayName: true, status: true, emailVerifiedAt: true },
    });

    // 仅对「存在 + 正常 + 未验证」发送；其余情况静默。
    if (user && user.status === 1 && user.emailVerifiedAt == null) {
      await sendVerificationEmail(user, {
        settings: siteSettings ?? undefined,
        requestIp: clientIp === 'unknown' ? null : clientIp,
      });
      logAction(req, 'user.verification.resend', {
        user: { id: user.id, email: user.email, role: 'FREE' },
        userName: user.displayName,
      });
    }
  } catch (err) {
    // 出错也不改变对外响应（防枚举），仅记日志。
    logger.error({ err: serializeError(err) }, '[resend-verification] 处理失败');
  }

  return NextResponse.json(GENERIC_OK);
}
