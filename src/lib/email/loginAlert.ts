// src/lib/email/loginAlert.ts
// 新设备/异地登录安全提醒（best-effort）。
// 用 Redis 记录每个用户「见过的设备指纹集合」（sha256(ua)）：命中→老设备静默；未命中且
// 集合此前非空→判定新设备，发安全告警邮件；集合此前为空→首登，只播种不提醒（避免注册即打扰）。
// 纯 Redis 实现、无 schema 改动；Redis 不可用则整体跳过（宁可不提醒也不误报/不阻塞登录）。

import 'server-only';
import { createHash } from 'node:crypto';
import { getRedisClient } from '@/lib/redis';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logger, serializeError } from '@/lib/logger';
import type { SiteSettings } from '@/lib/siteSettings';
import { sendSecurityAlertEmail, type EmailUser } from '@/lib/email';

// v2：指纹口径从 sha256(ip|ua) 改为 sha256(ua)，key 前缀必须一起换代。
// 否则存量用户的集合里全是 v1 口径的指纹，改版后第一次登录必然「未命中且集合非空」，
// 于是全站每人收到一封「新设备登录」误报——正是首登播种规则一直在避免的群发事故。
// v2 集合从空开始 → 走 prevCount===0 的静默播种；v1 的老 key 靠 TTL 在 180 天内自然过期。
const KNOWN_DEVICES_PREFIX = 'auth:known-devices:v2:';
const KNOWN_DEVICES_TTL_SEC = 180 * 24 * 60 * 60; // 180 天
const MAX_DEVICES_PER_USER = 50; // 集合上限，防无限增长

// 只按 User-Agent 做指纹，**刻意不含 IP**：移动网络/运营商 NAT 下 IP 几乎每次登录都变，
// 含 IP 会把同一台手机判成无穷多台新设备。而 security_alert 在 preferences.ts 是
// transactional（用户关不掉、无退订链接），误报代价极高——告警一旦天天来就等于没有告警。
// 代价是同一用户名下 UA 完全相同的两台设备会被合并（漏报）；相比不可关闭的持续误报，
// 这个方向的错误更可接受。IP 仍会出现在告警邮件正文里，供用户自行判断。
function deviceFingerprint(userAgent: string): string {
  return createHash('sha256').update(userAgent).digest('hex').slice(0, 32);
}

/**
 * 登录成功后调用（fire-and-forget，务必 void 调用、绝不阻塞登录）。
 * 判定为新设备时发一封安全告警邮件。任何异常都吞掉。
 */
export async function maybeNotifyNewDeviceLogin(
  user: EmailUser,
  req: Request,
  settings?: SiteSettings
): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis || redis.status !== 'ready') return; // 无 Redis：跳过（内存兜底跨进程不可靠，宁可不提醒）

    const ip = resolveRequestClientIp(req);
    const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 256);
    // UA 为空则指纹无意义（所有无 UA 客户端会塌成同一个），既判不出新设备也只会制造噪音。
    if (!userAgent) return;

    const device = deviceFingerprint(userAgent);
    const key = `${KNOWN_DEVICES_PREFIX}${user.id}`;

    const isMember = await redis.sismember(key, device);
    if (isMember === 1) {
      await redis.expire(key, KNOWN_DEVICES_TTL_SEC); // 续期活跃设备
      return;
    }

    const prevCount = await redis.scard(key);
    await redis.sadd(key, device);
    await redis.expire(key, KNOWN_DEVICES_TTL_SEC);
    // 集合过大时随机淘汰，防止被大量伪造 UA 撑爆
    if (prevCount + 1 > MAX_DEVICES_PER_USER) {
      await redis.spop(key).catch(() => undefined);
    }

    if (prevCount === 0) return; // 首个设备：只播种，不提醒

    const when = new Date().toLocaleString('zh-CN', { hour12: false });
    await sendSecurityAlertEmail(
      user,
      { kind: 'new_device_login', ip: ip === 'unknown' ? null : ip, when, userAgent },
      { settings }
    );
    logger.info({ userId: user.id }, '[loginAlert] 已发送新设备登录提醒');
  } catch (err) {
    logger.warn({ err: serializeError(err) }, '[loginAlert] 新设备提醒处理失败（忽略）');
  }
}
