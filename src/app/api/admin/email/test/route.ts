import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings, SETTING_SECRET_MASK } from '@/lib/siteSettings';
import type { EmailConfig } from '@/lib/email/mailer';
import { verifyEmailConnection, sendMailWithConfig } from '@/lib/email/mailer';
import { getBrandCtx } from '@/lib/email';
import { testEmail } from '@/lib/email/templates';
import { isValidEmailAddress, normalizeEmail } from '@/lib/email/domains';

/**
 * POST /api/admin/email/test
 * body（均可选，缺省回落已保存配置）：
 *   { smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure, sender_name, sender_email, sendTo }
 * 无 sendTo → 仅做连通性校验（transporter.verify）；有 sendTo → 校验并发送一封测试邮件。
 * 密码为空或脱敏占位（********）时回落已保存值，与设置 PUT 的「掩码=保持原值」一致。
 */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:email:test',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // 全部回落已保存配置
  }

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  // 组装临时覆盖：只填写了的字段才覆盖已保存值。
  const override: Partial<EmailConfig> = {};
  const host = str(body.smtp_host);
  if (host) override.host = host;
  const portRaw = body.smtp_port;
  if (portRaw !== undefined && portRaw !== '') {
    const port = Number.parseInt(String(portRaw), 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) override.port = port;
  }
  const userName = str(body.smtp_user);
  if (userName) override.user = userName;
  const pwd = str(body.smtp_password);
  if (pwd && pwd !== SETTING_SECRET_MASK) override.password = pwd;
  if (typeof body.smtp_secure === 'boolean') override.secure = body.smtp_secure;
  else if (str(body.smtp_secure)) override.secure = String(body.smtp_secure) === 'true';
  const senderName = str(body.sender_name);
  if (senderName) override.fromName = senderName;
  const senderEmail = str(body.sender_email);
  if (senderEmail) override.fromEmail = senderEmail;

  const sendTo = str(body.sendTo);

  // 仅测试连接
  if (!sendTo) {
    const result = await verifyEmailConnection(override);
    logAction(req, 'admin.email.test', {
      user: admin,
      detail: result.ok ? '连接成功' : `连接失败: ${result.error ?? ''}`,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  // 发送测试邮件
  const to = normalizeEmail(sendTo);
  if (!isValidEmailAddress(to)) {
    return NextResponse.json({ ok: false, error: '收件邮箱格式不正确' }, { status: 400 });
  }
  const settings = await getSiteSettings({ fresh: true }).catch(() => null);
  const ctx = settings
    ? getBrandCtx(settings)
    : { siteName: 'LectureLive', siteUrl: 'http://localhost:3000' };
  const mail = testEmail(ctx);
  const result = await sendMailWithConfig(override, { to, ...mail });
  logAction(req, 'admin.email.test.send', {
    user: admin,
    detail: result.ok ? `已发送至 ${to}` : `发送失败: ${result.error ?? ''}`,
  });
  return NextResponse.json(
    result.ok ? { ok: true, sent: true } : { ok: false, error: result.error },
    { status: result.ok ? 200 : 400 }
  );
}
