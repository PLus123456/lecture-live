// H1 回归护栏（真传输层）：超大 sync_snapshot 曾经把直播打成死循环。
//
// 事故链：server/websocket.ts 的 maxHttpBufferSize=100KB → engine.io 原样传给 ws 的
// maxPayload → 超限帧被 receiver 以 close 1009 直接销毁连接 → socket.io-client 自动
// 重连 → broadcaster 的 'connect' 回调无条件补发**同一份**超限快照 → 再被杀 → 无限
// 循环。服务端 server.ts 里的 MAX_SNAPSHOT_SEGMENTS 截断在传输层之后，永远执行不到。
//
// 本文件用**真的 socket.io 服务 + 真的 100KB 上限**（与 server/websocket.ts 逐字
// 一致）跑：
//   1) 对照组坐实机理：不分块地直接推一份超限快照，连接确实会被杀；
//   2) 主路径：LiveBroadcaster 推同样大的快照，连接存活、晚加入的观众拿到完整历史；
//   3) 重连补发同样不会把连接打死（原 bug 的死循环入口）。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';

// server/websocket.ts:29 —— 必须与生产逐字一致，否则这条护栏形同虚设
const MAX_MESSAGE_SIZE_BYTES = 100 * 1024;

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
      child: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    },
    serializeError: (error: unknown) =>
      error instanceof Error ? { message: error.message } : { message: String(error) },
  };
});

import { setupLiveShare } from '@/lib/liveShare/server';
import { LiveBroadcaster } from '@/lib/liveShare/broadcaster';
import { jsonByteLength } from '@/lib/liveShare/snapshotChunking';

const SEGMENT_COUNT = 1_200;

function buildLargeSnapshot() {
  const segments = [];
  const translations: Record<string, string> = {};
  for (let i = 0; i < SEGMENT_COUNT; i += 1) {
    segments.push({
      id: `seg-${i}`,
      index: i,
      text: `讲课内容片段 ${i} ${'x'.repeat(180)}`,
      translatedText: `translated ${i} ${'y'.repeat(180)}`,
      startMs: i * 5_000,
      endMs: i * 5_000 + 4_800,
    });
    translations[`seg-${i}`] = `译文 ${i} ${'z'.repeat(120)}`;
  }

  return {
    segments,
    translations,
    summaryBlocks: [{ id: 'sum-1', blockIndex: 0, summary: '摘要' }],
    status: 'RECORDING',
    previewText: { finalText: '', nonFinalText: '' },
    previewTranslation: {
      finalText: '',
      nonFinalText: '',
      state: 'idle' as const,
      sourceLanguage: null,
    },
  } as unknown as Parameters<LiveBroadcaster['syncSnapshot']>[0];
}

