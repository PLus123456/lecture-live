import { beforeEach, describe, expect, it, vi } from 'vitest';

const socketState = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    auth: {} as unknown,
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  socket.on.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    }
  );
  const io = vi.fn(
    (_url: string, options: { auth?: unknown }) => {
      socket.auth = options.auth ?? {};
      return socket;
    }
  );
  return { handlers, io, socket };
});

vi.mock('socket.io-client', () => ({ io: socketState.io }));

import {
  LiveBroadcaster,
  shouldStrictlyReauthenticateBroadcaster,
  type LiveBroadcasterAuthState,
} from '@/lib/liveShare/broadcaster';

const INITIAL_AUTH: LiveBroadcasterAuthState = {
  token: '__cookie_session__',
  epoch: 7,
  userId: 'user-1',
  sessionBinding: 'family-binding-1',
};

function trigger(event: string, ...args: unknown[]) {
  const handler = socketState.handlers.get(event);
  if (!handler) throw new Error(`Missing socket handler: ${event}`);
  handler(...args);
}

describe('LiveBroadcaster strict leaf-expiry reconnect', () => {
  beforeEach(() => {
    socketState.handlers.clear();
    socketState.io.mockClear();
    socketState.socket.emit.mockClear();
    socketState.socket.connect.mockClear();
    socketState.socket.disconnect.mockClear();
    socketState.socket.auth = {};
  });

  it('只对专用 leaf-expired code 且同一 auth family 边界允许重握手', () => {
    expect(
      shouldStrictlyReauthenticateBroadcaster(
        'BROADCASTER_AUTH_LEAF_EXPIRED',
        INITIAL_AUTH,
        INITIAL_AUTH
      )
    ).toBe(true);
    expect(
      shouldStrictlyReauthenticateBroadcaster(
        'BROADCASTER_AUTH_REVOKED',
        INITIAL_AUTH,
        INITIAL_AUTH
      )
    ).toBe(false);
    expect(
      shouldStrictlyReauthenticateBroadcaster(
        'BROADCASTER_AUTH_LEAF_EXPIRED',
        INITIAL_AUTH,
        { ...INITIAL_AUTH, sessionBinding: 'family-binding-2' }
      )
    ).toBe(false);
  });

  it('收到 leaf-expired 后等 server disconnect，再用当前 Cookie sentinel 严格重握手一次', () => {
    const onError = vi.fn();
    let currentAuth = { ...INITIAL_AUTH };
    new LiveBroadcaster('https://ws.example.test', {
      sessionId: 'session-1',
      token: '__cookie_session__',
      shareToken: 'share-token',
      callbacks: { onError },
      reauth: {
        initial: INITIAL_AUTH,
        getCurrent: () => currentAuth,
      },
    });

    trigger('share_error', {
      message: 'Authentication leaf expired',
      code: 'BROADCASTER_AUTH_LEAF_EXPIRED',
    });
    expect(onError).not.toHaveBeenCalled();
    expect(socketState.socket.connect).not.toHaveBeenCalled();

    // sentinel 字符串不变；浏览器会在新握手自动携带 routine refresh 后的新 HttpOnly cookie。
    currentAuth = { ...INITIAL_AUTH, token: '__cookie_session__' };
    trigger('disconnect', 'io server disconnect');

    expect(socketState.socket.auth).toMatchObject({
      token: '__cookie_session__',
      sessionId: 'session-1',
      shareToken: 'share-token',
    });
    expect(socketState.socket.connect).toHaveBeenCalledTimes(1);
  });

  it('generic revoke、账号边界变化和主动断开都不会重连', () => {
    const onError = vi.fn();
    let currentAuth = { ...INITIAL_AUTH };
    const broadcaster = new LiveBroadcaster('https://ws.example.test', {
      sessionId: 'session-1',
      token: '__cookie_session__',
      shareToken: 'share-token',
      callbacks: { onError },
      reauth: {
        initial: INITIAL_AUTH,
        getCurrent: () => currentAuth,
      },
    });

    trigger('share_error', {
      message: 'Revoked',
      code: 'BROADCASTER_AUTH_REVOKED',
    });
    trigger('disconnect', 'io server disconnect');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(socketState.socket.connect).not.toHaveBeenCalled();

    onError.mockClear();
    currentAuth = { ...INITIAL_AUTH, epoch: INITIAL_AUTH.epoch + 1, userId: null };
    trigger('share_error', {
      message: 'Authentication leaf expired',
      code: 'BROADCASTER_AUTH_LEAF_EXPIRED',
    });
    trigger('disconnect', 'io server disconnect');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(socketState.socket.connect).not.toHaveBeenCalled();

    currentAuth = { ...INITIAL_AUTH };
    trigger('share_error', {
      message: 'Authentication leaf expired',
      code: 'BROADCASTER_AUTH_LEAF_EXPIRED',
    });
    broadcaster.disconnect();
    trigger('disconnect', 'io server disconnect');
    expect(socketState.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socketState.socket.connect).not.toHaveBeenCalled();
  });
});
