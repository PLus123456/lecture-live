import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  findBroadcastRecipients,
  runBroadcast,
  BROADCAST_MAX_RECIPIENTS,
  type BroadcastAudience,
  type BroadcastCategory,
  type BroadcastContent,
} from '@/lib/email/broadcast';
import { sendGenericNotificationEmail } from '@/lib/email';
import { JOB_STATUS, JOB_TYPE, trackJob } from '@/lib/jobQueue';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';

/**
 * POST /api/admin/email/broadcast
 * body: { mode, category, subject, heading, bodyText, cta?, audience }
 *
 * mode:
 *   'preview'（缺省）— 只统计收件人数，不发任何信
 *   'test'          — 只发给当前管理员自己，用于确认排版
 *   'send'          — 真正群发；请求内等待有界派发并可靠提交 journal 终态
 *
 * 群发不可撤回，故 mode 必须显式传 'send'：请求体畸形/字段缺失一律退化成 preview，
 * 绝不会"意外发出去"。
 */

const CATEGORIES: BroadcastCategory[] = ['product_updates', 'promotions'];
const AUDIENCES: BroadcastAudience[] = ['all', 'FREE', 'PRO', 'ADMIN'];

const MAX_SUBJECT = 200;
const MAX_HEADING = 200;
const MAX_BODY = 20_000;

class EmailOperationRejectedError extends Error {
  constructor(readonly status = 400) {
    super('email operation rejected');
    this.name = 'EmailOperationRejectedError';
  }
}

function contentAuditSummary(content: BroadcastContent) {
  const canonical = JSON.stringify({
    category: content.category,
    subject: content.subject,
    heading: content.heading,
    bodyText: content.bodyText,
    cta: content.cta ?? null,
  });
  return {
    contentHash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    subjectLength: content.subject.length,
    headingLength: content.heading.length,
    bodyLength: content.bodyText.length,
    hasCta: Boolean(content.cta),
  };
}

function operatorFromAdmin(admin: {
  id: string;
  email?: string | null;
  role?: string | null;
}) {
  return {
    id: admin.id,
    email: admin.email ?? null,
    role: admin.role ?? null,
  };
}

function auditFailureResponse() {
  return NextResponse.json({ error: '安全审计服务不可用' }, { status: 500 });
}