describe('H1：超大 sync_snapshot 不再打死直播连接', () => {
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
        if (token !== 'share-token') return null;
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
    io = new SocketIOServer(httpServer, {
      // 与 server/websocket.ts 同款配置：这条上限就是 H1 的凶器
      maxHttpBufferSize: MAX_MESSAGE_SIZE_BYTES,
    });
    teardownLiveShare = setupLiveShare(io);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const broadcaster of broadcasters) broadcaster.disconnect();
    broadcasters.length = 0;

    await Promise.all(
      clients.map((client) => {
        if (!client.connected) return Promise.resolve();
        return new Promise<void>((resolve) => {
          client.once('disconnect', () => resolve());
          client.disconnect();
        });
      })
    );
    clients.length = 0;

    teardownLiveShare();
    await new Promise<void>((resolve) => {
      io.close(() => httpServer.close(() => resolve()));
    });
  });

  function rawSocketOf(broadcaster: LiveBroadcaster): Socket {
    return (broadcaster as unknown as { socket: Socket }).socket;
  }

  /** 反复 join 直到服务端内存里的快照达到期望条数（跨 socket 到达顺序不确定）。 */
  async function readSnapshotViaViewer(expectedSegments: number) {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');

    let state: { segments: unknown[]; translations: Record<string, string> } = {
      segments: [],
      translations: {},
    };
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const pending = onceSocketEvent<typeof state>(viewer, 'initial_state');
      viewer.emit('join', { shareToken: 'share-token' });
      state = await pending;
      if (state.segments.length >= expectedSegments) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return state;
  }

  it('对照组：不分块地直推超限快照，传输层确实会杀掉连接（H1 的死循环入口）', async () => {
    const snapshot = buildLargeSnapshot();
    expect(jsonByteLength(snapshot)).toBeGreaterThan(MAX_MESSAGE_SIZE_BYTES);

    const raw = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(raw);
    await onceSocketEvent(raw, 'connect');

    const disconnected = onceSocketEvent<string>(raw, 'disconnect');
    raw.emit('sync_snapshot', snapshot);

    await expect(disconnected).resolves.toBeTruthy();
    expect(raw.connected).toBe(false);
  }, 20_000);

  it('主路径：LiveBroadcaster 推同样大的快照，连接存活且观众拿到完整历史', async () => {
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'server-jwt',
      shareToken: 'share-token',
    });
    broadcasters.push(broadcaster);

    const raw = rawSocketOf(broadcaster);
    await onceSocketEvent(raw, 'connect');
    const initialSocketId = raw.id;

    broadcaster.syncSnapshot(buildLargeSnapshot());

    const state = await readSnapshotViaViewer(SEGMENT_COUNT);

    expect(state.segments).toHaveLength(SEGMENT_COUNT);
    expect((state.segments[0] as { id: string }).id).toBe('seg-0');
    expect((state.segments.at(-1) as { id: string }).id).toBe(
      `seg-${SEGMENT_COUNT - 1}`
    );
    expect(Object.keys(state.translations)).toHaveLength(SEGMENT_COUNT);

    // 连接从未被 1009 杀掉重连：socket id 不变、仍在连接中
    expect(raw.connected).toBe(true);
    expect(raw.id).toBe(initialSocketId);
  }, 30_000);

  it('连接建立前调用 syncSnapshot 依然送达（不再靠 socket.io 的 sendBuffer 冲刷）', async () => {
    // 主播页在 startSharing 之后立刻 syncSnapshot，那一刻 socket 通常还没连上。
    // 修复后我们**不再**把整包丢进 sendBuffer（它会在 'connect' 时以未分块的形态
    // 被冲出去，正好踩回 1009 陷阱），改为只缓存、由 'connect' 回调分块补发。
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'server-jwt',
      shareToken: 'share-token',
    });
    broadcasters.push(broadcaster);

    const raw = rawSocketOf(broadcaster);
    expect(raw.connected).toBe(false);
    broadcaster.syncSnapshot(buildLargeSnapshot());

    const state = await readSnapshotViaViewer(SEGMENT_COUNT);
    expect(state.segments).toHaveLength(SEGMENT_COUNT);
    expect(raw.connected).toBe(true);
  }, 30_000);

  it('重连补发同样安全：断底层传输后自动重连，快照重新对齐且连接不被打死', async () => {
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'server-jwt',
      shareToken: 'share-token',
    });
    broadcasters.push(broadcaster);

    const raw = rawSocketOf(broadcaster);
    await onceSocketEvent(raw, 'connect');
    broadcaster.syncSnapshot(buildLargeSnapshot());
    await readSnapshotViaViewer(SEGMENT_COUNT);

    const reconnected = new Promise<void>((resolve) => {
      raw.once('connect', () => resolve());
    });
    raw.io.engine.close();
    await reconnected;

    const state = await readSnapshotViaViewer(SEGMENT_COUNT);
    expect(state.segments).toHaveLength(SEGMENT_COUNT);
    expect(raw.connected).toBe(true);
  }, 40_000);
});
