import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { writeAuditLog } from '@/lib/auditLog';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logger, serializeError } from '@/lib/logger';
import {
  verifyUnsubscribeToken,
  parsePreferences,
  serializePreferences,
  getUserFacingCategories,
  isKnownCategory,
  type EmailCategory,
} from '@/lib/email/preferences';

/**
 * /api/auth/unsubscribe?token=..&category=..
 *  - GET：渲染一个自包含确认页（带 POST 按钮）。用 GET 直接退订会被邮件安全扫描器的预取误触发，
 *    故 GET 只展示、不改动；真正退订走 POST（也兼容 RFC 8058 List-Unsubscribe-Post 一键退订）。
 *  - POST：将该分类偏好置 false（category=all 则关闭全部通知类）。无需登录，凭 HMAC 退订令牌鉴权。
 */

const CATEGORY_LABELS: Record<EmailCategory, string> = {
  security_alert: '安全提醒',
  subscription: '订阅/购买通知',
  expiry_reminder: '会员到期提醒',
  quota_alert: '配额提醒',
  product_updates: '产品更新',
  promotions: '促销活动',
};

function htmlPage(title: string, message: string, options?: { form?: { token: string; category: string; buttonLabel: string } }): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const formHtml = options?.form
    ? `<form method="POST" style="margin-top:20px;">
         <input type="hidden" name="token" value="${esc(options.form.token)}">
         <input type="hidden" name="category" value="${esc(options.form.category)}">
         <button type="submit" style="background:#C0552F;color:#fff;border:none;border-radius:8px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer;">${esc(options.form.buttonLabel)}</button>
       </form>`
    : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#FAF7F2;color:#2B2B2B;">
  <div style="max-width:440px;margin:64px auto;padding:32px;background:#fff;border:1px solid #E7DFD5;border-radius:12px;text-align:center;">
    <h1 style="font-size:20px;margin:0 0 12px;">${esc(title)}</h1>
    <p style="font-size:15px;line-height:1.6;color:#4b4b4b;margin:0;">${esc(message)}</p>
    ${formHtml}
  </div>
</body></html>`;
}

function resolveCategories(categoryParam: string): EmailCategory[] | null {
  if (categoryParam === 'all') {
    return getUserFacingCategories().map((d) => d.key);
  }
  if (isKnownCategory(categoryParam) && categoryParam !== 'security_alert') {
    return [categoryParam];
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  const categoryParam = url.searchParams.get('category') ?? '';

  const userId = verifyUnsubscribeToken(token);
  const categories = resolveCategories(categoryParam);
  if (!userId || !categories) {
    return new NextResponse(htmlPage('链接无效', '该退订链接无效或已损坏。'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const label = categoryParam === 'all' ? '全部通知邮件' : CATEGORY_LABELS[categories[0]];
  return new NextResponse(
    htmlPage('确认退订', `点击下方按钮，停止接收「${label}」。`, {
      form: { token, category: categoryParam, buttonLabel: '确认退订' },
    }),
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function POST(req: Request) {
  // 兼容表单提交（application/x-www-form-urlencoded）与一键退订（RFC 8058）。
  let token = '';
  let categoryParam = '';
  const url = new URL(req.url);
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as { token?: string; category?: string };
      token = body.token ?? '';
      categoryParam = body.category ?? '';
    } else if (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    ) {
      const form = await req.formData();
      token = String(form.get('token') ?? '');
      categoryParam = String(form.get('category') ?? '');
    }
  } catch {
    // 忽略解析错误，下面回落 query 参数
  }
  // 回落到 query（List-Unsubscribe 一键退订常把参数放 URL）
  token = token || url.searchParams.get('token') || '';
  categoryParam = categoryParam || url.searchParams.get('category') || '';

  const userId = verifyUnsubscribeToken(token);
  const categories = resolveCategories(categoryParam);
  if (!userId || !categories) {
    return new NextResponse(htmlPage('链接无效', '该退订链接无效或已损坏。'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailPreferences: true },
    });
    if (user) {
      const prefs = parsePreferences(user.emailPreferences);
      for (const cat of categories) prefs[cat] = false;
      await prisma.user.update({
        where: { id: user.id },
        data: { emailPreferences: serializePreferences(prefs) },
      });
      const ip = resolveRequestClientIp(req);
      writeAuditLog({
        action: 'user.email.unsubscribe',
        userId: user.id,
        userName: user.email,
        detail: `退订: ${categoryParam}`,
        ip: ip === 'unknown' ? null : ip,
      });
    }
  } catch (err) {
    logger.error({ err: serializeError(err) }, '[unsubscribe] 处理失败');
    return new NextResponse(htmlPage('退订失败', '处理时出错，请稍后重试。'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const label = categoryParam === 'all' ? '全部通知邮件' : CATEGORY_LABELS[categories[0]];
  return new NextResponse(
    htmlPage('已退订', `你将不再收到「${label}」。可随时在个人设置中重新开启。`),
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
