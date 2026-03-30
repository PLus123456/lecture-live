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

describe('setupLiveShare', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
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

    httpServer = createServer();
    io = new SocketIOServer(httpServer, {
      transports: ['websocket'],
    });
    setupLiveShare(io);

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
});
