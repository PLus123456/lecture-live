import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';
import {
  makeSummaryBlock,
  makeTranscriptSegment,
} from './fixtures';

const {
  shareLinkFindUniqueMock,
  shareLinkFindManyMock,
  verifyAuthTokenMock,
  diagnoseEstablishedAuthFamilyTokenMock,
} =
  vi.hoisted(() => ({
    shareLinkFindUniqueMock: vi.fn(),
    shareLinkFindManyMock: vi.fn(),
    verifyAuthTokenMock: vi.fn(),
    diagnoseEstablishedAuthFamilyTokenMock: vi.fn(),
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
  diagnoseEstablishedAuthFamilyToken: diagnoseEstablishedAuthFamilyTokenMock,
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
  revalidateSessionBroadcasters,
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
    const authenticatedSession = {
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
    };
    verifyAuthTokenMock.mockResolvedValue(authenticatedSession);
    diagnoseEstablishedAuthFamilyTokenMock.mockResolvedValue({
      status: 'valid',
      session: authenticatedSession,
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
      segments: [
        {
          ...makeTranscriptSegment(),
          ignoredNestedField: { attacker: 'must not persist' },
        },
      ],
      translations: { 'seg-1': '你好' },
      summaryBlocks: [makeSummaryBlock()],
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
      summaryBlocks: Array<{ id: string; summary: string }>;
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
    const viewerInitialState = await viewerInitialStatePromise;
    expect(viewerInitialState).toMatchObject({
      segments: [{ id: 'seg-1', text: 'Hello' }],
      translations: { 'seg-1': '你好' },
      summaryBlocks: [{ id: 'sum-1', summary: 'Summary' }],
      status: 'RECORDING',
      previewText: { finalText: 'He', nonFinalText: 'l' },
      previewTranslation: {
        finalText: '',
        nonFinalText: '你',
        state: 'streaming',
        sourceLanguage: 'en',
      },
    });
    expect(viewerInitialState.segments[0]).not.toHaveProperty(
      'ignoredNestedField'
    );

    const transcriptDeltaPromise = onceSocketEvent<{ id: string; text: string }>(
      viewer,
      'transcript_delta'
    );
    const secondSegment = makeTranscriptSegment({
      id: 'seg-2',
      text: 'World',
      globalStartMs: 1_000,
      globalEndMs: 2_000,
      startMs: 1_000,
      endMs: 2_000,
      timestamp: '00:00:01',
    });
    broadcaster.emit('broadcast', {
      event: {
        type: 'transcript_delta',
        payload: { ...secondSegment, ignoredNestedField: { attacker: true } },
        timestamp: Date.now(),
      },
    });

    const transcriptDelta = await transcriptDeltaPromise;
    expect(transcriptDelta).toMatchObject({
      id: 'seg-2',
      text: 'World',
    });
    expect(transcriptDelta).not.toHaveProperty('ignoredNestedField');
  });

  it('sync_snapshot 对超长字段显式拒绝，且不写入部分快照', async () => {
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

    const errorPromise = onceSocketEvent<{ message: string; code: string }>(
      broadcaster,
      'share_error'
    );
    broadcaster.emit('sync_snapshot', {
      segments: [makeTranscriptSegment({ text: 'x'.repeat(40_001) })],
      translations: { 'seg-1': '正常翻译' },
      summaryBlocks: [],
      status: 'RECORDING',
    });

    await expect(errorPromise).resolves.toEqual({
      message: 'Live share payload rejected',
      code: 'INVALID_SNAPSHOT',
    });

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const viewerInitialStatePromise = onceSocketEvent<{
      segments: unknown[];
      translations: Record<string, string>;
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });

    const state = await viewerInitialStatePromise;
    expect(state.segments).toEqual([]);
    expect(state.translations).toEqual({});
  });

  it('broadcast 对超长 canonical 增量显式拒绝，旧快照保持不变', async () => {
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

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);

    await onceSocketEvent(viewer, 'connect');
    const viewerInitialStatePromise = onceSocketEvent<{ segments: unknown[] }>(
      viewer,
      'initial_state'
    );
    viewer.emit('join', { shareToken: 'share-token' });
    expect((await viewerInitialStatePromise).segments).toEqual([]);

    const transcriptSpy = vi.fn();
    viewer.on('transcript_delta', transcriptSpy);
    const errorPromise = onceSocketEvent<{ message: string; code: string }>(
      broadcaster,
      'share_error'
    );
    broadcaster.emit('broadcast', {
      event: {
        type: 'transcript_delta',
        payload: makeTranscriptSegment({ text: 'b'.repeat(40_001) }),
        timestamp: Date.now(),
      },
    });

    await expect(errorPromise).resolves.toEqual({
      message: 'Live share payload rejected',
      code: 'INVALID_EVENT',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transcriptSpy).not.toHaveBeenCalled();

    // 同一 socket 的重复 join 已是 no-op；用全新连接读取当前快照，确认拒绝是原子的。
    const verifier = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(verifier);
    await onceSocketEvent(verifier, 'connect');
    const verifierState = onceSocketEvent<{ segments: unknown[] }>(
      verifier,
      'initial_state'
    );
    verifier.emit('join', { shareToken: 'share-token' });
    expect((await verifierState).segments).toEqual([]);
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
      segments: [makeTranscriptSegment()],
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
    expect((await settledStatePromise).segments).toMatchObject([
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
    expect(state.segments).toMatchObject([{ id: 'seg-1', text: 'Hello' }]);
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

  it('SEC-003：同 socket 并发/规范化重复 join 只查一次 DB、发一次快照和人数', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');

    shareLinkFindUniqueMock.mockClear();
    const initialStates: unknown[] = [];
    const viewerCounts: Array<{ count: number }> = [];
    viewer.on('initial_state', (state) => initialStates.push(state));
    viewer.on('viewer_count', (count) => viewerCounts.push(count));

    const firstState = onceSocketEvent(viewer, 'initial_state');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      viewer.emit('join', { shareToken: 'share-token' });
    }
    await firstState;
    viewer.emit('join', { shareToken: '  share-token  ' });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(shareLinkFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(initialStates).toHaveLength(1);
    expect(viewerCounts).toEqual([{ count: 1 }]);
    const roomSockets = await io.in('live:session-1').fetchSockets();
    expect(roomSockets.filter((socket) => !socket.data.isHost)).toHaveLength(1);
  });

  it('SEC-003：随机 token 洪泛在第五次于 DB 前被专用成本桶拒绝', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');

    shareLinkFindUniqueMock.mockClear();
    const errors: Array<{ message: string; code?: string }> = [];
    const allErrors = new Promise<void>((resolve) => {
      viewer.on('share_error', (error) => {
        errors.push(error);
        if (errors.length === 5) resolve();
      });
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      viewer.emit('join', { shareToken: `random-${attempt}` });
    }
    await allErrors;

    expect(shareLinkFindUniqueMock).toHaveBeenCalledTimes(4);
    expect(errors.slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () => ({
        message: 'Invalid or expired share link',
      }))
    );
    expect(errors[4]).toEqual({
      message: 'Too many live share join attempts',
      code: 'JOIN_RATE_LIMITED',
    });
  });

  it('SEC-003：跨房切换授权失败时仍留在原房，成功后才原子迁移', async () => {
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        const sessionId =
          token === 'share-token'
            ? 'session-1'
            : token === 'second-token'
              ? 'session-2'
              : null;
        if (!sessionId) return null;
        return {
          id: `link-${sessionId}`,
          token,
          sessionId,
          createdBy: 'user-1',
          isLive: true,
          expiresAt: null,
          session: {
            id: sessionId,
            userId: 'user-1',
            status: 'RECORDING',
          },
        };
      }
    );

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');

    let initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;

    const failedSwitch = onceSocketEvent<{ message: string }>(
      viewer,
      'share_error'
    );
    viewer.emit('join', { shareToken: 'missing-token' });
    await failedSwitch;
    expect((await io.in('live:session-1').fetchSockets()).map((s) => s.id)).toContain(
      viewer.id
    );
    expect((await io.in('live:session-2').fetchSockets()).map((s) => s.id)).not.toContain(
      viewer.id
    );

    initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'second-token' });
    await initialState;
    expect((await io.in('live:session-1').fetchSockets()).map((s) => s.id)).not.toContain(
      viewer.id
    );
    expect((await io.in('live:session-2').fetchSockets()).map((s) => s.id)).toContain(
      viewer.id
    );
  });

  it('SEC-022：敏感事件使用 established family 复核，routine refresh 后不误用 strict 握手校验', async () => {
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

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;

    // 模拟 routine refresh：旧 leaf 已不再能通过 strict current-leaf 校验，但其
    // family 仍活跃，已建立连接必须改走 established-family 复核。
    verifyAuthTokenMock.mockClear();
    verifyAuthTokenMock.mockResolvedValue(null);
    diagnoseEstablishedAuthFamilyTokenMock.mockClear();
    shareLinkFindUniqueMock.mockClear();
    const statusUpdate = onceSocketEvent<{ status: string }>(viewer, 'status_update');
    broadcaster.emit('broadcast', {
      event: {
        type: 'status_update',
        payload: { status: 'PAUSED' },
        timestamp: Date.now(),
      },
    });

    await expect(statusUpdate).resolves.toEqual({ status: 'PAUSED' });
    expect(verifyAuthTokenMock).not.toHaveBeenCalled();
    expect(diagnoseEstablishedAuthFamilyTokenMock).toHaveBeenCalledTimes(1);
    expect(diagnoseEstablishedAuthFamilyTokenMock).toHaveBeenCalledWith(
      'server-jwt'
    );
    expect(shareLinkFindUniqueMock).toHaveBeenCalledTimes(1);
  });

  it('SEC-022：周期复核发现 family 撤销后主动断开主持人', async () => {
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
      segments: [makeTranscriptSegment({ text: 'old generation' })],
      translations: {},
      summaryBlocks: [],
      status: 'RECORDING',
    });
    const settledViewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(settledViewer);
    await onceSocketEvent(settledViewer, 'connect');
    const settledState = onceSocketEvent<{ segments: Array<{ text: string }> }>(
      settledViewer,
      'initial_state'
    );
    settledViewer.emit('join', { shareToken: 'share-token' });
    expect((await settledState).segments).toMatchObject([
      { text: 'old generation' },
    ]);

    diagnoseEstablishedAuthFamilyTokenMock.mockResolvedValue({ status: 'revoked' });
    const authError = onceSocketEvent<{ message: string; code: string }>(
      broadcaster,
      'share_error'
    );
    const disconnected = onceSocketEvent<string>(broadcaster, 'disconnect');
    await expect(
      revalidateSessionBroadcasters(io, 'session-1')
    ).resolves.toBe(1);
    await expect(authError).resolves.toEqual({
      message: 'Broadcaster authorization revoked',
      code: 'BROADCASTER_AUTH_REVOKED',
    });
    await expect(disconnected).resolves.toBe('io server disconnect');

    // 安全撤权跳过 15 秒网络 grace，并轮换内存世代；同一公开链接后续 viewer
    // 不能继续读到已撤主持人的旧内存快照。
    const verifier = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(verifier);
    await onceSocketEvent(verifier, 'connect');
    const verifierState = onceSocketEvent<{ segments: unknown[] }>(
      verifier,
      'initial_state'
    );
    verifier.emit('join', { shareToken: 'share-token' });
    expect((await verifierState).segments).toEqual([]);
  });

  it('SEC-022：分享链接换代后旧主持人下一事件失败关闭且不能广播', async () => {
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

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;

    shareLinkFindUniqueMock.mockResolvedValue(null);
    const leakedStatus = vi.fn();
    viewer.on('status_update', leakedStatus);
    const authError = onceSocketEvent<{ code: string }>(
      broadcaster,
      'share_error'
    );
    const disconnected = onceSocketEvent<string>(broadcaster, 'disconnect');
    broadcaster.emit('broadcast', {
      event: {
        type: 'status_update',
        payload: { status: 'PAUSED' },
        timestamp: Date.now(),
      },
    });

    await expect(authError).resolves.toMatchObject({
      code: 'BROADCASTER_AUTH_REVOKED',
    });
    await expect(disconnected).resolves.toBe('io server disconnect');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(leakedStatus).not.toHaveBeenCalledWith({ status: 'PAUSED' });
  });

  it('SEC-022：B 分享世代接管后隔离 A 快照，A 的迟到事件不污染 B 观众', async () => {
    let oldLinkLive = true;
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        const isOld = token === 'share-token';
        if ((!isOld && token !== 'share-token-b') || (isOld && !oldLinkLive)) {
          return null;
        }
        return {
          id: isOld ? 'link-a' : 'link-b',
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

    const broadcasterA = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcasterA);
    const broadcasterAConnected = onceSocketEvent(broadcasterA, 'connect');
    const broadcasterAInitialState = onceSocketEvent(
      broadcasterA,
      'initial_state'
    );
    broadcasterA.connect();
    await broadcasterAConnected;
    await broadcasterAInitialState;
    broadcasterA.emit('sync_snapshot', {
      segments: [makeTranscriptSegment({ id: 'seg-a', text: 'A history' })],
      translations: {},
      summaryBlocks: [],
      status: 'RECORDING',
    });

    const viewerA = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewerA);
    await onceSocketEvent(viewerA, 'connect');
    const stateA = onceSocketEvent<{ segments: Array<{ id: string }> }>(
      viewerA,
      'initial_state'
    );
    viewerA.emit('join', { shareToken: 'share-token' });
    expect((await stateA).segments).toMatchObject([{ id: 'seg-a' }]);

    // A 被撤销而内部通知丢失；B viewer 先到，也必须以 link-b 激活新世代并拿到空态，
    // 不能读到仍驻留内存的 A history。
    oldLinkLive = false;
    shareLinkFindManyMock.mockResolvedValue([{ token: 'share-token-b' }]);
    const oldAuthError = onceSocketEvent<{ code: string }>(
      broadcasterA,
      'share_error'
    );
    const oldDisconnected = onceSocketEvent<string>(broadcasterA, 'disconnect');
    const viewerB = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewerB);
    await onceSocketEvent(viewerB, 'connect');
    const stateB = onceSocketEvent<{ segments: unknown[] }>(viewerB, 'initial_state');
    viewerB.emit('join', { shareToken: 'share-token-b' });
    expect((await stateB).segments).toEqual([]);
    await expect(oldAuthError).resolves.toMatchObject({
      code: 'BROADCASTER_AUTH_REVOKED',
    });
    await expect(oldDisconnected).resolves.toBe('io server disconnect');

    const bStatuses: string[] = [];
    viewerB.on('status_update', ({ status }: { status: string }) => {
      bStatuses.push(status);
    });
    // 已被主动断开的 A 即便客户端继续 emit，也到不了服务端，更不能污染 B 房间。
    broadcasterA.emit('broadcast', {
      event: {
        type: 'status_update',
        payload: { status: 'PAUSED' },
        timestamp: Date.now(),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bStatuses).not.toContain('PAUSED');
    expect(bStatuses).not.toContain('SHARE_OFFLINE');

    const broadcasterB = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token-b',
      },
    });
    clients.push(broadcasterB);
    const broadcasterBConnected = onceSocketEvent(broadcasterB, 'connect');
    const broadcasterBInitialState = onceSocketEvent(
      broadcasterB,
      'initial_state'
    );
    broadcasterB.connect();
    await broadcasterBConnected;
    await broadcasterBInitialState;

    const segmentB = makeTranscriptSegment({ id: 'seg-b', text: 'B history' });
    const bDelta = onceSocketEvent<{ id: string }>(viewerB, 'transcript_delta');
    broadcasterB.emit('broadcast', {
      event: {
        type: 'transcript_delta',
        payload: segmentB,
        timestamp: Date.now(),
      },
    });
    await expect(bDelta).resolves.toMatchObject({ id: 'seg-b' });

    const verifierB = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(verifierB);
    await onceSocketEvent(verifierB, 'connect');
    const finalStateB = onceSocketEvent<{ segments: Array<{ id: string }> }>(
      verifierB,
      'initial_state'
    );
    verifierB.emit('join', { shareToken: 'share-token-b' });
    expect((await finalStateB).segments.map((segment) => segment.id)).toEqual([
      'seg-b',
    ]);
  });

  it('SEC-022：原 leaf 自然过期断开后，可用新 current leaf 严格握手并恢复广播', async () => {
    const oldBroadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'expired-leaf',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(oldBroadcaster);
    await onceSocketEvent(oldBroadcaster, 'connect');
    await onceSocketEvent(oldBroadcaster, 'initial_state');

    diagnoseEstablishedAuthFamilyTokenMock.mockResolvedValue({
      status: 'leaf_expired',
    });
    const leafExpiredError = onceSocketEvent<{ message: string; code: string }>(
      oldBroadcaster,
      'share_error'
    );
    const oldDisconnected = onceSocketEvent<string>(oldBroadcaster, 'disconnect');
    await revalidateSessionBroadcasters(io, 'session-1');
    await expect(leafExpiredError).resolves.toEqual({
      message: 'Broadcaster authentication leaf expired',
      code: 'BROADCASTER_AUTH_LEAF_EXPIRED',
    });
    await expect(oldDisconnected).resolves.toBe('io server disconnect');

    const authenticatedSession = {
      user: { id: 'user-1', email: 'alice@example.com', role: 'ADMIN' },
      token: { jti: 'jti-new', tokenVersion: 1 },
      rawToken: 'current-leaf',
    };
    verifyAuthTokenMock.mockClear();
    verifyAuthTokenMock.mockResolvedValue(authenticatedSession);
    diagnoseEstablishedAuthFamilyTokenMock.mockResolvedValue({
      status: 'valid',
      session: authenticatedSession,
    });
    const newBroadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'current-leaf',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(newBroadcaster);
    await onceSocketEvent(newBroadcaster, 'connect');
    await onceSocketEvent(newBroadcaster, 'initial_state');
    expect(verifyAuthTokenMock).toHaveBeenCalledWith('current-leaf');

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;
    const resumed = onceSocketEvent<{ status: string }>(viewer, 'status_update');
    newBroadcaster.emit('broadcast', {
      event: {
        type: 'status_update',
        payload: { status: 'RECORDING' },
        timestamp: Date.now(),
      },
    });
    await expect(resumed).resolves.toEqual({ status: 'RECORDING' });
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

  it('SEC-022：通知丢失时周期扫描仍复核主持人，且观众 DB 失败不能跳过主持人撤权', async () => {
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

    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await initialState;

    // 模拟内部撤权通知丢失；周期中观众查询又暂时失败，主持人复核仍必须独立执行。
    shareLinkFindManyMock.mockRejectedValue(new Error('viewer DB unavailable'));
    diagnoseEstablishedAuthFamilyTokenMock.mockResolvedValue({ status: 'revoked' });
    const authError = onceSocketEvent<{ code: string }>(
      broadcaster,
      'share_error'
    );
    const disconnected = onceSocketEvent<string>(broadcaster, 'disconnect');

    await revalidateAllLiveRooms(io);

    await expect(authError).resolves.toMatchObject({
      code: 'BROADCASTER_AUTH_REVOKED',
    });
    await expect(disconnected).resolves.toBe('io server disconnect');
  });

  it('SEC-022：session/link 删除且通知丢失时，周期分享世代复核仍主动断开', async () => {
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

    // Prisma cascade 后 token 查询为 null；不依赖内部通知，60s 周期路径同样失败关闭。
    shareLinkFindUniqueMock.mockResolvedValue(null);
    const authError = onceSocketEvent<{ code: string }>(
      broadcaster,
      'share_error'
    );
    const disconnected = onceSocketEvent<string>(broadcaster, 'disconnect');

    await revalidateAllLiveRooms(io);

    await expect(authError).resolves.toMatchObject({
      code: 'BROADCASTER_AUTH_REVOKED',
    });
    await expect(disconnected).resolves.toBe('io server disconnect');
  });
});
