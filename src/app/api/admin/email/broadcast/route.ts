import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
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

/**
 * POST /api/admin/email/broadcast
 * body: { mode, category, subject, heading, bodyText, cta?, audience }
 *
 * mode:
 *   'preview'（缺省）— 只统计收件人数，不发任何信
 *   'test'          — 只发给当前管理员自己，用于确认排版
 *   'send'          — 真正群发（后台派发，立即返回）
 *
 * 群发不可撤回，故 mode 必须显式传 'send'：请求体畸形/字段缺失一律退化成 preview，
 * 绝不会"意外发出去"。
 */

const CATEGORIES: BroadcastCategory[] = ['product_updates', 'promotions'];
const AUDIENCES: BroadcastAudience[] = ['all', 'FREE', 'PRO', 'ADMIN'];

const MAX_SUBJECT = 200;
const MAX_HEADING = 200;
const MAX_BODY = 20_000;

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

  // 测试发送：只发给管理员本人，不查收件人、不过用户偏好（管理员可能自己关了促销）。
  if (mode === 'test') {
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
    logAction(req, 'admin.email.broadcast.test', {
      user: admin,
      detail: `测试发送 ${category} 至 ${admin.email}: ${result.ok ? '成功' : result.error}`,
    });
    return NextResponse.json(
      result.ok ? { ok: true, sentTo: admin.email } : { ok: false, error: result.error },
      { status: result.ok ? 200 : 400 }
    );
  }

  const { users, truncated } = await findBroadcastRecipients(audience, category, settings);

  // 预览：只报人数。marketing 总开关关着时这里会是 0——正好让管理员当场看出来。
  if (mode === 'preview') {
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
    return NextResponse.json(
      {
        error: settings.marketing_emails_enabled
          ? '没有符合条件的收件人'
          : '站点营销邮件总开关已关闭，不会发送给任何人',
      },
      { status: 400 }
    );
  }

  // 审计先落，再派发：派发是 fire-and-forget，失败也要留下"谁在什么时候发了什么"。
  logAction(req, 'admin.email.broadcast.send', {
    user: admin,
    detail: `群发 ${category} 给 ${audience}（${users.length} 人）: ${subject}`,
  });

  // 不 await：SMTP 往返 × N 人会把请求线程挂死（审计 #5 的原样重演）。
  void runBroadcast(users, content, settings).catch((err) =>
    logger.error({ err: serializeError(err) }, '[broadcast] 群发任务异常')
  );

  return NextResponse.json({
    ok: true,
    mode: 'send',
    dispatched: users.length,
    truncated,
  });
}
