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

import {
  revalidateAllLiveRooms,
  revalidateSessionViewers,
  setupLiveShare,
} from '@/lib/liveShare/server';

describe('setupLiveShare', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
    verifyAuthTokenMock.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
      token: {
        jti: 'jti-1',
        tokenVersion: 1,
      },
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
          session: {
            id: 'session-1',
            userId: 'user-1',
            status: 'RECORDING',
          },
        };
      }
    );

    // 观众复核（SHARE-REVOKE-001）用 findMany 查仍然有效的 token；默认与
    // findUnique 一致——share-token 有效。撤销类用例内再覆盖为失效。
    shareLinkFindManyMock.mockResolvedValue([{ token: 'share-token' }]);

    httpServer = createServer();
    io = new SocketIOServer(httpServer, {
      transports: ['websocket'],
    });
    teardownLiveShare = setupLiveShare(io);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
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

    // 清掉 U61 的清扫定时器与 C3/U11 的宽限计时并清空模块级快照 Map，
    // 避免跨用例泄漏（否则残留快照/定时器会污染下一用例的连接）。
    teardownLiveShare();

    await new Promise<void>((resolve) => {
      io.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  it('让 broadcaster 同步快照并向 viewer 广播增量事件', async () => {
    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);

    await onceSocketEvent(broadcaster, 'connect');
    const broadcasterInitialState = await onceSocketEvent<{
      status: string | null;
      segments: unknown[];
    }>(broadcaster, 'initial_state');

    expect(broadcasterInitialState).toMatchObject({
      status: null,
      segments: [],
    });

    broadcaster.emit('sync_snapshot', {
      segments: [{ id: 'seg-1', text: 'Hello' }],
      translations: { 'seg-1': '你好' },
      summaryBlocks: [{ id: 'sum-1', text: 'Summary' }],
      status: 'RECORDING',
      previewText: { finalText: 'He', nonFinalText: 'l' },
      previewTranslation: {
        finalText: '',
        nonFinalText: '你',
        state: 'streaming',
        sourceLanguage: 'en',
      },
    });

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const viewerInitialStatePromise = onceSocketEvent<{
      segments: Array<{ id: string; text: string }>;
      translations: Record<string, string>;
      summaryBlocks: Array<{ id: string; text: string }>;
      status: string | null;
      previewText: { finalText: string; nonFinalText: string };
      previewTranslation: {
        finalText: string;
        nonFinalText: string;
        state: string;
        sourceLanguage: string | null;
      };
    }>(viewer, 'initial_state');
    const viewerCountPromise = onceSocketEvent<{ count: number }>(
      broadcaster,
      'viewer_count'
    );
    viewer.emit('join', { shareToken: 'share-token' });

    await expect(viewerCountPromise).resolves.toEqual({ count: 1 });
    await expect(viewerInitialStatePromise).resolves.toMatchObject({
      segments: [{ id: 'seg-1', text: 'Hello' }],
      translations: { 'seg-1': '你好' },
      summaryBlocks: [{ id: 'sum-1', text: 'Summary' }],
      status: 'RECORDING',
      previewText: { finalText: 'He', nonFinalText: 'l' },
      previewTranslation: {
        finalText: '',
        nonFinalText: '你',
        state: 'streaming',
        sourceLanguage: 'en',
      },
    });

    const transcriptDeltaPromise = onceSocketEvent<{ id: string; text: string }>(
      viewer,
      'transcript_delta'
    );
    broadcaster.emit('broadcast', {
      event: {
        type: 'transcript_delta',
        payload: { id: 'seg-2', text: 'World' },
        timestamp: Date.now(),
      },
    });

    await expect(transcriptDeltaPromise).resolves.toEqual({
      id: 'seg-2',
      text: 'World',
    });
  });

  it('sync_snapshot 过滤非字符串翻译并截断超长翻译', async () => {
    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);

    await onceSocketEvent(broadcaster, 'connect');
    await onceSocketEvent(broadcaster, 'initial_state');

    const longTranslation = 'x'.repeat(10_050);
    broadcaster.emit('sync_snapshot', {
      segments: [{ id: 'seg-1', text: 'Hello' }],
      translations: {
        'seg-1': longTranslation, // 超长 → 截断到 10000
        'seg-2': 12345, // 非字符串 → 过滤
        'seg-3': '正常翻译', // 合法 → 保留
      },
      summaryBlocks: [],
      status: 'RECORDING',
    });

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const viewerInitialStatePromise = onceSocketEvent<{
      translations: Record<string, string>;
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });

    const state = await viewerInitialStatePromise;
    expect(state.translations['seg-1']?.length).toBe(10_000);
    expect(state.translations['seg-2']).toBeUndefined();
    expect(state.translations['seg-3']).toBe('正常翻译');
  });

  it('sync_snapshot 截断超长 segment.text 与 summary 各字符串字段', async () => {
    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);

    await onceSocketEvent(broadcaster, 'connect');
    await onceSocketEvent(broadcaster, 'initial_state');

    const longText = 'a'.repeat(10_050);
    broadcaster.emit('sync_snapshot', {
      segments: [{ id: 'seg-1', text: longText, translatedText: longText }],
      translations: {},
      summaryBlocks: [
        {
          id: 'sum-1',
          summary: longText,
          keyPoints: [longText, 'short'],
          definitions: { term: longText, ok: '短' },
          suggestedQuestions: [longText],
        },
      ],
      status: 'RECORDING',
    });

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const viewerInitialStatePromise = onceSocketEvent<{
      segments: Array<{ text: string; translatedText: string }>;
      summaryBlocks: Array<{
        summary: string;
        keyPoints: string[];
        definitions: Record<string, string>;
        suggestedQuestions: string[];
      }>;
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });

    const state = await viewerInitialStatePromise;
    expect(state.segments[0].text.length).toBe(10_000);
    expect(state.segments[0].translatedText.length).toBe(10_000);
    expect(state.summaryBlocks[0].summary.length).toBe(10_000);
    expect(state.summaryBlocks[0].keyPoints[0].length).toBe(10_000);
    expect(state.summaryBlocks[0].keyPoints[1]).toBe('short');
    expect(state.summaryBlocks[0].definitions.term.length).toBe(10_000);
    expect(state.summaryBlocks[0].definitions.ok).toBe('短');
    expect(state.summaryBlocks[0].suggestedQuestions[0].length).toBe(10_000);
  });

  it('broadcast 增量路径截断超长 segment.text 与 summary 字段', async () => {
    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);

    await onceSocketEvent(broadcaster, 'connect');
    await onceSocketEvent(broadcaster, 'initial_state');

    const longText = 'b'.repeat(10_050);
    broadcaster.emit('broadcast', {
      event: {
        type: 'transcript_delta',
        payload: { id: 'seg-1', text: longText },
        timestamp: Date.now(),
      },
    });
    broadcaster.emit('broadcast', {
      event: {
        type: 'summary_update',
        payload: {
          id: 'sum-1',
          blockIndex: 0,
          summary: longText,
          keyPoints: [longText],
          definitions: { term: longText },
        },
        timestamp: Date.now(),
      },
    });

    // 新 viewer join 后会收到累积快照（含上述两条增量），断言其已被截断
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const viewerInitialStatePromise = onceSocketEvent<{
      segments: Array<{ text: string }>;
      summaryBlocks: Array<{
        summary: string;
        keyPoints: string[];
        definitions: Record<string, string>;
      }>;
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });

    const state = await viewerInitialStatePromise;
    expect(state.segments[0].text.length).toBe(10_000);
    expect(state.summaryBlocks[0].summary.length).toBe(10_000);
    expect(state.summaryBlocks[0].keyPoints[0].length).toBe(10_000);
    expect(state.summaryBlocks[0].definitions.term.length).toBe(10_000);
  });

  it('阻止 viewer 冒充 broadcaster 发布事件', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    viewer.emit('join', { shareToken: 'share-token' });
    await onceSocketEvent(viewer, 'initial_state');

    const errorPromise = onceSocketEvent<{ message: string }>(viewer, 'share_error');
    viewer.emit('broadcast', {
      event: {
        type: 'status_update',
        payload: { status: 'RECORDING' },
        timestamp: Date.now(),
      },
    });

    await expect(errorPromise).resolves.toEqual({
      message: 'Only the broadcaster may publish events',
    });
  });

  it('C3：broadcaster（重）连成功时向房间内既有 viewer 广播 SHARE_LIVE', async () => {
    // 先让 viewer 连上并 join，此时房间里只有 viewer（模拟主播瞬断后观众仍在）
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    viewer.emit('join', { shareToken: 'share-token' });
    await onceSocketEvent(viewer, 'initial_state');

    // 主播（重）连——viewer 应收到 SHARE_LIVE，用于把误锁的"已结束"态恢复为实时
    const liveStatusPromise = onceSocketEvent<{ status: string }>(
      viewer,
      'status_update'
    );
    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);

    await expect(liveStatusPromise).resolves.toEqual({ status: 'SHARE_LIVE' });
  });

  it('C3/U11：broadcaster 断开后进入宽限期，快照不被立即回收（新 viewer 仍拿到历史）', async () => {
    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);

    await onceSocketEvent(broadcaster, 'connect');
    await onceSocketEvent(broadcaster, 'initial_state');

    broadcaster.emit('sync_snapshot', {
      segments: [{ id: 'seg-1', text: 'Hello' }],
      translations: {},
      summaryBlocks: [],
      status: 'RECORDING',
    });

    // 先用一个 viewer join 确认快照已被服务端处理（避免 sync_snapshot 与后续
    // disconnect 竞争导致断言不确定）。
    const settleViewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(settleViewer);
    await onceSocketEvent(settleViewer, 'connect');
    const settledStatePromise = onceSocketEvent<{
      segments: Array<{ id: string; text: string }>;
    }>(settleViewer, 'initial_state');
    settleViewer.emit('join', { shareToken: 'share-token' });
    expect((await settledStatePromise).segments).toEqual([
      { id: 'seg-1', text: 'Hello' },
    ]);

    // 主播断开（瞬断）——不应立即删快照，而是进入宽限期
    await new Promise<void>((resolve) => {
      broadcaster.once('disconnect', () => resolve());
      broadcaster.disconnect();
    });

    // 宽限期内新 viewer join：仍能拿到主播断开前同步的历史（快照未被回收）
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const initialStatePromise = onceSocketEvent<{
      segments: Array<{ id: string; text: string }>;
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });

    const state = await initialStatePromise;
    expect(state.segments).toEqual([{ id: 'seg-1', text: 'Hello' }]);
  });

  it('在无效分享 token 时返回 join 错误', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const errorPromise = onceSocketEvent<{ message: string }>(viewer, 'share_error');
    viewer.emit('join', { shareToken: 'invalid-token' });

    await expect(errorPromise).resolves.toEqual({
      message: 'Invalid or expired share link',
    });
  });

  it('SHARE-REVOKE-001：复核驱逐持已撤销 token 的观众，保留合法观众与主播', async () => {
    // 两个 token 同属 session-1，join 时都有效
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        if (token !== 'share-token' && token !== 'revoked-token') {
          return null;
        }

        return {
          id: token === 'share-token' ? 'link-1' : 'link-2',
          token,
          sessionId: 'session-1',
          createdBy: 'user-1',
          isLive: true,
          expiresAt: null,
          session: {
            id: 'session-1',
            userId: 'user-1',
            status: 'RECORDING',
          },
        };
      }
    );

    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);
    await onceSocketEvent(broadcaster, 'connect');
    await onceSocketEvent(broadcaster, 'initial_state');

    const legitViewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(legitViewer);
    await onceSocketEvent(legitViewer, 'connect');
    const legitInitialState = onceSocketEvent(legitViewer, 'initial_state');
    legitViewer.emit('join', { shareToken: 'share-token' });
    await legitInitialState;

    const revokedViewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(revokedViewer);
    await onceSocketEvent(revokedViewer, 'connect');
    const revokedInitialState = onceSocketEvent(revokedViewer, 'initial_state');
    revokedViewer.emit('join', { shareToken: 'revoked-token' });
    await revokedInitialState;

    // 撤销 revoked-token：DB 复核只承认 share-token 仍有效
    shareLinkFindManyMock.mockResolvedValue([{ token: 'share-token' }]);

    const revokedErrorPromise = onceSocketEvent<{ message: string; code?: string }>(
      revokedViewer,
      'share_error'
    );
    const revokedDisconnectPromise = onceSocketEvent<string>(
      revokedViewer,
      'disconnect'
    );
    // join 时的 count:2 广播可能仍在途中，等待驱逐后的 count 降到 1（而非只取
    // 下一个事件）以避免时序竞态。
    const viewerCountDroppedPromise = new Promise<void>((resolve) => {
      const handler = ({ count }: { count: number }) => {
        if (count === 1) {
          legitViewer.off('viewer_count', handler);
          resolve();
        }
      };
      legitViewer.on('viewer_count', handler);
    });

    const evicted = await revalidateSessionViewers(io, 'session-1');

    expect(evicted).toBe(1);
    await expect(revokedErrorPromise).resolves.toEqual({
      message: 'Share link revoked',
      code: 'SHARE_REVOKED',
    });
    // 服务端主动断开：socket.io 客户端对该 reason 不会自动重连
    await expect(revokedDisconnectPromise).resolves.toBe('io server disconnect');
    // 驱逐后向房间广播了更新的观众数（只剩合法观众）
    await viewerCountDroppedPromise;
    expect(legitViewer.connected).toBe(true);
    expect(broadcaster.connected).toBe(true);

    // 复核查询按本 session + 仍在有效期的 live 链接过滤
    expect(shareLinkFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sessionId: 'session-1',
          isLive: true,
          token: { in: expect.arrayContaining(['share-token', 'revoked-token']) },
        }),
      })
    );
  });

  it('SHARE-REVOKE-001：token 仍有效时复核不驱逐（重放/误触发安全）', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;

    const evicted = await revalidateSessionViewers(io, 'session-1');

    expect(evicted).toBe(0);
    expect(viewer.connected).toBe(true);
  });

  it('SHARE-REVOKE-001：transition 模式静默断开，不发 share_error', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;

    const shareErrorSpy = vi.fn();
    viewer.on('share_error', shareErrorSpy);
    const disconnectPromise = onceSocketEvent<string>(viewer, 'disconnect');

    shareLinkFindManyMock.mockResolvedValue([]);
    const evicted = await revalidateSessionViewers(io, 'session-1', {
      silent: true,
    });

    expect(evicted).toBe(1);
    await expect(disconnectPromise).resolves.toBe('io server disconnect');
    expect(shareErrorSpy).not.toHaveBeenCalled();
  });

  it('SHARE-REVOKE-001：revalidateAllLiveRooms 扫描所有 live 房间并驱逐失效观众', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;

    const disconnectPromise = onceSocketEvent<string>(viewer, 'disconnect');

    shareLinkFindManyMock.mockResolvedValue([]);
    await revalidateAllLiveRooms(io);

    await expect(disconnectPromise).resolves.toBe('io server disconnect');
  });
});
