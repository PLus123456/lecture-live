import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import {
  getEffectivePreferences,
  getUserFacingCategories,
  isKnownCategory,
  parsePreferences,
  serializePreferences,
  type EmailCategory,
} from '@/lib/email/preferences';
import { getSiteSettings } from '@/lib/siteSettings';

/** 返回用户可控的通知分类元信息（键 + 是否营销类），标签由前端 i18n 提供。 */
function categoryMeta() {
  return getUserFacingCategories().map((d) => ({ key: d.key, marketing: d.marketing }));
}

/** GET /api/user/email-preferences — 回显当前生效偏好 + 分类元信息 + 营销总开关状态。 */
export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [user, settings] = await Promise.all([
    prisma.user.findUnique({
      where: { id: payload.id },
      select: { emailPreferences: true },
    }),
    getSiteSettings().catch(() => null),
  ]);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json({
    preferences: getEffectivePreferences(user.emailPreferences),
    categories: categoryMeta(),
    marketingEnabled: settings?.marketing_emails_enabled ?? true,
  });
}

/** PUT /api/user/email-preferences  body: { preferences: { [category]: boolean } } — 合并保存。 */
export async function PUT(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await enforceApiRateLimit(req, {
    scope: 'user:email-preferences:update',
    windowMs: 10 * 60_000,
    key: `user:${payload.id}`,
  });
  if (limited) return limited;

  let body: { preferences?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const incoming = body.preferences;
  if (!incoming || typeof incoming !== 'object') {
    return NextResponse.json({ error: '缺少 preferences' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { emailPreferences: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // 合并：以现有偏好为底，仅覆盖传入的、合法的、可控分类的布尔值（忽略事务类与未知键）。
  const merged = parsePreferences(user.emailPreferences);
  for (const [key, value] of Object.entries(incoming)) {
    if (isKnownCategory(key) && key !== 'security_alert' && typeof value === 'boolean') {
      merged[key as EmailCategory] = value;
    }
  }

  await prisma.user.update({
    where: { id: payload.id },
    data: { emailPreferences: serializePreferences(merged) },
  });

  return NextResponse.json({
    preferences: getEffectivePreferences(serializePreferences(merged)),
    categories: categoryMeta(),
  });
}
