// src/lib/email/index.ts
// 邮件系统高层入口：把「配置解析 + 令牌 + 模板 + 偏好 + 发送」串成语义化的发信函数。
// 事务类（验证/重置/安全告警）恒发；通知类经 isCategoryEnabledForUser 过滤 + 带退订链接。
// 所有函数不抛错，返回 SendResult（多为 fire-and-forget，失败只记日志不阻塞主流程）。

import 'server-only';
import type { SiteSettings } from '@/lib/siteSettings';
import { getSiteSettings } from '@/lib/siteSettings';
import { createEmailToken } from './tokens';
import * as templates from './templates';
import {
  isCategoryEnabledForUser,
  makeUnsubscribeToken,
  type EmailCategory,
} from './preferences';
import { sendMail, type SendResult } from './mailer';

export { isEmailEnabled, isCaptureMode, verifyEmailConnection, getLastCapturedEmail, sendMail, invalidateMailer } from './mailer';

/** 发信涉及的最小用户形状。 */
export interface EmailUser {
  id: string;
  email: string;
  displayName: string;
  emailPreferences?: string | null;
}

interface BrandCtx {
  siteName: string;
  siteUrl: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function getBrandCtx(settings: SiteSettings): BrandCtx {
  return {
    siteName: settings.site_name || 'LectureLive',
    siteUrl: trimTrailingSlash(settings.site_url || 'http://localhost:3000'),
  };
}

function buildVerifyUrl(siteUrl: string, rawToken: string): string {
  return `${trimTrailingSlash(siteUrl)}/verify-email?token=${encodeURIComponent(rawToken)}`;
}
function buildResetUrl(siteUrl: string, rawToken: string): string {
  return `${trimTrailingSlash(siteUrl)}/reset-password?token=${encodeURIComponent(rawToken)}`;
}
function buildUnsubscribeUrl(siteUrl: string, userId: string, category: EmailCategory): string {
  // 退订范围签进令牌本身，不再另挂裸 category 参数——否则收件人改一个词就能把
  // 「退订促销」变成「关掉全部通知」（含到期/配额这类跟钱相关的提醒）。
  const token = makeUnsubscribeToken(userId, category);
  return `${trimTrailingSlash(siteUrl)}/api/auth/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** RFC 8058 一键退订邮件头：邮件客户端可直接 POST 退订链接完成退订，利于送达率与合规。 */
function listUnsubHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

async function resolveSettings(settings?: SiteSettings): Promise<SiteSettings | null> {
  if (settings) return settings;
  return getSiteSettings().catch(() => null);
}

// ─────────────────────────── 事务类（恒发） ───────────────────────────

/** 发送邮箱验证邮件：签发验证令牌 + 发信。返回 { result, rawToken }（rawToken 供测试/日志，勿外泄）。 */
export async function sendVerificationEmail(
  user: EmailUser,
  options?: { settings?: SiteSettings; requestIp?: string | null }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  const ctx = getBrandCtx(settings);
  const { rawToken } = await createEmailToken({
    userId: user.id,
    type: 'VERIFY_EMAIL',
    requestIp: options?.requestIp,
  });
  const mail = templates.verificationEmail(ctx, {
    displayName: user.displayName,
    verifyUrl: buildVerifyUrl(ctx.siteUrl, rawToken),
  });
  return sendMail({ to: user.email, ...mail });
}

/** 发送密码重置邮件：签发重置令牌 + 发信。 */
export async function sendPasswordResetEmail(
  user: EmailUser,
  options?: { settings?: SiteSettings; requestIp?: string | null }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  const ctx = getBrandCtx(settings);
  const { rawToken } = await createEmailToken({
    userId: user.id,
    type: 'RESET_PASSWORD',
    requestIp: options?.requestIp,
  });
  const mail = templates.passwordResetEmail(ctx, {
    displayName: user.displayName,
    resetUrl: buildResetUrl(ctx.siteUrl, rawToken),
  });
  return sendMail({ to: user.email, ...mail });
}

/** 验证成功后的欢迎邮件（事务类，恒发）。 */
export async function sendWelcomeEmail(
  user: EmailUser,
  options?: { settings?: SiteSettings }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  const ctx = getBrandCtx(settings);
  const mail = templates.welcomeEmail(ctx, { displayName: user.displayName });
  return sendMail({ to: user.email, ...mail });
}

/** 安全告警：改密成功 / 新设备登录（事务类，恒发）。 */
export async function sendSecurityAlertEmail(
  user: EmailUser,
  params: {
    kind: 'password_changed' | 'new_device_login';
    ip?: string | null;
    when?: string | null;
    userAgent?: string | null;
  },
  options?: { settings?: SiteSettings }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  const ctx = getBrandCtx(settings);
  const mail = templates.securityAlertEmail(ctx, {
    displayName: user.displayName,
    ...params,
  });
  return sendMail({ to: user.email, ...mail });
}

// ─────────────────────────── 通知类（受偏好/总开关约束，带退订） ───────────────────────────

/** 通知类邮件是否应发给该用户（分类开关 + 站点营销总开关）。 */
function shouldSendCategory(
  user: EmailUser,
  category: EmailCategory,
  settings: SiteSettings
): boolean {
  return isCategoryEnabledForUser(category, user.emailPreferences, {
    marketingEnabled: settings.marketing_emails_enabled,
  });
}

/** 订阅/购买成功通知。 */
export async function sendSubscriptionSuccessEmail(
  user: EmailUser,
  params: { planName: string; amountLabel?: string | null; expiresLabel?: string | null },
  options?: { settings?: SiteSettings }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  if (!shouldSendCategory(user, 'subscription', settings)) {
    return { ok: true, error: 'skipped:preference' };
  }
  const ctx = getBrandCtx(settings);
  const unsubscribeUrl = buildUnsubscribeUrl(ctx.siteUrl, user.id, 'subscription');
  const mail = templates.subscriptionSuccessEmail(ctx, {
    displayName: user.displayName,
    ...params,
    unsubscribeUrl,
  });
  return sendMail({ to: user.email, ...mail, headers: listUnsubHeaders(unsubscribeUrl) });
}

/** 会员到期提醒。 */
export async function sendExpiryReminderEmail(
  user: EmailUser,
  params: { planName: string; expiresLabel: string; daysLeft: number },
  options?: { settings?: SiteSettings }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  if (!shouldSendCategory(user, 'expiry_reminder', settings)) {
    return { ok: true, error: 'skipped:preference' };
  }
  const ctx = getBrandCtx(settings);
  const unsubscribeUrl = buildUnsubscribeUrl(ctx.siteUrl, user.id, 'expiry_reminder');
  const mail = templates.expiryReminderEmail(ctx, {
    displayName: user.displayName,
    ...params,
    unsubscribeUrl,
  });
  return sendMail({ to: user.email, ...mail, headers: listUnsubHeaders(unsubscribeUrl) });
}

/** 配额即将用尽提醒。 */
export async function sendQuotaAlertEmail(
  user: EmailUser,
  params: { quotaLabel: string; usedLabel: string; percentLabel: string },
  options?: { settings?: SiteSettings }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  if (!shouldSendCategory(user, 'quota_alert', settings)) {
    return { ok: true, error: 'skipped:preference' };
  }
  const ctx = getBrandCtx(settings);
  const unsubscribeUrl = buildUnsubscribeUrl(ctx.siteUrl, user.id, 'quota_alert');
  const mail = templates.quotaAlertEmail(ctx, {
    displayName: user.displayName,
    ...params,
    unsubscribeUrl,
  });
  return sendMail({ to: user.email, ...mail, headers: listUnsubHeaders(unsubscribeUrl) });
}

/** 文档翻译完成/失败通知。 */
export async function sendDocTranslateEmail(
  user: EmailUser,
  params: {
    fileName: string;
    outcome: 'completed' | 'failed';
    errorMessage?: string | null;
    refunded?: boolean;
  },
  options?: { settings?: SiteSettings }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  if (!shouldSendCategory(user, 'doc_translate', settings)) {
    return { ok: true, error: 'skipped:preference' };
  }
  const ctx = getBrandCtx(settings);
  const unsubscribeUrl = buildUnsubscribeUrl(ctx.siteUrl, user.id, 'doc_translate');
  const mail = templates.docTranslateEmail(ctx, {
    displayName: user.displayName,
    ...params,
    unsubscribeUrl,
  });
  return sendMail({ to: user.email, ...mail, headers: listUnsubHeaders(unsubscribeUrl) });
}

/** 通用通知/公告/促销（管理员自定义），按 category 走偏好过滤。 */
export async function sendGenericNotificationEmail(
  user: EmailUser,
  params: {
    category: Extract<EmailCategory, 'product_updates' | 'promotions'>;
    subject: string;
    heading: string;
    bodyText: string;
    cta?: { url: string; label: string };
  },
  options?: { settings?: SiteSettings }
): Promise<SendResult> {
  const settings = await resolveSettings(options?.settings);
  if (!settings) return { ok: false, error: 'settings unavailable' };
  if (!shouldSendCategory(user, params.category, settings)) {
    return { ok: true, error: 'skipped:preference' };
  }
  const ctx = getBrandCtx(settings);
  const unsubscribeUrl = buildUnsubscribeUrl(ctx.siteUrl, user.id, params.category);
  const mail = templates.genericNotificationEmail(ctx, {
    subject: params.subject,
    heading: params.heading,
    bodyText: params.bodyText,
    cta: params.cta,
    unsubscribeUrl,
  });
  return sendMail({ to: user.email, ...mail, headers: listUnsubHeaders(unsubscribeUrl) });
}
