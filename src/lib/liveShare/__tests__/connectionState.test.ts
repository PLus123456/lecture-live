// M2：两个客户端类此前**完全没有** connect_error / disconnect / connect_failed
// 监听，故障一律静默：
//   - 观众端在 WS 不可达 / Origin 被拒（server/websocket.ts:io.use）/ 每 IP 连接数
//     上限时，loading spinner 永久悬挂；
//   - 主播端在 WS 进程崩溃时 UI 继续显示「直播中」，数据静默丢失；
//   - 服务端优雅关停广播的 SERVER_SHUTDOWN 全仓零消费。
//
// 这里用**真的 socket.io 服务**驱动三种真实故障形态，断言连接态确实被上报。
// 关键分界：socket.active === false 才是终态（服务端踢人 / 中间件拒绝），
// 传输层抖动必须只报 reconnecting —— 把瞬断当终态会把一次 Wi-Fi 切换升级成
// 「直播被掐断 + 链接被撤销」。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import type { Socket } from 'socket.io-client';

import { LiveViewer } from '@/lib/liveShare/viewer';
import { LiveBroadcaster } from '@/lib/liveShare/broadcaster';

type Report = { state: string; info?: { reason?: string; message?: string } };

function noopViewerCallbacks(onConnectionChange: (state: string, info?: unknown) => void) {
  return {
    onInitialState: vi.fn(),
    onTranscriptDelta: vi.fn(),
    onTranslationDelta: vi.fn(),
    onSummaryUpdate: vi.fn(),
    onStatusUpdate: vi.fn(),
    onPreviewUpdate: vi.fn(),
    onError: vi.fn(),
    onConnectionChange: onConnectionChange as never,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

describe('M2：直播客户端的连接态上报', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  const viewers: LiveViewer[] = [];
  const broadcasters: LiveBroadcaster[] = [];

  beforeEach(async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const viewer of viewers) viewer.disconnect();
    viewers.length = 0;
    for (const broadcaster of broadcasters) broadcaster.disconnect();
    broadcasters.length = 0;
    await new Promise<void>((resolve) => {
      io.close(() => httpServer.close(() => resolve()));
    });
  });

  function newViewer(reports: Report[]) {
    const viewer = new LiveViewer();
    viewers.push(viewer);
    viewer.connect(
      baseUrl,
      'share-token',
      noopViewerCallbacks((state, info) =>
        reports.push({ state, info: info as Report['info'] })
      )
    );
    return viewer;
  }

  function rawSocketOf(instance: LiveViewer | LiveBroadcaster): Socket {
    return (instance as unknown as { socket: Socket }).socket;
  }

  it('观众：握手被中间件拒绝（Origin / 每 IP 上限）→ closed + 原因，而不是永久 spinner', async () => {
    io.use((_socket, next) => next(new Error('Too many connections from this IP')));

    const reports: Report[] = [];
    newViewer(reports);

    await waitFor(() => reports.some((r) => r.state === 'closed'));
    const closed = reports.find((r) => r.state === 'closed');
    expect(closed?.info?.message).toBe('Too many connections from this IP');
  });

  it('观众：服务端主动踢（撤销驱逐走的就是 disconnect(true)）→ closed', async () => {
    io.on('connection', (socket) => {
      socket.disconnect(true);
    });

    const reports: Report[] = [];
    newViewer(reports);

    await waitFor(() => reports.some((r) => r.state === 'closed'));
    expect(reports.map((r) => r.state)).toContain('connecting');
    expect(reports.find((r) => r.state === 'closed')?.info?.reason).toBe(
      'io server disconnect'
    );
  });

  it('观众：传输层抖动只报 reconnecting（socket.io 会自己回来，不该当成终态）', async () => {
    const reports: Report[] = [];
    const viewer = newViewer(reports);

    await waitFor(() => reports.some((r) => r.state === 'connected'));
    rawSocketOf(viewer).io.engine.close();

    await waitFor(() => reports.some((r) => r.state === 'reconnecting'));
    expect(reports.some((r) => r.state === 'closed')).toBe(false);
  });

  it('观众：调用方主动 disconnect() 不上报任何连接态（离开页面不是故障）', async () => {
    const reports: Report[] = [];
    const viewer = newViewer(reports);

    await waitFor(() => reports.some((r) => r.state === 'connected'));
    viewer.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(reports.some((r) => r.state === 'closed')).toBe(false);
  });

  it('主播：服务端主动踢 → closed（此前 UI 会一直显示「直播中」）', async () => {
    io.on('connection', (socket) => {
      socket.disconnect(true);
    });

    const reports: Report[] = [];
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'jwt',
      shareToken: 'share-token',
      callbacks: {
        onConnectionChange: (state, info) => reports.push({ state, info }),
      },
    });
    broadcasters.push(broadcaster);

    await waitFor(() => reports.some((r) => r.state === 'closed'));
    expect(reports.find((r) => r.state === 'closed')?.info?.reason).toBe(
      'io server disconnect'
    );
  });

  it('主播：SERVER_SHUTDOWN 广播被消费为 reconnecting（此前全仓零引用）', async () => {
    io.on('connection', (socket) => {
      socket.emit('status_update', { status: 'SERVER_SHUTDOWN' });
    });

    const reports: Report[] = [];
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'jwt',
      shareToken: 'share-token',
      callbacks: {
        onConnectionChange: (state, info) => reports.push({ state, info }),
      },
    });
    broadcasters.push(broadcaster);

    await waitFor(() =>
      reports.some(
        (r) => r.state === 'reconnecting' && r.info?.reason === 'server_shutdown'
      )
    );
  });

  it('主播：调用方主动 disconnect() 不上报 closed（否则会误撤 keepForPlayback 的回放链接）', async () => {
    const reports: Report[] = [];
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'jwt',
      shareToken: 'share-token',
      callbacks: {
        onConnectionChange: (state, info) => reports.push({ state, info }),
      },
    });
    broadcasters.push(broadcaster);

    await waitFor(() => reports.some((r) => r.state === 'connected'));
    broadcaster.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(reports.some((r) => r.state === 'closed')).toBe(false);
  });
});
