// src/lib/email/loginAlert.ts
// 新设备/异地登录安全提醒（best-effort）。
// 用 Redis 记录每个用户「见过的设备指纹集合」（sha256(ip|ua)）：命中→老设备静默；未命中且
// 集合此前非空→判定新设备，发安全告警邮件；集合此前为空→首登，只播种不提醒（避免注册即打扰）。
// 纯 Redis 实现、无 schema 改动；Redis 不可用则整体跳过（宁可不提醒也不误报/不阻塞登录）。

import 'server-only';
import { createHash } from 'node:crypto';
import { getRedisClient } from '@/lib/redis';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logger, serializeError } from '@/lib/logger';
import type { SiteSettings } from '@/lib/siteSettings';
import { sendSecurityAlertEmail, type EmailUser } from '@/lib/email';

const KNOWN_DEVICES_PREFIX = 'auth:known-devices:';
const KNOWN_DEVICES_TTL_SEC = 180 * 24 * 60 * 60; // 180 天
const MAX_DEVICES_PER_USER = 50; // 集合上限，防无限增长

function deviceFingerprint(ip: string, userAgent: string): string {
  return createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 32);
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
    if (ip === 'unknown' && !userAgent) return; // 指纹信息不足，跳过

    const device = deviceFingerprint(ip, userAgent);
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
