import { sanitizeToken } from '@/lib/security';

export const VIEWER_JOIN_BUCKET_CAPACITY = 4;
export const VIEWER_JOIN_REFILL_PER_SECOND = 0.2;
const MAX_RAW_VIEWER_TOKEN_BYTES = 256;
const MAX_VIEWER_TOKEN_BYTES = 128;

export interface ViewerJoinRateState {
  tokens: number;
  lastRefillMs: number;
}

export interface ViewerInitialStateBudget {
  sentBytes: number;
}

export type ViewerJoinTokenResult =
  | { ok: true; token: string }
  | { ok: false; message: string; code: 'INVALID_SHARE_TOKEN' };

export function createViewerJoinRateState(nowMs = Date.now()): ViewerJoinRateState {
  return {
    tokens: VIEWER_JOIN_BUCKET_CAPACITY,
    lastRefillMs: nowMs,
  };
}

export function createViewerInitialStateBudget(): ViewerInitialStateBudget {
  return { sentBytes: 0 };
}

/** 同一 socket 的 join 已串行化；因此检查与记账可作为一个同步的原子步骤。 */
export function reserveViewerInitialStateBytes(
  budget: ViewerInitialStateBudget,
  responseBytes: number,
  limitBytes: number
): boolean {
  if (
    !Number.isSafeInteger(responseBytes) ||
    responseBytes < 0 ||
    !Number.isSafeInteger(limitBytes) ||
    limitBytes < 0 ||
    budget.sentBytes + responseBytes > limitBytes
  ) {
    return false;
  }
  budget.sentBytes += responseBytes;
  return true;
}

/** DB 查询前消费专用成本令牌；无效 token 同样由调用方先消费再校验。 */
export function consumeViewerJoinAttempt(
  state: ViewerJoinRateState,
  nowMs = Date.now()
): boolean {
  const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
  if (elapsedMs > 0) {
    state.tokens = Math.min(
      VIEWER_JOIN_BUCKET_CAPACITY,
      state.tokens + (elapsedMs / 1000) * VIEWER_JOIN_REFILL_PER_SECOND
    );
    state.lastRefillMs = nowMs;
  }
  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

/**
 * 接受生成器实际会产生的 base64url/cuid 字符集；只允许外围空白被 trim，不能把中间
 * 标点删除后解释成另一个合法 token，否则同一授权会出现可绕过幂等/缓存的别名。
 */
export function parseViewerJoinToken(payload: unknown): ViewerJoinTokenResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      message: 'Invalid share token',
      code: 'INVALID_SHARE_TOKEN',
    };
  }
  const rawToken = (payload as { shareToken?: unknown }).shareToken;
  if (
    typeof rawToken !== 'string' ||
    Buffer.byteLength(rawToken, 'utf8') > MAX_RAW_VIEWER_TOKEN_BYTES
  ) {
    return {
      ok: false,
      message: 'Invalid share token',
      code: 'INVALID_SHARE_TOKEN',
    };
  }

  const trimmed = rawToken.trim();
  if (
    trimmed.length === 0 ||
    Buffer.byteLength(trimmed, 'utf8') > MAX_VIEWER_TOKEN_BYTES
  ) {
    return {
      ok: false,
      message: 'Invalid share token',
      code: 'INVALID_SHARE_TOKEN',
    };
  }

  try {
    const safe = sanitizeToken(trimmed);
    if (safe !== trimmed) {
      return {
        ok: false,
        message: 'Invalid share token',
        code: 'INVALID_SHARE_TOKEN',
      };
    }
    return { ok: true, token: safe };
  } catch {
    return {
      ok: false,
      message: 'Invalid share token',
      code: 'INVALID_SHARE_TOKEN',
    };
  }
}
