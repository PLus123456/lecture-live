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
import { logger, serializeError } from '../src/lib/logger';

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const MAX_CONNECTIONS_PER_IP = 50;
const MAX_MESSAGE_SIZE_BYTES = 100 * 1024;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const connectionsByIp = new Map<string, number>();
const wsLogger = logger.child({ component: 'websocket-server' });
let isShuttingDown = false;

function resolveClientIp(socket: Socket) {
  if (shouldTrustProxyHeaders()) {
    const forwardedFor = socket.handshake.headers['x-forwarded-for'];
    const forwardedIp =
      typeof forwardedFor === 'string'
        ? getTrustedForwardedIp(forwardedFor)
        : null;
    if (forwardedIp) {
      return forwardedIp;
    }

    const realIp = socket.handshake.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
      return realIp.trim();
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

setupLiveShare(io);
startBillingMaintenanceLoop();

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
