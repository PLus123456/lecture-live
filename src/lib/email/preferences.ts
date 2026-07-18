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
import { ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS } from '@/lib/serverSecrets';

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

/**
 * 令牌载荷 = userId + 退订范围 + 过期时刻，**三者全部进 HMAC**。
 *
 * 范围必须签进去：早先版本只签 userId、把 category 留作裸 URL 参数，于是一封 promotions
 * 退订链接一旦外泄（转发、共享收件箱、邮件归档），把参数改成 `category=all` 就能替人关掉
 * 全部通知——包括到期提醒和配额提醒这两个跟钱直接相关的。
 *
 * 过期时刻同理：无期限的退订链接一旦泄露就是永久有效。取 180 天——远超合规要求的
 * 「发信后 30 天内可退订」，又把泄露窗口收在有限范围内。
 *
 * 仍然做不到的：主动吊销（无状态签名的固有代价）。真要吊销得落库，与「一键退订必须
 * 零依赖可用」相冲突，故明确不做。
 */
const UNSUB_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** 退订范围：单个可控分类，或 'all'（关闭全部通知类）。 */
export type UnsubscribeScope = EmailCategory | 'all';

export type UnsubscribePayload = { userId: string; scope: UnsubscribeScope };

const unsubKeyCache = new Map<string, Buffer>();
function deriveUnsubKey(secret: string): Buffer {
  let key = unsubKeyCache.get(secret);
  if (!key) {
    key = Buffer.from(
      hkdfSync('sha256', secret, 'lecturelive-salt', 'lecturelive-email-unsub', 32)
    );
    unsubKeyCache.set(secret, key);
  }
  return key;
}

/** 校验时依次试当前密钥与上一代密钥，让 ENCRYPTION_KEY 轮换不作废存量退订链接。 */
function verificationSecrets(): string[] {
  return ENCRYPTION_KEY_PREVIOUS ? [ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS] : [ENCRYPTION_KEY];
}

/** 签名覆盖 userId|scope|exp 全体，任一被改动签名即不符。 */
function sign(userId: string, scope: string, expiresAt: number, secret: string): string {
  return createHmac('sha256', deriveUnsubKey(secret))
    .update(`unsub:v2:${userId}:${scope}:${expiresAt}`)
    .digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 生成无状态退订令牌：base64url(userId).scope.exp.sig
 * 退订范围与有效期都在令牌里且被签名覆盖，收件人无法自行扩大范围或延长有效期。
 */
export function makeUnsubscribeToken(
  userId: string,
  scope: UnsubscribeScope,
  options?: { now?: number; ttlMs?: number }
): string {
  const now = options?.now ?? Date.now();
  const expiresAt = now + (options?.ttlMs ?? UNSUB_TOKEN_TTL_MS);
  const idPart = Buffer.from(userId, 'utf8').toString('base64url');
  return `${idPart}.${scope}.${expiresAt}.${sign(userId, scope, expiresAt, ENCRYPTION_KEY)}`;
}

/**
 * 校验退订令牌，返回 { userId, scope } 或 null。
 * 签名不符 / 过期 / 范围非法 一律拒；比较 timing-safe。
 */
export function verifyUnsubscribeToken(
  token: string,
  options?: { now?: number }
): UnsubscribePayload | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [idPart, scope, expPart, sigPart] = parts;
  if (!idPart || !scope || !expPart || !sigPart) return null;

  let userId: string;
  try {
    userId = Buffer.from(idPart, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!userId) return null;

  // 范围必须是「用户可控分类」或 all——事务类（安全提醒）不允许退订。
  if (scope !== 'all' && !(isKnownCategory(scope) && !CATEGORY_BY_KEY.get(scope)!.transactional)) {
    return null;
  }

  const expiresAt = Number(expPart);
  if (!Number.isSafeInteger(expiresAt)) return null;

  // 先验签再看过期：签名不符的令牌里的 exp 本就不可信。
  const signatureOk = verificationSecrets().some((secret) =>
    safeEqual(sigPart, sign(userId, scope, expiresAt, secret))
  );
  if (!signatureOk) return null;
  if ((options?.now ?? Date.now()) >= expiresAt) return null;

  return { userId, scope: scope as UnsubscribeScope };
}
