// src/lib/email/broadcast.ts
// 管理员群发（产品更新 / 促销）。此前 sendGenericNotificationEmail 零调用，导致
// product_updates/promotions 两个用户开关与 marketing_emails_enabled 站点总开关全是摆设 ——
// 管理员「关闭营销邮件」实际什么也没关。这里补上唯一的调用方。
//
// 两条硬约束：
//  1. **绝不在请求线程里串行发完**。审计里的 #5 就是这么把维护循环拖成小时级停摆的：
//     500 人 × SMTP 10~20s = 单轮 1.4h。这里用与 sendExpiryReminders 同款的
//     worker pool（有界并发 + 总时间预算），并由路由 fire-and-forget 调度。
//  2. **逐人过偏好**。sendGenericNotificationEmail 内部已做权威判定，这里额外过一遍只为
//     让预览人数与实际发送量一致（否则管理员看到的数字是假的）。

import 'server-only';
import { prisma } from '@/lib/prisma';
import { logger, serializeError } from '@/lib/logger';
import { sendGenericNotificationEmail, type EmailUser } from '@/lib/email';
import { isCategoryEnabledForUser } from '@/lib/email/preferences';
import type { SiteSettings } from '@/lib/siteSettings';

export type BroadcastCategory = 'product_updates' | 'promotions';
export type BroadcastAudience = 'all' | 'FREE' | 'PRO' | 'ADMIN';

export interface BroadcastContent {
  category: BroadcastCategory;
  subject: string;
  heading: string;
  bodyText: string;
  cta?: { url: string; label: string };
}

/** 同时在途的发信数。与到期提醒同口径：SMTP 侧不是无限并发。 */
const BROADCAST_CONCURRENCY = 5;
/** 单次群发的总时间预算，超时即停止派发并如实报告未发完。 */
const BROADCAST_BUDGET_MS = 10 * 60_000;
/** 单次群发的收件人上限。超出即截断——但必须让调用方看见（见 truncated）。 */
export const BROADCAST_MAX_RECIPIENTS = 5000;

export interface BroadcastRecipients {
  users: EmailUser[];
  /** 命中上限被截断：UI 要如实告知，不能让管理员以为"全发到了"。 */
  truncated: boolean;
}

/**
 * 选收件人：仅「正常 + 邮箱已验证 + 该分类未退订」的用户。
 *
 * 要求 emailVerifiedAt 非空是刻意的——给从未验证过的地址发营销信会推高退信率、伤投递声誉。
 * 注意这不会误伤任何人：门禁关闭时注册路径本来就把账号建成已验证，只有「门禁开着且本人
 * 尚未点验证链接」才为 null，而这类地址恰恰是最不该发营销的。
 */
export async function findBroadcastRecipients(
  audience: BroadcastAudience,
  category: BroadcastCategory,
  settings: SiteSettings
): Promise<BroadcastRecipients> {
  const rows = await prisma.user.findMany({
    where: {
      status: 1,
      emailVerifiedAt: { not: null },
      ...(audience === 'all' ? {} : { role: audience }),
    },
    select: { id: true, email: true, displayName: true, emailPreferences: true },
    orderBy: { createdAt: 'asc' },
    take: BROADCAST_MAX_RECIPIENTS + 1, // 多取一条用于探测截断
  });

  const truncated = rows.length > BROADCAST_MAX_RECIPIENTS;
  const users = rows.slice(0, BROADCAST_MAX_RECIPIENTS).filter((u) =>
    isCategoryEnabledForUser(category, u.emailPreferences, {
      marketingEnabled: settings.marketing_emails_enabled,
    })
  );

  return { users, truncated };
}

export interface BroadcastResult {
  sent: number;
  skipped: number; // 被偏好/总开关挡下
  failed: number;
  budgetExhausted: boolean;
}

/**
 * 实际派发。有界并发 + 总预算，任何单封失败都不中断整批。
 * 调用方应 fire-and-forget（不要 await 在请求线程里）。
 */
export async function runBroadcast(
  recipients: EmailUser[],
  content: BroadcastContent,
  settings: SiteSettings,
  /** 仅供测试注入；生产调用不传，用上面的常量。 */
  opts?: { concurrency?: number; budgetMs?: number }
): Promise<BroadcastResult> {
  const concurrency = Math.max(1, opts?.concurrency ?? BROADCAST_CONCURRENCY);
  const budgetMs = Math.max(1, opts?.budgetMs ?? BROADCAST_BUDGET_MS);
  const deadline = Date.now() + budgetMs;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let budgetExhausted = false;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline) {
        budgetExhausted = true;
        return;
      }
      const index = cursor++;
      if (index >= recipients.length) return;
      const user = recipients[index];

      try {
        const result = await sendGenericNotificationEmail(user, content, { settings });
        if (!result.ok) {
          failed += 1;
        } else if (result.error === 'skipped:preference') {
          skipped += 1;
        } else {
          sent += 1;
        }
      } catch (err) {
        failed += 1;
        logger.warn(
          { err: serializeError(err), userId: user.id },
          '[broadcast] 单封发送异常（已跳过）'
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, recipients.length || 1) }, () => worker())
  );

  logger.info(
    { category: content.category, sent, skipped, failed, budgetExhausted },
    '[broadcast] 群发结束'
  );
  return { sent, skipped, failed, budgetExhausted };
}
