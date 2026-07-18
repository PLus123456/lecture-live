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
        status: true,
        transcriptionMinutesUsed: true,
        transcriptionMinutesLimit: true,
        purchasedMinutesBalance: true,
        quotaResetAt: true,
      },
    });
    if (!user) return;
    if (user.role === 'ADMIN') return;
    // 封禁账号不打扰（与 billingMaintenance 的到期提醒口径一致）。被封后仍可能有
    // system_auto_reclaim 定时任务替他收尾会话，进而走到这里。
    if (user.status !== 1) return;

    const baseLimit = user.transcriptionMinutesLimit;
    if (!Number.isFinite(baseLimit) || baseLimit <= 0 || baseLimit >= UNLIMITED_SENTINEL) return;

    // 分母必须与真门禁一致（Model A：月度上限 + 永久时长池，见 quota.ts 的原子扣减 WHERE）。
    // 只看 limit 的话，刚买了 1000 分钟包的用户在 used=54/limit=60 时就会收到「已用 90%」，
    // 而他其实还有一整池分钟没动；且 Model A 允许 used 超过 limit，百分比还会一路涨过 100%，
    // 按周期去重意味着每个月都误报一次。
    const effectiveLimit = baseLimit + Math.max(0, user.purchasedMinutesBalance);
    const used = user.transcriptionMinutesUsed;
    const percent = used / effectiveLimit;
    if (percent < QUOTA_ALERT_THRESHOLD) return;

    // 按当前配额周期去重（quotaResetAt 变了即新周期，可再次提醒）。
    const cycle = user.quotaResetAt ? user.quotaResetAt.toISOString().slice(0, 10) : 'none';
    const dedupKey = `email:quota-alerted:${user.id}:${cycle}`;
    const won = await redis.set(dedupKey, '1', 'EX', 40 * 86400, 'NX');
    if (won !== 'OK') return;

    const result = await sendQuotaAlertEmail(user, {
      quotaLabel: '转录分钟',
      usedLabel: `${used} / ${effectiveLimit} 分钟`,
      percentLabel: `${Math.min(100, Math.round(percent * 100))}%`,
    });

    // 去重键是「发之前」抢的，发失败就得还回去：否则一次瞬时 SMTP 故障
    // 会让这个用户在整个配额周期内再也收不到提醒，而日志还显示"已发送"。
    // 偏好跳过（ok:true + skipped:preference）属于用户主动关闭，保留占位不重试。
    if (!result.ok) {
      await redis.del(dedupKey).catch(() => undefined);
      logger.warn(
        { userId: user.id, error: result.error },
        '[quotaAlert] 配额提醒发送失败，已释放去重键待下次重试'
      );
      return;
    }
    logger.info({ userId: user.id }, '[quotaAlert] 已发送配额提醒');
  } catch (err) {
    logger.warn({ err: serializeError(err) }, '[quotaAlert] 处理失败（忽略）');
  }
}
