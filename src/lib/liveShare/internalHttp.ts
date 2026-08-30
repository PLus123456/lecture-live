// src/lib/liveShare/internalHttp.ts
// WS 进程侧的内部撤销通知入口（SHARE-REVOKE-001）。
//
// 挂在 WS 进程的 http server 上（socket.io 只接管 /socket.io/ 路径，其余请求
// 会回落到 createServer 的原始 listener）。收到带合法 HMAC 签名的通知后，对
// 目标 session 房间执行一次观众与已建立主持人的复核驱逐。判定完全以 DB 为准（fail-safe），
// 通知本身只是触发器，被重放最多多跑一次只读复核。

import type { IncomingMessage, ServerResponse } from 'http';
import type { Server as SocketIO } from 'socket.io';
import { logger, serializeError } from '@/lib/logger';
import {
  LIVE_SHARE_INTERNAL_REVALIDATE_PATH,
  isLiveShareRevalidateMode,
  verifyLiveShareRevalidateSignature,
} from './internalApi';
import {
  revalidateSessionBroadcasters,
  revalidateSessionViewers,
} from './server';

const MAX_BODY_BYTES = 16 * 1024;

const internalHttpLogger = logger.child({ component: 'live-share-internal-http' });

// L4：本端点随 WS 服务绑在 WS_HOST（默认 0.0.0.0，容器部署必须如此，见
// server/websocket.ts 的 P6-1 注释），此前唯一防线是 HMAC 签名。签名实现本身正确，
// 但把「谁能连上这个端口」也收一道，属于纵深防御：
//   - 通知方 revocationNotifier 默认走 127.0.0.1:WS_PORT（同机 systemd 部署）；
//   - 跨容器/跨主机部署会显式设 LIVE_SHARE_WS_INTERNAL_URL，此时来源是容器网段
//     （172.16/12、10/8、Pod IP 等）——都是私有地址。
// 因此策略是「环回 + 私有网段放行，公网地址一律拒」：默认部署零配置即收紧，
// 容器部署也不会被误伤。确有跨公网内部调用的部署可用 LIVE_SHARE_INTERNAL_ALLOW_ANY_SOURCE
// 显式放开（放开后仍受 HMAC 保护）。
function normalizeRemoteAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  // IPv6 映射的 IPv4（::ffff:10.0.0.1）与带 zone 的链路本地（fe80::1%eth0）
  const mapped = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  return mapped.split('%')[0];
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 127) return true; // 环回
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 链路本地
  return false;
}

export function isTrustedInternalSource(remoteAddress: string | undefined): boolean {
  if (process.env.LIVE_SHARE_INTERNAL_ALLOW_ANY_SOURCE === 'true') {
    return true;
  }
  // 非 TCP/IP 连接（如 unix socket）本身就只可能来自本机。
  if (!remoteAddress) {
    return true;
  }

  const address = normalizeRemoteAddress(remoteAddress);
  if (address === '::1' || address === '::') return true;
  if (isPrivateIpv4(address)) return true;
  // fc00::/7（ULA）与 fe80::/10（链路本地）
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true;
  return false;
}

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

    // L4：来源网段校验（纵深，HMAC 仍是主防线）。放在读 body 之前，公网扫描连
    // 16KB 的读取都拿不到。响应与「路径不存在」保持一致的 404，不向外泄露端点存在。
    if (!isTrustedInternalSource(req.socket?.remoteAddress)) {
      internalHttpLogger.warn(
        { remoteAddress: req.socket?.remoteAddress },
        'Rejected live share internal request from an untrusted source address'
      );
      sendJson(res, 404, { error: 'Not found' });
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

    const silent = payload.mode === 'transition';
    const [evicted, revokedBroadcasters] = await Promise.all([
      revalidateSessionViewers(io, payload.sessionId, { silent }),
      revalidateSessionBroadcasters(io, payload.sessionId, { silent }),
    ]);
    internalHttpLogger.info(
      {
        sessionId: payload.sessionId,
        mode: payload.mode,
        evicted,
        revokedBroadcasters,
      },
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