export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:email:broadcast',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response) return response;
  // requireAdminAccess 的返回类型里 user 可为 null；本路由要用 admin.id/email 发测试信，显式收窄。
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const mode = body.mode === 'send' || body.mode === 'test' ? body.mode : 'preview';

  const category = body.category as BroadcastCategory;
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `分类必须是 ${CATEGORIES.join(' / ')} 之一` },
      { status: 400 }
    );
  }

  const audience = (body.audience ?? 'all') as BroadcastAudience;
  if (!AUDIENCES.includes(audience)) {
    return NextResponse.json(
      { error: `收件范围必须是 ${AUDIENCES.join(' / ')} 之一` },
      { status: 400 }
    );
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const subject = str(body.subject);
  const heading = str(body.heading);
  const bodyText = str(body.bodyText);

  if (!subject || !heading || !bodyText) {
    return NextResponse.json(
      { error: '标题、正文标题与正文内容均不能为空' },
      { status: 400 }
    );
  }
  if (
    subject.length > MAX_SUBJECT ||
    heading.length > MAX_HEADING ||
    bodyText.length > MAX_BODY
  ) {
    return NextResponse.json({ error: '内容超出长度上限' }, { status: 400 });
  }

  // CTA 两个字段必须成对出现，且必须是 http(s) 绝对地址（邮件里的相对链接无意义）。
  let cta: { url: string; label: string } | undefined;
  const ctaRaw = body.cta as { url?: unknown; label?: unknown } | undefined;
  if (ctaRaw && (str(ctaRaw.url) || str(ctaRaw.label))) {
    const url = str(ctaRaw.url);
    const label = str(ctaRaw.label);
    if (!url || !label) {
      return NextResponse.json(
        { error: '按钮链接与按钮文字必须同时填写' },
        { status: 400 }
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json(
        { error: '按钮链接必须以 http:// 或 https:// 开头' },
        { status: 400 }
      );
    }
    cta = { url, label };
  }

  const settings = await getSiteSettings({ fresh: true }).catch(() => null);
  if (!settings) {
    return NextResponse.json({ error: '站点设置不可用' }, { status: 500 });
  }

  const content: BroadcastContent = { category, subject, heading, bodyText, cta };
  const requestId = getSecurityAuditRequestId(req);
  const contentSummary = contentAuditSummary(content);

  // 测试发送：只发给管理员本人，不查收件人、不过用户偏好（管理员可能自己关了促销）。
  if (mode === 'test') {
    try {
      await trackJob(
        {
          type: JOB_TYPE.ADMIN_INTEGRATION,
          userId: admin.id,
          triggeredBy: `admin:${admin.id}`,
          params: {
            operation: 'email_broadcast_test',
            category,
            contentHash: contentSummary.contentHash,
            requestId,
          },
          resultSummary: () => ({ delivered: true }),
          errorSummary: () => 'EmailBroadcastTestError',
          terminalMutation: async (tx, terminal) => {
            const succeeded = terminal.status === JOB_STATUS.SUCCESS;
            await writeSecurityAudit(
              req,
              {
                event: 'email.broadcast_test',
                operator: operatorFromAdmin(admin),
                target: { type: 'email_broadcast_test', ownerId: admin.id },
                before: { category, content: contentSummary },
                after: { delivered: succeeded },
                reason: 'admin_test_delivery',
                outcome: succeeded ? 'SUCCESS' : 'FAILED',
                metadata: succeeded
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
            const result = await sendGenericNotificationEmail(
              {
                id: admin.id,
                email: admin.email,
                displayName: admin.email,
                // 测试信要绕过偏好过滤，否则管理员自己退订过就永远收不到预览
                emailPreferences: null,
              },
              content,
              { settings }
            );
            if (!result.ok) throw new EmailOperationRejectedError();
            return { delivered: true };
          } catch (error) {
            if (error instanceof EmailOperationRejectedError) throw error;
            // JobQueue.error 也是管理员可读数据，不能把 SMTP/URL/凭据错误原文写进去。
            throw new EmailOperationRejectedError(500);
          }
        }
      );
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: '测试邮件发送失败' },
        {
          status:
            error instanceof EmailOperationRejectedError ? error.status : 500,
        }
      );
    }
    return NextResponse.json({ ok: true, sentTo: admin.email });
  }

  let recipients: Awaited<ReturnType<typeof findBroadcastRecipients>>;
  try {
    recipients = await findBroadcastRecipients(audience, category, settings);
  } catch (error) {
    console.error('查询邮件群发收件人失败:', error);
    return NextResponse.json({ error: '查询收件人失败' }, { status: 500 });
  }
  const { users, truncated } = recipients;

  // 预览：只报人数。marketing 总开关关着时这里会是 0——正好让管理员当场看出来。
  if (mode === 'preview') {
    try {
      await writeSecurityAudit(req, {
        event: 'email.broadcast_preview',
        operator: operatorFromAdmin(admin),
        target: { type: 'email_broadcast_audience', id: audience },
        before: { category, audience, content: contentSummary },
        after: {
          recipientCount: users.length,
          truncated,
          marketingEnabled: settings.marketing_emails_enabled,
        },
        reason: 'admin_preview',
        outcome: 'SUCCESS',
        requestId,
      });
    } catch {
      return auditFailureResponse();
    }
    return NextResponse.json({
      ok: true,
      mode: 'preview',
      recipientCount: users.length,
      truncated,
      maxRecipients: BROADCAST_MAX_RECIPIENTS,
      marketingEnabled: settings.marketing_emails_enabled,
    });
  }

  if (users.length === 0) {
    try {
      await writeSecurityAudit(req, {
        event: 'email.broadcast',
        operator: operatorFromAdmin(admin),
        target: { type: 'email_broadcast_audience', id: audience },
        before: { category, audience, content: contentSummary },
        after: { recipientCount: 0 },
        reason: 'no_eligible_recipients',
        outcome: 'DENIED',
        requestId,
      });
    } catch {
      return auditFailureResponse();
    }
    return NextResponse.json(
      {
        error: settings.marketing_emails_enabled
          ? '没有符合条件的收件人'
          : '站点营销邮件总开关已关闭，不会发送给任何人',
      },
      { status: 400 }
    );
  }

  let result: Awaited<ReturnType<typeof runBroadcast>>;
  try {
    result = await trackJob(
      {
        type: JOB_TYPE.ADMIN_INTEGRATION,
        userId: admin.id,
        triggeredBy: `admin:${admin.id}`,
        params: {
          operation: 'email_broadcast',
          category,
          audience,
          recipientCount: users.length,
          contentHash: contentSummary.contentHash,
          requestId,
        },
        resultSummary: (value) => ({ ...value, recipientCount: users.length }),
        errorSummary: () => 'EmailBroadcastError',
        terminalMutation: async (tx, terminal) => {
          if (terminal.status === JOB_STATUS.SUCCESS) {
            const completed = terminal.result;
            const partial =
              completed.failed > 0 ||
              completed.budgetExhausted ||
              truncated;
            await writeSecurityAudit(
              req,
              {
                event: 'email.broadcast',
                operator: operatorFromAdmin(admin),
                target: { type: 'email_broadcast_audience', id: audience },
                before: { category, audience, content: contentSummary },
                after: {
                  recipientCount: users.length,
                  sent: completed.sent,
                  skipped: completed.skipped,
                  failed: completed.failed,
                  budgetExhausted: completed.budgetExhausted,
                  truncated,
                },
                reason: 'admin_broadcast',
                outcome: partial ? 'PARTIAL' : 'SUCCESS',
                requestId,
              },
              tx
            );
            return;
          }
          await writeSecurityAudit(
            req,
            {
              event: 'email.broadcast',
              operator: operatorFromAdmin(admin),
              target: { type: 'email_broadcast_audience', id: audience },
              before: { category, audience, content: contentSummary },
              after: { recipientCount: users.length, completed: false },
              reason: 'admin_broadcast',
              outcome: 'FAILED',
              metadata: {
                errorClass:
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
          return await runBroadcast(users, content, settings);
        } catch {
          throw new EmailOperationRejectedError(500);
        }
      }
    );
  } catch (error) {
    console.error('邮件群发任务失败:', error);
    return NextResponse.json({ error: '群发任务失败' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    mode: 'send',
    dispatched: users.length,
    truncated,
    ...result,
  });
}
