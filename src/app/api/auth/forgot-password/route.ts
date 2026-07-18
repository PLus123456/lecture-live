import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logAction } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
import { getSiteSettings } from '@/lib/siteSettings';
import { normalizeEmail, isValidEmailAddress } from '@/lib/email/domains';
import { isEmailEnabled, sendPasswordResetEmail } from '@/lib/email';

/**
 * POST /api/auth/forgot-password  body: { email }
 * 发起密码重置。防枚举：无论账号是否存在一律返回相同的通用成功响应。双重限流（email + IP）。
 * 邮件系统未配置时静默返回成功（避免泄露"该站没开邮件"这类信息，也不打断流程）。
 */
const GENERIC_OK = {
  ok: true,
  message: '如果该邮箱对应一个账号，我们已发送密码重置邮件，请查收',
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

  // 限流：每邮箱 3 次 / 15 分钟；每 IP 10 次 / 15 分钟。
  const emailLimited = email
    ? await enforceRateLimit(req, {
        scope: 'auth:forgot-password',
        limit: 3,
        windowMs: 15 * 60_000,
        key: `email:${email}`,
      })
    : null;
  if (emailLimited) return emailLimited;

  const clientIp = resolveRequestClientIp(req);
  if (clientIp !== 'unknown') {
    const ipLimited = await enforceRateLimit(req, {
      scope: 'auth:forgot-password:ip',
      limit: 10,
      windowMs: 15 * 60_000,
      key: `ip:${clientIp}`,
    });
    if (ipLimited) return ipLimited;
  }

  if (!email || !isValidEmailAddress(email) || !(await isEmailEnabled(siteSettings ?? undefined))) {
    return NextResponse.json(GENERIC_OK);
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, displayName: true, status: true },
    });

    // 仅对正常账号发送重置邮件；被禁用账号静默（也不给重置入口）。
    //
    // 刻意不 await：SMTP 往返要 200ms~3s，而账号不存在时是立即返回 —— 这个时间差本身就是
    // 账号枚举信道，通用响应文案挡不住它。响应内容与发信结果无关（永远 GENERIC_OK），
    // 把发信移出响应路径即可抹平。login() 用的是反向手法（给不存在的分支补一次 dummy bcrypt
    // 拉平耗时），这里不照搬：SMTP 延迟不可预测，且不该为不存在的账号真去连一次 SMTP。
    if (user && user.status === 1) {
      void sendPasswordResetEmail(user, {
        settings: siteSettings ?? undefined,
        requestIp: clientIp === 'unknown' ? null : clientIp,
      }).catch((err) =>
        logger.error(
          { err: serializeError(err) },
          '[forgot-password] 发送重置邮件失败'
        )
      );
      // 审计的是「发起了重置请求」，与投递成败无关，故不再挂在 await 之后。
      logAction(req, 'user.password.reset_requested', {
        user: { id: user.id, email: user.email, role: 'FREE' },
        userName: user.displayName,
      });
    }
  } catch (err) {
    logger.error({ err: serializeError(err) }, '[forgot-password] 处理失败');
  }

  return NextResponse.json(GENERIC_OK);
}
