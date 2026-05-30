// src/lib/interpret/anchor.ts
// 同声传译（interpret）计费的服务端时长锚点。
// interpret 是浏览器直连 Soniox 的实时会话，后端不经手音频，能观测的信号只有
// 会话开始（/api/interpret/start）与结束（/api/interpret/deduct）。这里用 Redis 存一次性
// 锚点（会话开始时间），让 deduct 以服务端墙钟为计费权威，杜绝"纯信前端 durationMs 少报省钱"。

import { randomUUID } from 'crypto';
import { getRedisClient } from '@/lib/redis';
import { logger } from '@/lib/logger';

const anchorLogger = logger.child({ component: 'interpret-anchor' });

const ANCHOR_KEY_PREFIX = 'interpret:anchor:';
// 12h：远大于任何正常 interpret 会话，又能让"建立后未结算"的残留锚点自动清理
const ANCHOR_TTL_SECONDS = 12 * 60 * 60;
// 单次 interpret 计费硬上限：防 start 后忘 stop 挂机 / 锚点残留导致服务端墙钟虚高
export const MAX_INTERPRET_DURATION_MS = 6 * 60 * 60_000;
// 容差：吸收 deduct 相对 stop 的网络延迟 + 前端计时抖动，避免冤枉诚实用户
const ANCHOR_TOLERANCE_MS = 60_000;
// anchorId 由本服务用 randomUUID 生成；deduct 收到的是前端回传值，须校验格式防 Redis key 注入
const ANCHOR_ID_RE = /^[0-9a-fA-F-]{36}$/;

function anchorKey(userId: string, anchorId: string): string {
  return `${ANCHOR_KEY_PREFIX}${userId}:${anchorId}`;
}

/**
 * 创建一次性会话锚点，返回 anchorId。
 * Redis 不可用 / 未配置时返回 null —— 调用方据此降级为信任前端时长（带硬上限）。
 */
export async function createInterpretAnchor(
  userId: string,
  now: number
): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const anchorId = randomUUID();
  try {
    await redis.set(anchorKey(userId, anchorId), String(now), 'EX', ANCHOR_TTL_SECONDS);
    return anchorId;
  } catch (err) {
    anchorLogger.warn(
      { message: err instanceof Error ? err.message : String(err) },
      'failed to create interpret anchor'
    );
    return null;
  }
}

/**
 * 读取并删除（一次性消费）会话锚点，返回 startedAt(ms) 或 null。
 * 删除保证同一锚点不会被重复扣费；查不到（过期 / 已消费 / 伪造）返回 null。
 */
export async function consumeInterpretAnchor(
  userId: string,
  anchorId: string
): Promise<number | null> {
  if (!ANCHOR_ID_RE.test(anchorId)) return null;
  const redis = getRedisClient();
  if (!redis) return null;

  const key = anchorKey(userId, anchorId);
  try {
    const raw = await redis.get(key);
    await redis.del(key); // 无论是否命中都删，确保一次性
    if (!raw) return null;
    const startedAt = Number(raw);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch (err) {
    anchorLogger.warn(
      { message: err instanceof Error ? err.message : String(err) },
      'failed to consume interpret anchor'
    );
    return null;
  }
}

export interface BillableInterpretResult {
  effectiveMs: number;
  /** 检测到前端明显少报（已按服务端墙钟扣费），调用方应记审计 */
  mismatch: boolean;
  /** 是否命中服务端锚点（false 表示降级信任了前端时长） */
  anchored: boolean;
}

/**
 * 计费时长决策：以服务端墙钟为锚点，前端 durationMs 仅在容差内被采纳。
 * - 无锚点：降级信任前端值（封顶 MAX_INTERPRET_DURATION_MS）
 * - 前端多报（> 服务端墙钟）：封顶到服务端墙钟（保护用户不被多扣）
 * - 前端明显少报（< 服务端墙钟 - 容差）：按服务端墙钟扣，mismatch=true
 * - 容差内：采纳前端值
 */
export function resolveBillableInterpretMs(params: {
  frontendMs: number;
  anchorStartedAt: number | null;
  now: number;
}): BillableInterpretResult {
  const frontendMs = Number.isFinite(params.frontendMs)
    ? Math.max(0, params.frontendMs)
    : 0;

  if (params.anchorStartedAt === null) {
    return {
      effectiveMs: Math.min(frontendMs, MAX_INTERPRET_DURATION_MS),
      mismatch: false,
      anchored: false,
    };
  }

  const serverElapsedMs = Math.max(0, params.now - params.anchorStartedAt);
  const cappedServerMs = Math.min(serverElapsedMs, MAX_INTERPRET_DURATION_MS);

  if (frontendMs > cappedServerMs) {
    // 多报 / 异常大值：封顶到服务端墙钟，不视为违规
    return { effectiveMs: cappedServerMs, mismatch: false, anchored: true };
  }
  if (frontendMs < cappedServerMs - ANCHOR_TOLERANCE_MS) {
    // 明显少报：按服务端墙钟扣费
    return { effectiveMs: cappedServerMs, mismatch: true, anchored: true };
  }
  // 容差内：采纳前端值
  return { effectiveMs: frontendMs, mismatch: false, anchored: true };
}
