// src/lib/liveShare/revocationNotifier.ts
// API 进程侧：撤销/轮换分享链接后，通知独立 WS 进程即时驱逐持失效 token 的观众
// （SHARE-REVOKE-001）。通知失败不影响撤销本身——DB 已是唯一真源，WS 侧的周期
// 复核（VIEWER_REVALIDATE_INTERVAL_MS）会兜底驱逐，只是不再即时。

import { logger, serializeError } from '@/lib/logger';
import {
  LIVE_SHARE_INTERNAL_REVALIDATE_PATH,
  signLiveShareRevalidatePayload,
  type LiveShareRevalidateMode,
} from './internalApi';

const NOTIFY_TIMEOUT_MS = 2_000;

const notifierLogger = logger.child({ component: 'live-share-revocation-notifier' });

function resolveInternalBaseUrl(): string {
  const explicit = process.env.LIVE_SHARE_WS_INTERNAL_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  // WS 进程与 API 进程同机部署（dev:ws / start:ws），默认走环回地址。
  const port = parseInt(process.env.WS_PORT || '3001', 10);
  return `http://127.0.0.1:${port}`;
}

/**
 * 通知 WS 进程对该 session 的直播房间做一次观众复核驱逐。
 * 永不抛错：失败仅记日志，调用方（撤销 API）不因此失败。
 */
export async function notifyLiveShareLinksRevoked(
  sessionId: string,
  mode: LiveShareRevalidateMode
): Promise<void> {
  const payload = { sessionId, mode, ts: Date.now() };

  try {
    const response = await fetch(
      `${resolveInternalBaseUrl()}${LIVE_SHARE_INTERNAL_REVALIDATE_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          sig: signLiveShareRevalidatePayload(payload),
        }),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      notifierLogger.warn(
        { sessionId, mode, status: response.status },
        'Live share revocation notification was rejected; periodic revalidation will evict stale viewers'
      );
    }
  } catch (error) {
    notifierLogger.warn(
      { sessionId, mode, err: serializeError(error) },
      'Failed to notify websocket server about share revocation; periodic revalidation will evict stale viewers'
    );
  }
}
