// src/lib/liveShare/internalHttp.ts
// WS 进程侧的内部撤销通知入口（SHARE-REVOKE-001）。
//
// 挂在 WS 进程的 http server 上（socket.io 只接管 /socket.io/ 路径，其余请求
// 会回落到 createServer 的原始 listener）。收到带合法 HMAC 签名的通知后，对
// 目标 session 房间执行一次观众复核驱逐。判定完全以 DB 为准（fail-safe），
// 通知本身只是触发器，被重放最多多跑一次只读复核。

import type { IncomingMessage, ServerResponse } from 'http';
import type { Server as SocketIO } from 'socket.io';
import { logger, serializeError } from '@/lib/logger';
import {
  LIVE_SHARE_INTERNAL_REVALIDATE_PATH,
  isLiveShareRevalidateMode,
  verifyLiveShareRevalidateSignature,
} from './internalApi';
import { revalidateSessionViewers } from './server';

const MAX_BODY_BYTES = 16 * 1024;

const internalHttpLogger = logger.child({ component: 'live-share-internal-http' });

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  if (res.headersSent) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readRequestBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => finish(null));
  });
}

/**
 * 处理 WS 进程收到的非 socket.io HTTP 请求。仅识别内部复核通知；其余一律 404。
 * 所有异常就地吞掉——WS 进程的 uncaughtException 会触发整机优雅关停，这里
 * 绝不能向外抛。
 */
export function handleLiveShareInternalRequest(
  io: SocketIO,
  req: IncomingMessage,
  res: ServerResponse
): void {
  void (async () => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== LIVE_SHARE_INTERNAL_REVALIDATE_PATH) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const rawBody = await readRequestBody(req);
    if (rawBody === null) {
      // 超限（readRequestBody 已销毁连接）或流错误：不再尝试写响应。
      internalHttpLogger.warn(
        { url: pathname },
        'Dropped oversized or broken live share internal request'
      );
      return;
    }

    let parsed: {
      sessionId?: unknown;
      mode?: unknown;
      ts?: unknown;
      sig?: unknown;
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (
      typeof parsed.sessionId !== 'string' ||
      !isLiveShareRevalidateMode(parsed.mode) ||
      typeof parsed.ts !== 'number' ||
      typeof parsed.sig !== 'string'
    ) {
      sendJson(res, 400, { error: 'Invalid payload' });
      return;
    }

    const payload = {
      sessionId: parsed.sessionId,
      mode: parsed.mode,
      ts: parsed.ts,
    };
    if (!verifyLiveShareRevalidateSignature(payload, parsed.sig)) {
      internalHttpLogger.warn(
        { sessionId: payload.sessionId },
        'Rejected live share revalidate request with invalid signature'
      );
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const evicted = await revalidateSessionViewers(io, payload.sessionId, {
      silent: payload.mode === 'transition',
    });
    internalHttpLogger.info(
      { sessionId: payload.sessionId, mode: payload.mode, evicted },
      'Processed live share revalidate notification'
    );
    sendJson(res, 200, { evicted });
  })().catch((error) => {
    internalHttpLogger.error(
      { err: serializeError(error) },
      'Live share internal request handling failed'
    );
    sendJson(res, 500, { error: 'Internal server error' });
  });
}
