// src/lib/email/quotaAlert.ts
// 转录分钟配额「快用完」提醒（best-effort）。在会话收尾扣减分钟后（事务外）触发。
// 阈值 90%；用 Redis 按「用户 + 当前配额周期」去重，每周期至多一封（无 Redis 则跳过以免重复轰炸）。
// 发信受用户「配额提醒」偏好约束。ADMIN（无限配额哨兵）跳过。

import 'server-only';
import { prisma } from '@/lib/prisma';
import { getRedisClient } from '@/lib/redis';
import { logger, serializeError } from '@/lib/logger';
import { sendQuotaAlertEmail } from '@/lib/email';

const QUOTA_ALERT_THRESHOLD = 0.9; // 用量达 90% 触发
const UNLIMITED_SENTINEL = 999999; // 与 userRoles 的 ADMIN 无限哨兵一致

/**
 * 收尾扣减转录分钟后调用（void、非阻塞）。达阈值且本周期未提醒过则发一封。任何异常吞掉。
 */
export async function maybeSendTranscriptionQuotaAlert(userId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis || redis.status !== 'ready') return; // 无 Redis 无法按周期去重，跳过

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailPreferences: true,
        role: true,
        transcriptionMinutesUsed: true,
        transcriptionMinutesLimit: true,
        quotaResetAt: true,
      },
    });
    if (!user) return;
    if (user.role === 'ADMIN') return;

    const limit = user.transcriptionMinutesLimit;
    if (!Number.isFinite(limit) || limit <= 0 || limit >= UNLIMITED_SENTINEL) return;

    const used = user.transcriptionMinutesUsed;
    const percent = used / limit;
    if (percent < QUOTA_ALERT_THRESHOLD) return;

    // 按当前配额周期去重（quotaResetAt 变了即新周期，可再次提醒）。
    const cycle = user.quotaResetAt ? user.quotaResetAt.toISOString().slice(0, 10) : 'none';
    const dedupKey = `email:quota-alerted:${user.id}:${cycle}`;
    const won = await redis.set(dedupKey, '1', 'EX', 40 * 86400, 'NX');
    if (won !== 'OK') return;

    await sendQuotaAlertEmail(user, {
      quotaLabel: '转录分钟',
      usedLabel: `${used} / ${limit} 分钟`,
      percentLabel: `${Math.min(100, Math.round(percent * 100))}%`,
    });
    logger.info({ userId: user.id }, '[quotaAlert] 已发送配额提醒');
  } catch (err) {
    logger.warn({ err: serializeError(err) }, '[quotaAlert] 处理失败（忽略）');
  }
}
