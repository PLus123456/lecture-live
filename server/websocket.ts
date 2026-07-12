// server/websocket.ts
// Custom WebSocket server for live share (runs alongside Next.js)

import { createServer } from 'http';
import { Server as SocketIO, Socket } from 'socket.io';
import { setupLiveShare } from '../src/lib/liveShare/server';
import { getTrustedForwardedIp, shouldTrustProxyHeaders } from '../src/lib/clientIp';
import {
  startBillingMaintenanceLoop,
  stopBillingMaintenanceLoop,
} from '../src/lib/billingMaintenance';
import {
  startCloudreveTokenRefreshLoop,
  stopCloudreveTokenRefreshLoop,
} from '../src/lib/storage/cloudreveTokenRefresh';
import {
  startAudioEnhanceLoop,
  stopAudioEnhanceLoop,
} from '../src/lib/audio/enhanceLoop';
import { logger, serializeError } from '../src/lib/logger';

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const MAX_CONNECTIONS_PER_IP = 50;
const MAX_MESSAGE_SIZE_BYTES = 100 * 1024;
const SHUTDOWN_TIMEOUT_MS = 10_000;

// 每 socket 消息限流（令牌桶）：限制单个已认证 socket 的入站消息频率，
// 防止被盗号/异常客户端用 broadcast / sync_snapshot 等消息洪泛打爆独立 WS 进程。
// 稳态上限 ~20 msg/s，桶容量给突发留出余量；持续超限则断连（onAny 无法真正“丢弃”
// 已派发给业务 handler 的事件，断连是可靠且对滥用者合适的处置）。
const RATE_LIMIT_REFILL_PER_SEC = 20;
const RATE_LIMIT_BUCKET_CAPACITY = 40;

interface SocketRateState {
  tokens: number;
  lastRefillMs: number;
}

// 令牌桶限流：消费一个令牌。返回 false 表示桶已空（超限），应断连该 socket。
function consumeRateToken(state: SocketRateState, nowMs: number): boolean {
  const elapsedMs = nowMs - state.lastRefillMs;
  if (elapsedMs > 0) {
    state.tokens = Math.min(
      RATE_LIMIT_BUCKET_CAPACITY,
      state.tokens + (elapsedMs / 1000) * RATE_LIMIT_REFILL_PER_SEC
    );
    state.lastRefillMs = nowMs;
  }

  if (state.tokens < 1) {
    return false;
  }

  state.tokens -= 1;
  return true;
}

const connectionsByIp = new Map<string, number>();
const wsLogger = logger.child({ component: 'websocket-server' });
let isShuttingDown = false;

function resolveClientIp(socket: Socket) {
  if (shouldTrustProxyHeaders()) {
    // 安全：优先 X-Real-IP（nginx 设为 $remote_addr，不可被客户端伪造），再回退
    // X-Forwarded-For 最后一段。最左段是客户端可伪造的，不能用于每 IP 连接上限/限流。
    const realIp = socket.handshake.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
      return realIp.trim();
    }

    const forwardedFor = socket.handshake.headers['x-forwarded-for'];
    const forwardedIp =
      typeof forwardedFor === 'string'
        ? getTrustedForwardedIp(forwardedFor)
        : null;
    if (forwardedIp) {
      return forwardedIp;
    }
  }

  return socket.handshake.address?.trim() || 'unknown';
}

function incrementConnectionCount(ip: string) {
  const nextCount = (connectionsByIp.get(ip) ?? 0) + 1;
  connectionsByIp.set(ip, nextCount);
}

function decrementConnectionCount(ip: string) {
  const nextCount = (connectionsByIp.get(ip) ?? 1) - 1;
  if (nextCount <= 0) {
    connectionsByIp.delete(ip);
    return;
  }

  connectionsByIp.set(ip, nextCount);
}

const httpServer = createServer();
const io = new SocketIO(httpServer, {
  cors: {
    origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST'],
  },
  pingTimeout: 20_000,
  pingInterval: 10_000,
  maxHttpBufferSize: MAX_MESSAGE_SIZE_BYTES,
});

