// src/lib/liveShare/internalApi.ts
// Next.js API 进程 → 独立 WS 进程的内部撤销通知协议（SHARE-REVOKE-001）。
//
// 撤销/轮换分享链接只写 DB，而观众 socket 的 token 校验只在 join 时执行一次，
// 因此撤销必须额外通知 WS 进程对该 session 的房间做一次复核驱逐。两个进程只共享
// DB 与环境变量，这里用 JWT_SECRET 派生的 HMAC 对通知做鉴权：伪造者拿不到签名，
// 而即使签名被重放，接收端也只是触发一次"按 DB 现状复核"（fail-safe，见
// revalidateSessionViewers），不会驱逐仍然合法的观众。

import { createHmac, timingSafeEqual } from 'crypto';
import { JWT_SECRET } from '@/lib/serverSecrets';

export const LIVE_SHARE_INTERNAL_REVALIDATE_PATH = '/internal/live-share/revalidate';

// 时间窗：超窗的通知直接拒绝，限制签名被捕获后的可重放期。
export const LIVE_SHARE_INTERNAL_MAX_SKEW_MS = 5 * 60_000;

export const LIVE_SHARE_SESSION_ID_MAX_LENGTH = 200;

/**
 * revoke：链接被撤销/删除，驱逐时向观众发 share_error（前端切换到"无法访问"页）。
 * transition：录制结束转回放（keepForPlayback），静默断开——观众已收到主播的
 * SHARE_OFFLINE 静态完成态，不该被错误页打断。
 */
export type LiveShareRevalidateMode = 'revoke' | 'transition';

export interface LiveShareRevalidatePayload {
  sessionId: string;
  mode: LiveShareRevalidateMode;
  /** Unix 毫秒时间戳，签名的一部分 */
  ts: number;
}

function computeSignature(payload: LiveShareRevalidatePayload): Buffer {
  return createHmac('sha256', JWT_SECRET)
    .update(
      `lecture-live:live-share-revalidate:v1:${payload.sessionId}:${payload.mode}:${payload.ts}`
    )
    .digest();
}

export function isLiveShareRevalidateMode(
  value: unknown
): value is LiveShareRevalidateMode {
  return value === 'revoke' || value === 'transition';
}

export function signLiveShareRevalidatePayload(
  payload: LiveShareRevalidatePayload
): string {
  return computeSignature(payload).toString('hex');
}

export function verifyLiveShareRevalidateSignature(
  payload: LiveShareRevalidatePayload,
  signature: string,
  nowMs: number = Date.now()
): boolean {
  if (
    typeof payload.sessionId !== 'string' ||
    !payload.sessionId ||
    payload.sessionId.length > LIVE_SHARE_SESSION_ID_MAX_LENGTH ||
    !isLiveShareRevalidateMode(payload.mode) ||
    typeof payload.ts !== 'number' ||
    !Number.isFinite(payload.ts)
  ) {
    return false;
  }

  if (Math.abs(nowMs - payload.ts) > LIVE_SHARE_INTERNAL_MAX_SKEW_MS) {
    return false;
  }

  if (typeof signature !== 'string' || !/^[0-9a-f]+$/i.test(signature)) {
    return false;
  }

  const provided = Buffer.from(signature, 'hex');

  const expected = computeSignature(payload);
  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}
