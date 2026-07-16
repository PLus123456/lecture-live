// SHARE-REVOKE-001 全链路集成测试：模拟生产接线（createServer(handler) + socket.io
// attach + setupLiveShare），验证「观众已连接 → API 进程发内部撤销通知 → 观众被
// 即时驱逐」的完整路径，以及内部 endpoint 的鉴权与输入校验。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';

const { shareLinkFindUniqueMock, shareLinkFindManyMock } = vi.hoisted(() => ({
  shareLinkFindUniqueMock: vi.fn(),
  shareLinkFindManyMock: vi.fn(),
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
  verifyAuthToken: vi.fn(),
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
import { handleLiveShareInternalRequest } from '@/lib/liveShare/internalHttp';
import {
  LIVE_SHARE_INTERNAL_REVALIDATE_PATH,
  signLiveShareRevalidatePayload,
  type LiveShareRevalidatePayload,
} from '@/lib/liveShare/internalApi';

describe('handleLiveShareInternalRequest', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
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
    shareLinkFindManyMock.mockResolvedValue([{ token: 'share-token' }]);

    // 与 server/websocket.ts 相同的接线：内部 handler 作为 createServer 的
    // listener，socket.io attach 后只把非 /socket.io/ 请求回落给它。
    httpServer = createServer((req, res) =>
      handleLiveShareInternalRequest(io, req, res)
    );
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

    teardownLiveShare();

    await new Promise<void>((resolve) => {
      io.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  async function joinViewer(shareToken = 'share-token') {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const initialState = onceSocketEvent(viewer, 'initial_state');
    viewer.emit('join', { shareToken });
    await initialState;
    return viewer;
  }

  function postRevalidate(body: Record<string, unknown>) {
    return fetch(`${baseUrl}${LIVE_SHARE_INTERNAL_REVALIDATE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function signedBody(
    overrides: Partial<LiveShareRevalidatePayload> = {}
  ): Record<string, unknown> {
    const payload: LiveShareRevalidatePayload = {
      sessionId: 'session-1',
      mode: 'revoke',
      ts: Date.now(),
      ...overrides,
    };
    return { ...payload, sig: signLiveShareRevalidatePayload(payload) };
  }

  it('合法通知驱逐已撤销 token 的观众（全链路）', async () => {
    const viewer = await joinViewer();

    // 撤销：DB 复核不再承认任何 token
    shareLinkFindManyMock.mockResolvedValue([]);

    const errorPromise = onceSocketEvent<{ message: string; code?: string }>(
      viewer,
      'share_error'
    );
    const disconnectPromise = onceSocketEvent<string>(viewer, 'disconnect');

    const response = await postRevalidate(signedBody());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ evicted: 1 });
    await expect(errorPromise).resolves.toEqual({
      message: 'Share link revoked',
      code: 'SHARE_REVOKED',
    });
    await expect(disconnectPromise).resolves.toBe('io server disconnect');
  });

  it('transition 模式静默驱逐（不发 share_error）', async () => {
    const viewer = await joinViewer();
    const shareErrorSpy = vi.fn();
    viewer.on('share_error', shareErrorSpy);
    const disconnectPromise = onceSocketEvent<string>(viewer, 'disconnect');

    shareLinkFindManyMock.mockResolvedValue([]);
    const response = await postRevalidate(signedBody({ mode: 'transition' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ evicted: 1 });
    await expect(disconnectPromise).resolves.toBe('io server disconnect');
    expect(shareErrorSpy).not.toHaveBeenCalled();
  });

  it('签名不合法时拒绝且不驱逐任何观众', async () => {
    const viewer = await joinViewer();
    shareLinkFindManyMock.mockResolvedValue([]);

    const body = signedBody();
    body.sig = signLiveShareRevalidatePayload({
      sessionId: 'other-session',
      mode: 'revoke',
      ts: body.ts as number,
    });

    const response = await postRevalidate(body);

    expect(response.status).toBe(401);
    expect(viewer.connected).toBe(true);
  });

  it('时间窗外的通知被拒绝', async () => {
    const staleTs = Date.now() - 10 * 60_000;
    const response = await postRevalidate(signedBody({ ts: staleTs }));
    expect(response.status).toBe(401);
  });

  it('token 仍有效的观众不会被合法通知误伤', async () => {
    const viewer = await joinViewer();
    // findMany 保持默认：share-token 仍有效

    const response = await postRevalidate(signedBody());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ evicted: 0 });
    expect(viewer.connected).toBe(true);
  });

  it('缺字段 / 非法 JSON / 错误方法与路径分别返回 400/405/404', async () => {
    const missingField = await postRevalidate({ sessionId: 'session-1' });
    expect(missingField.status).toBe(400);

    const badJson = await fetch(`${baseUrl}${LIVE_SHARE_INTERNAL_REVALIDATE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    });
    expect(badJson.status).toBe(400);

    const wrongMethod = await fetch(
      `${baseUrl}${LIVE_SHARE_INTERNAL_REVALIDATE_PATH}`,
      { method: 'GET' }
    );
    expect(wrongMethod.status).toBe(405);

    const wrongPath = await fetch(`${baseUrl}/internal/other`, { method: 'POST' });
    expect(wrongPath.status).toBe(404);
  });

  it('超大 body 直接断连（不处理）', async () => {
    await expect(
      fetch(`${baseUrl}${LIVE_SHARE_INTERNAL_REVALIDATE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(20 * 1024),
      })
    ).rejects.toThrow();
  });
});
