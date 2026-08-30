import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { getSiteSettings, SETTING_SECRET_MASK } from '@/lib/siteSettings';
import type { EmailConfig } from '@/lib/email/mailer';
import { verifyEmailConnection, sendMailWithConfig } from '@/lib/email/mailer';
import { getBrandCtx } from '@/lib/email';
import { testEmail } from '@/lib/email/templates';
import { isValidEmailAddress, normalizeEmail } from '@/lib/email/domains';
import { JOB_STATUS, JOB_TYPE, trackJob } from '@/lib/jobQueue';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';

class EmailTestRejectedError extends Error {
  constructor(
    readonly clientError: string | undefined,
    readonly status = 400
  ) {
    // This message is persisted in JobQueue.error. Keep SMTP endpoints, users and credentials out.
    super('email test operation rejected');
    this.name = 'EmailTestRejectedError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

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
  const requestId = getSecurityAuditRequestId(req);
  const overrideFields = Object.keys(override)
    .filter((field) => field !== 'password')
    .sort();
  const passwordProvided = override.password !== undefined;

  // 仅测试连接
  if (!sendTo) {
    try {
      const result = await trackJob(
        {
          type: JOB_TYPE.ADMIN_INTEGRATION,
          userId: admin.id,
          triggeredBy: `admin:${admin.id}`,
          params: {
            operation: 'smtp_connection_test',
            overrideFields,
            passwordProvided,
            requestId,
          },
          resultSummary: () => ({ connected: true }),
          errorSummary: () => 'SmtpConnectionTestError',
          terminalMutation: async (tx, terminal) => {
            const connected = terminal.status === JOB_STATUS.SUCCESS;
            await writeSecurityAudit(
              req,
              {
                event: 'email.smtp_test',
                operator: { id: admin.id, email: admin.email, role: admin.role },
                target: { type: 'smtp_connection', id: 'configured_or_override' },
                before: { overrideFields, passwordProvided },
                after: { connected },
                reason: 'admin_connection_test',
                outcome: connected ? 'SUCCESS' : 'FAILED',
                metadata: connected
                  ? undefined
                  : {
                      errorClass:
                        terminal.status === JOB_STATUS.FAILED &&
                        terminal.error instanceof Error
                          ? terminal.error.name
                          : 'UnknownError',
                    },
                requestId,
              },
              tx
            );
          },
        },
        async () => {
          try {
            const verified = await verifyEmailConnection(override);
            if (!verified.ok) {
              throw new EmailTestRejectedError(verified.error);
            }
            return verified;
          } catch (error) {
            if (error instanceof EmailTestRejectedError) throw error;
            throw new EmailTestRejectedError(undefined, 500);
          }
        }
      );
      return NextResponse.json(result);
    } catch (error) {
      return NextResponse.json(
        {
          ok: false,
          error:
            error instanceof EmailTestRejectedError
              ? error.clientError ?? '连接测试失败'
              : '连接测试失败',
        },
        {
          status:
            error instanceof EmailTestRejectedError ? error.status : 500,
        }
      );
    }
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
  const recipientHash = sha256(to);
  try {
    await trackJob(
      {
        type: JOB_TYPE.ADMIN_INTEGRATION,
        userId: admin.id,
        triggeredBy: `admin:${admin.id}`,
        params: {
          operation: 'smtp_test_delivery',
          overrideFields,
          passwordProvided,
          recipientHash,
          requestId,
        },
        resultSummary: () => ({ delivered: true, recipientHash }),
        errorSummary: () => 'SmtpTestDeliveryError',
        terminalMutation: async (tx, terminal) => {
          const delivered = terminal.status === JOB_STATUS.SUCCESS;
          await writeSecurityAudit(
            req,
            {
              event: 'email.test_delivery',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: { type: 'email_recipient_hash', id: recipientHash },
              before: { overrideFields, passwordProvided },
              after: { delivered },
              reason: 'admin_test_delivery',
              outcome: delivered ? 'SUCCESS' : 'FAILED',
              metadata: delivered
                ? undefined
                : {
                    errorClass:
                      terminal.status === JOB_STATUS.FAILED &&
                      terminal.error instanceof Error
                        ? terminal.error.name
                        : 'UnknownError',
                  },
              requestId,
            },
            tx
          );
        },
      },
      async () => {
        try {
          const result = await sendMailWithConfig(override, { to, ...mail });
          if (!result.ok) throw new EmailTestRejectedError(result.error);
          return result;
        } catch (error) {
          if (error instanceof EmailTestRejectedError) throw error;
          throw new EmailTestRejectedError(undefined, 500);
        }
      }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof EmailTestRejectedError
            ? error.clientError ?? '测试邮件发送失败'
            : '测试邮件发送失败',
      },
      {
        status: error instanceof EmailTestRejectedError ? error.status : 500,
      }
    );
  }
  return NextResponse.json({ ok: true, sent: true });
}
