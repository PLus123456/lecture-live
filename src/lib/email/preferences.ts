// src/lib/email/preferences.ts
// 邮件通知分类 + 用户订阅偏好 + 无状态退订令牌。
//
// 分类分两档：
//  - 事务类（transactional）：验证、重置、安全告警——恒发，用户不可关，不进偏好 UI。
//  - 通知类：订阅成功 / 到期提醒 / 额度提醒 / 产品更新 / 促销——用户可在个人设置勾选收不收；
//    其中标 marketing 的还受站点级 marketing_emails_enabled 总开关约束。
//
// 退订令牌：HMAC(userId) 无状态签名，放进每封通知类邮件的「退订」链接，用户无需登录即可一键退订。
// 密钥自 ENCRYPTION_KEY 派生（独立 info），与 JWT 轮换解耦。

import 'server-only';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { ENCRYPTION_KEY } from '@/lib/serverSecrets';

export type EmailCategory =
  | 'security_alert'
  | 'subscription'
  | 'expiry_reminder'
  | 'quota_alert'
  | 'product_updates'
  | 'promotions';

interface CategoryDef {
  key: EmailCategory;
  transactional: boolean; // 恒发、不可关、不进 UI
  marketing: boolean; // 受站点级营销总开关约束
  defaultOptIn: boolean; // 用户未显式设置时默认收不收
}

/** 分类定义表。顺序即个人设置页展示顺序。 */
export const EMAIL_CATEGORY_DEFS: readonly CategoryDef[] = [
  { key: 'security_alert', transactional: true, marketing: false, defaultOptIn: true },
  { key: 'subscription', transactional: false, marketing: false, defaultOptIn: true },
  { key: 'expiry_reminder', transactional: false, marketing: false, defaultOptIn: true },
  { key: 'quota_alert', transactional: false, marketing: false, defaultOptIn: true },
  { key: 'product_updates', transactional: false, marketing: true, defaultOptIn: true },
  { key: 'promotions', transactional: false, marketing: true, defaultOptIn: true },
];

const CATEGORY_BY_KEY = new Map<string, CategoryDef>(
  EMAIL_CATEGORY_DEFS.map((d) => [d.key, d])
);

/** 用户可在个人设置里控制的分类（排除事务类）。 */
export function getUserFacingCategories(): CategoryDef[] {
  return EMAIL_CATEGORY_DEFS.filter((d) => !d.transactional);
}

export function isKnownCategory(key: string): key is EmailCategory {
  return CATEGORY_BY_KEY.has(key);
}

/** 安全解析 User.emailPreferences（JSON 字符串）→ { category: boolean }，忽略未知键与坏数据。 */
export function parsePreferences(
  raw: string | null | undefined
): Partial<Record<EmailCategory, boolean>> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out: Partial<Record<EmailCategory, boolean>> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isKnownCategory(k) && typeof v === 'boolean') {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 仅保留合法通知类分类布尔值后序列化落库；空对象返回 null（列可空）。 */
export function serializePreferences(
  prefs: Partial<Record<EmailCategory, boolean>>
): string | null {
  const clean: Partial<Record<EmailCategory, boolean>> = {};
  for (const def of getUserFacingCategories()) {
    const v = prefs[def.key];
    if (typeof v === 'boolean') clean[def.key] = v;
  }
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
}

/**
 * 返回用户在各「可控分类」上的生效偏好（含默认回落），供个人设置页回显。
 * 不含事务类（那些恒发，无需展示开关）。
 */
export function getEffectivePreferences(
  raw: string | null | undefined
): Record<string, boolean> {
  const stored = parsePreferences(raw);
  const out: Record<string, boolean> = {};
  for (const def of getUserFacingCategories()) {
    out[def.key] = stored[def.key] ?? def.defaultOptIn;
  }
  return out;
}

/**
 * 判断某封分类邮件是否应发给该用户：
 *  - 事务类 → 恒 true。
 *  - marketing 类且站点级总开关关闭 → false。
 *  - 否则取用户显式偏好，缺省回落该分类 defaultOptIn。
 */
export function isCategoryEnabledForUser(
  category: EmailCategory,
  userPreferencesRaw: string | null | undefined,
  options: { marketingEnabled: boolean }
): boolean {
  const def = CATEGORY_BY_KEY.get(category);
  if (!def) return false;
  if (def.transactional) return true;
  if (def.marketing && !options.marketingEnabled) return false;
  const stored = parsePreferences(userPreferencesRaw);
  return stored[category] ?? def.defaultOptIn;
}

// ─────────────────────────── 退订令牌 ───────────────────────────

let unsubKeyCache: Buffer | null = null;
function getUnsubKey(): Buffer {
  if (!unsubKeyCache) {
    unsubKeyCache = Buffer.from(
      hkdfSync('sha256', ENCRYPTION_KEY, 'lecturelive-salt', 'lecturelive-email-unsub', 32)
    );
  }
  return unsubKeyCache;
}

function sign(userId: string): string {
  return createHmac('sha256', getUnsubKey())
    .update(`unsub:${userId}`)
    .digest('base64url');
}

/** 生成无状态退订令牌：base64url(userId).sig。放进通知邮件的退订链接。 */
export function makeUnsubscribeToken(userId: string): string {
  const idPart = Buffer.from(userId, 'utf8').toString('base64url');
  return `${idPart}.${sign(userId)}`;
}

/** 校验退订令牌，返回 userId 或 null。timing-safe，签名不符即拒。 */
export function verifyUnsubscribeToken(token: string): string | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const idPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  let userId: string;
  try {
    userId = Buffer.from(idPart, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!userId) return null;

  const expected = sign(userId);
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}
