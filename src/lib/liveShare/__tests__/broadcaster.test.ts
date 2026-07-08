// C16/U11：验证 LiveBroadcaster 客户端在（重）连时补发最近一次快照。
// 直播中途开分享时，服务端 sync_snapshot 监听器要等 authenticateBroadcaster 之后
// 才注册；首帧快照若在监听器就位前到达会被丢弃 → 晚加入观众丢失开分享前的历史。
// 修法：broadcaster 缓存最近一次 syncSnapshot 的 payload，并在底层 socket 每次
// 'connect'（含自动重连）时补发。此处用真实 socket.io 服务 + 真实 LiveBroadcaster，
// 断言：连上后新 viewer 能拿到快照；主播重连后仍能对齐服务端内存（新 viewer 拿到历史）。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';

const { shareLinkFindUniqueMock, verifyAuthTokenMock } = vi.hoisted(() => ({
  shareLinkFindUniqueMock: vi.fn(),
  verifyAuthTokenMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    shareLink: {
      findUnique: shareLinkFindUniqueMock,
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  CLIENT_SESSION_TOKEN: '__cookie_session__',
  extractTokenFromCookieHeader: vi.fn(() => null),
  verifyAuthToken: verifyAuthTokenMock,
}));

vi.mock('@/lib/logger', () => {
  const noop = vi.fn();
  return {
    logger: {
      child: () => ({
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
      }),
    },
    serializeError: (error: unknown) =>
      error instanceof Error ? { message: error.message } : { message: String(error) },
  };
});

import { setupLiveShare } from '@/lib/liveShare/server';
import { LiveBroadcaster } from '@/lib/liveShare/broadcaster';

describe('LiveBroadcaster 连接/重连补发快照（C16/U11）', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const broadcasters: LiveBroadcaster[] = [];
  const clients: Socket[] = [];

  beforeEach(async () => {
    verifyAuthTokenMock.mockResolvedValue({
      user: { id: 'user-1', email: 'alice@example.com', role: 'ADMIN' },
      token: { jti: 'jti-1', tokenVersion: 1 },
      rawToken: 'server-jwt',
    });

    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        if (token !== 'share-token') {
          return null;
        }
        return {
          id: 'link-1',
          token: 'share-token',
          sessionId: 'session-1',
          createdBy: 'user-1',
          isLive: true,
          expiresAt: null,
          session: { id: 'session-1', userId: 'user-1', status: 'RECORDING' },
        };
      }
    );

    httpServer = createServer();
    // 不限制 transports：LiveBroadcaster 用默认 socket.io 客户端（polling→websocket
    // 升级），服务端须同时接受 polling 才能握手（真实 websocket.ts 也未限制 transports）。
    io = new SocketIOServer(httpServer);
    teardownLiveShare = setupLiveShare(io);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const broadcaster of broadcasters) {
      broadcaster.disconnect();
    }
    broadcasters.length = 0;

    await Promise.all(
      clients.map((client) => {
        if (!client.connected) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          client.once('disconnect', () => resolve());
          client.disconnect();
        });
      })
    );
    clients.length = 0;

    teardownLiveShare();

    await new Promise<void>((resolve) => {
      io.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  const snapshot = {
    segments: [{ id: 'seg-1', text: 'Hello', start: 0, end: 1 }],
    translations: { 'seg-1': '你好' },
    summaryBlocks: [{ id: 'sum-1', blockIndex: 0, summary: 'Summary' }],
    status: 'RECORDING',
    previewText: { finalText: '', nonFinalText: '' },
    previewTranslation: {
      finalText: '',
      nonFinalText: '',
      state: 'idle' as const,
      sourceLanguage: null,
    },
  } as unknown as Parameters<LiveBroadcaster['syncSnapshot']>[0];

  // 获取 broadcaster 底层 socket 并等其（首次）建连。initial_state / viewer_count 会
  // 紧随 connect 到达，故不在此单独 await，避免与 connect 竞争（先 await connect 再
  // await initial_state 会漏掉已到达的 initial_state 导致挂起）。
  function rawSocketOf(broadcaster: LiveBroadcaster): Socket {
    return (broadcaster as unknown as { socket: Socket }).socket;
  }

  it('首连后 syncSnapshot 的快照可被晚加入 viewer 取到', async () => {
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'server-jwt',
      shareToken: 'share-token',
    });
    broadcasters.push(broadcaster);

    const raw = rawSocketOf(broadcaster);
    await onceSocketEvent(raw, 'connect');

    // 主播同步快照（正常路径）
    broadcaster.syncSnapshot(snapshot);

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const viewerStatePromise = onceSocketEvent<{
      segments: Array<{ id: string }>;
      translations: Record<string, string>;
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });

    const state = await viewerStatePromise;
    expect(state.segments).toEqual([
      { id: 'seg-1', text: 'Hello', start: 0, end: 1 },
    ]);
    expect(state.translations).toEqual({ 'seg-1': '你好' });
  });

  it('主播重连后自动补发最近快照，服务端内存被重新对齐（U11：新 viewer 仍拿到历史）', async () => {
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'server-jwt',
      shareToken: 'share-token',
    });
    broadcasters.push(broadcaster);

    const raw = rawSocketOf(broadcaster);
    await onceSocketEvent(raw, 'connect');

    broadcaster.syncSnapshot(snapshot);

    // 让服务端确实吃到首帧快照（避免与后续断连竞争）
    const settleViewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(settleViewer);
    await onceSocketEvent(settleViewer, 'connect');
    const settledPromise = onceSocketEvent<{ segments: unknown[] }>(
      settleViewer,
      'initial_state'
    );
    settleViewer.emit('join', { shareToken: 'share-token' });
    expect((await settledPromise).segments).toHaveLength(1);

    // 触发一次底层断连——socket.io-client 默认 reconnection:true，会自动重连并再次
    // 触发 'connect'，此时 broadcaster 应补发缓存快照。先挂上"重连后再次 connect"的
    // 监听，再断底层传输。engine.close() 会引发一次 disconnect + 自动重连。
    let reconnectCount = 0;
    const reconnected = new Promise<void>((resolve) => {
      raw.on('connect', () => {
        reconnectCount += 1;
        // 第一次 connect 已在上面 await 过；这里等的是重连那次。
        if (reconnectCount >= 1) {
          resolve();
        }
      });
    });
    raw.io.engine.close(); // 断掉底层传输，触发自动重连
    await reconnected;

    // 给重连后补发的 sync_snapshot 一点时间落到服务端内存
    await new Promise((r) => setTimeout(r, 200));

    // 重连补发后，全新 viewer join 仍能拿到完整历史（证明补发把服务端内存对齐）。
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const viewerStatePromise = onceSocketEvent<{
      segments: Array<{ id: string }>;
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });

    const state = await viewerStatePromise;
    expect(state.segments).toEqual([
      { id: 'seg-1', text: 'Hello', start: 0, end: 1 },
    ]);
  });

  it('从未 syncSnapshot 时连接不会误发快照（viewer 拿到空历史）', async () => {
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'server-jwt',
      shareToken: 'share-token',
    });
    broadcasters.push(broadcaster);

    const raw = rawSocketOf(broadcaster);
    await onceSocketEvent(raw, 'connect');

    // 没有缓存快照时，viewer join 应拿到空历史（loadPersistedSnapshot 回退空快照）
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const viewerStatePromise = onceSocketEvent<{ segments: unknown[] }>(
      viewer,
      'initial_state'
    );
    viewer.emit('join', { shareToken: 'share-token' });

    expect((await viewerStatePromise).segments).toEqual([]);
  });
});
