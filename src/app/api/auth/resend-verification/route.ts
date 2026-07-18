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

  // 无效邮箱、邮件系统未启用、或站点根本没开邮箱验证：静默返回通用成功（不泄露差异）。
  //
  // 必须同时校验 email_verification 开关（与 login/register 的门禁判据一致）：开关关着时
  // emailVerifiedAt 为空的账号照样能登录，"重发验证邮件"没有任何业务意义，却会让任何匿名者
  // 报一个已知邮箱、就驱动本站往对方收件箱投一封品牌正确的验证信 —— 而 verify-email 消费令牌后
  // 是直接签发会话的，等于凭空造出一封「一键登录」邮件。没有验证门禁就不该有验证邮件。
  const verificationActive =
    !!siteSettings?.email_verification && (await isEmailEnabled(siteSettings ?? undefined));
  if (!email || !isValidEmailAddress(email) || !verificationActive) {
    return NextResponse.json(GENERIC_OK);
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, displayName: true, status: true, emailVerifiedAt: true },
    });

    // 仅对「存在 + 正常 + 未验证」发送；其余情况静默。
    //
    // 刻意不 await（同 forgot-password）：await 完整 SMTP 往返再返回，会让「账号存在且待验证」
    // 比其余分支慢 200ms~3s，通用响应文案挡不住这个时间差 —— 这里泄露的还不止账号存在性，
    // 连验证状态一并暴露。响应与发信结果无关，故把发信移出响应路径。
    if (user && user.status === 1 && user.emailVerifiedAt == null) {
      void sendVerificationEmail(user, {
        settings: siteSettings ?? undefined,
        requestIp: clientIp === 'unknown' ? null : clientIp,
      }).catch((err) =>
        logger.error(
          { err: serializeError(err) },
          '[resend-verification] 发送验证邮件失败'
        )
      );
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
