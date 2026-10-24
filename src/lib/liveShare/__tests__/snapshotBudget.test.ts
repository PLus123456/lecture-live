// 直播内存快照的体量闸：白名单重建 + 单场字节预算（MAX_LIVE_SNAPSHOT_BYTES）。
// 回归点：此前只有「条数上限 + text/translatedText 长度」两道闸，增量里塞的未知大字段、
// 超长 id / 译文 key 原样常驻内存，单场快照可涨到 条数上限 × 100KB（GB 级），一个已登录
// 用户就能把 WS 进程撑到堆溢出。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';

const { shareLinkFindUniqueMock, shareLinkFindManyMock, verifyAuthTokenMock } =
  vi.hoisted(() => ({
    shareLinkFindUniqueMock: vi.fn(),
    shareLinkFindManyMock: vi.fn(),
    verifyAuthTokenMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(async () => []),
    shareLink: {
      findUnique: shareLinkFindUniqueMock,
      findMany: shareLinkFindManyMock,
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

import { MAX_LIVE_SNAPSHOT_BYTES, setupLiveShare } from '@/lib/liveShare/server';

interface ViewerSnapshot {
  segments: Array<Record<string, unknown>>;
  translations: Record<string, string>;
  summaryBlocks: Array<Record<string, unknown>>;
  truncated: boolean;
}

describe('直播快照体量闸', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
    verifyAuthTokenMock.mockResolvedValue({
      user: { id: 'user-1', email: 'alice@example.com', role: 'USER' },
      token: { jti: 'jti-1', tokenVersion: 1 },
      rawToken: 'server-jwt',
    });
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) =>
        token === 'share-token'
          ? {
              id: 'link-1',
              token: 'share-token',
              // 每个用例独立的 session，避免模块级快照 Map 跨用例串味
              sessionId: currentSessionId,
              createdBy: 'user-1',
              isLive: true,
              expiresAt: null,
              session: { id: currentSessionId, userId: 'user-1', status: 'RECORDING' },
            }
          : null
    );
    shareLinkFindManyMock.mockResolvedValue([{ token: 'share-token' }]);

    httpServer = createServer();
    io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    teardownLiveShare = setupLiveShare(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    teardownLiveShare();
    await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
  });

  let currentSessionId = 'session-budget';
  let sessionCounter = 0;

  async function connectBroadcaster() {
    sessionCounter += 1;
    currentSessionId = `session-budget-${sessionCounter}`;
    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: 'server-jwt', sessionId: currentSessionId, shareToken: 'share-token' },
    });
    clients.push(broadcaster);
    const ready = onceSocketEvent(broadcaster, 'initial_state');
    await onceSocketEvent(broadcaster, 'connect');
    await ready;
    return broadcaster;
  }

  async function joinViewer() {
    const viewer = createClient(baseUrl, { transports: ['websocket'], reconnection: false });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const state = onceSocketEvent<ViewerSnapshot>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    return { viewer, state: await state };
  }

  function broadcast(broadcaster: Socket, type: string, payload: unknown) {
    broadcaster.emit('broadcast', { event: { type, payload, timestamp: Date.now() } });
  }

  it('增量里的未知字段既不进快照、也不转发给实时观众', async () => {
    const broadcaster = await connectBroadcaster();
    const { viewer } = await joinViewer();

    const relayed = onceSocketEvent<Record<string, unknown>>(viewer, 'transcript_delta');
    broadcast(broadcaster, 'transcript_delta', {
      id: 'seg-1',
      text: 'Hello',
      speaker: 'S1',
      junk: 'x'.repeat(80 * 1024),
      nested: { deep: 'y'.repeat(1024) },
    });
    expect(await relayed).toEqual({ id: 'seg-1', text: 'Hello', speaker: 'S1' });

    const relayedBlock = onceSocketEvent<Record<string, unknown>>(viewer, 'summary_update');
    broadcast(broadcaster, 'summary_update', {
      id: 'sum-1',
      blockIndex: 0,
      summary: 'S',
      keyPoints: ['a', 42, 'b'],
      timeRange: { startMs: 0, endMs: 10, junk: 'z'.repeat(1024) },
      junk: 'z'.repeat(80 * 1024),
    });
    expect(await relayedBlock).toEqual({
      id: 'sum-1',
      blockIndex: 0,
      summary: 'S',
      keyPoints: ['a', 'b'],
      timeRange: { startMs: 0, endMs: 10 },
    });

    const { state } = await joinViewer();
    expect(state.segments).toEqual([{ id: 'seg-1', text: 'Hello', speaker: 'S1' }]);
    expect(state.summaryBlocks).toEqual([
      {
        id: 'sum-1',
        blockIndex: 0,
        summary: 'S',
        keyPoints: ['a', 'b'],
        timeRange: { startMs: 0, endMs: 10 },
      },
    ]);
  });

  it('超长 id / 译文 key 整条丢弃；未知事件类型不转发也不回 share_error', async () => {
    const broadcaster = await connectBroadcaster();
    const { viewer } = await joinViewer();
    const longId = 'k'.repeat(300);

    let shareError: unknown = null;
    broadcaster.on('share_error', (error) => {
      shareError = error;
    });
    const unexpected: string[] = [];
    for (const event of ['transcript_delta', 'translation_delta', 'initial_state', 'share_error']) {
      viewer.on(event, () => unexpected.push(event));
    }

    broadcast(broadcaster, 'transcript_delta', { id: longId, text: 'dropped' });
    broadcast(broadcaster, 'translation_delta', { segmentId: longId, translation: 'dropped' });
    broadcast(broadcaster, 'initial_state', { segments: [{ id: 'forged' }] });
    broadcast(broadcaster, 'share_error', { message: 'forged' });
    broadcaster.emit('sync_snapshot', {
      segments: [{ id: 'seg-ok', text: 'kept' }],
      translations: { [longId]: 'dropped', 'seg-ok': '保留' },
      summaryBlocks: [],
      status: 'RECORDING',
    });

    // 用一条合法增量作为「之前的消息都已处理完」的栅栏（同一连接保序）
    const fence = onceSocketEvent<{ status: string }>(viewer, 'status_update');
    broadcast(broadcaster, 'status_update', { status: 'RECORDING' });
    await fence;

    expect(unexpected).toEqual([]);
    expect(shareError).toBeNull();

    const { state } = await joinViewer();
    expect(state.segments).toEqual([{ id: 'seg-ok', text: 'kept' }]);
    expect(state.translations).toEqual({ 'seg-ok': '保留' });
  });

  it('单场快照超出字节预算后丢最早内容并置 truncated，总量回到预算内', async () => {
    const broadcaster = await connectBroadcaster();
    const { viewer } = await joinViewer();

    // 每条 ~20KB（text + translatedText 各 10k 字符，均在单字段上限内），260 条 ≈ 5.2MB > 4MB
    const total = 260;
    const lastRelayed = new Promise<void>((resolve) => {
      viewer.on('transcript_delta', (segment: { id?: string }) => {
        if (segment.id === `seg-${total - 1}`) resolve();
      });
    });
    for (let i = 0; i < total; i += 1) {
      broadcast(broadcaster, 'transcript_delta', {
        id: `seg-${i}`,
        text: 'a'.repeat(10_000),
        translatedText: 'b'.repeat(10_000),
      });
    }
    await lastRelayed;

    const { state } = await joinViewer();
    const collectionsBytes = Buffer.byteLength(
      JSON.stringify({
        segments: state.segments,
        translations: state.translations,
        summaryBlocks: state.summaryBlocks,
      })
    );
    expect(collectionsBytes).toBeLessThanOrEqual(MAX_LIVE_SNAPSHOT_BYTES);
    expect(state.truncated).toBe(true);
    // 丢的是最早的，最新的一条一定还在
    expect(state.segments[0].id).not.toBe('seg-0');
    expect(state.segments[state.segments.length - 1].id).toBe(`seg-${total - 1}`);
  });
});