// 安全：显式校验 Origin header，防止跨站 WebSocket 劫持
const allowedOrigin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const allowedOriginSet = new Set<string>();
try {
  const parsed = new URL(allowedOrigin);
  allowedOriginSet.add(parsed.origin);
} catch {
  // fallback
  allowedOriginSet.add(allowedOrigin.replace(/\/$/, ''));
}

io.use((socket, next) => {
  if (isShuttingDown) {
    return next(new Error('Server is shutting down'));
  }

  // Origin 校验：拒绝非预期来源的 WebSocket 连接
  const origin = socket.handshake.headers.origin;
  if (origin && !allowedOriginSet.has(origin)) {
    wsLogger.warn({ origin }, 'Rejected websocket connection with invalid origin');
    return next(new Error('Origin not allowed'));
  }

  const clientIp = resolveClientIp(socket);
  const currentConnections = connectionsByIp.get(clientIp) ?? 0;

  if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
    wsLogger.warn(
      { clientIp, connections: currentConnections },
      'Rejected websocket connection because IP connection limit was exceeded'
    );
    return next(new Error('Too many connections from this IP'));
  }

  socket.data.clientIp = clientIp;
  socket.data.connectionTracked = true;
  incrementConnectionCount(clientIp);
  return next();
});

io.on('connection', (socket) => {
  wsLogger.info(
    {
      socketId: socket.id,
      clientIp: socket.data.clientIp,
      transport: socket.conn.transport.name,
    },
    'WebSocket client connected'
  );

  // 每 socket 入站消息限流：onAny 在业务 handler 之前对每个收到的事件计数。
  // 注册早于 setupLiveShare 的连接 handler，确保限流先于业务监听器装载。
  const rateState: SocketRateState = {
    tokens: RATE_LIMIT_BUCKET_CAPACITY,
    lastRefillMs: Date.now(),
  };
  socket.onAny(() => {
    if (consumeRateToken(rateState, Date.now())) {
      return;
    }

    wsLogger.warn(
      {
        socketId: socket.id,
        clientIp: socket.data.clientIp,
      },
      'Socket exceeded message rate limit; disconnecting'
    );
    socket.disconnect(true);
  });

  socket.once('disconnect', () => {
    if (!socket.data.connectionTracked) {
      return;
    }

    decrementConnectionCount(socket.data.clientIp as string);
    socket.data.connectionTracked = false;

    wsLogger.info(
      {
        socketId: socket.id,
        clientIp: socket.data.clientIp,
      },
      'WebSocket client disconnected'
    );
  });
});

const teardownLiveShare = setupLiveShare(io);
startBillingMaintenanceLoop();
startCloudreveTokenRefreshLoop();
startAudioEnhanceLoop();

httpServer.listen(PORT, () => {
  wsLogger.info({ port: PORT }, 'WebSocket server listening');
});

async function shutdown(signal: string) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  wsLogger.info({ signal }, 'Starting websocket server shutdown');
  stopBillingMaintenanceLoop();
  stopCloudreveTokenRefreshLoop();
  stopAudioEnhanceLoop();
  // 清掉直播分享的 TTL 清扫定时器 / host 下线宽限计时并清空内存快照，
  // 避免优雅关停时残留模块级定时器阻碍进程干净退出。
  teardownLiveShare();

  io.emit('status_update', { status: 'SERVER_SHUTDOWN' });

  const forceCloseTimer = setTimeout(() => {
    wsLogger.warn(
      { timeoutMs: SHUTDOWN_TIMEOUT_MS },
      'Forcing websocket connections to close'
    );
    io.disconnectSockets(true);
    httpServer.closeAllConnections?.();
  }, SHUTDOWN_TIMEOUT_MS);
  forceCloseTimer.unref?.();

  try {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    connectionsByIp.clear();
    clearTimeout(forceCloseTimer);
    wsLogger.info({ signal }, 'WebSocket server stopped cleanly');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceCloseTimer);
    wsLogger.error(
      { signal, err: serializeError(error) },
      'WebSocket server shutdown failed'
    );
    process.exit(1);
  }
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('unhandledRejection', (reason) => {
  wsLogger.error(
    { err: serializeError(reason) },
    'Unhandled promise rejection in websocket server'
  );
});

process.on('uncaughtException', (error) => {
  wsLogger.error(
    { err: serializeError(error) },
    'Uncaught exception in websocket server'
  );
  void shutdown('uncaughtException');
});
