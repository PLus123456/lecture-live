import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => backing.set(key, String(value)),
      removeItem: (key: string) => backing.delete(key),
      clear: () => backing.clear(),
      key: (index: number) => [...backing.keys()][index] ?? null,
      get length() {
        return backing.size;
      },
    },
  });
  return { backing, cleanup: vi.fn(async () => undefined) };
});

vi.mock('@/lib/clientAccountCleanup', () => ({
  clearAccountBoundClientState: harness.cleanup,
}));

import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { AUTH_SESSION_BINDING_HEADER } from '@/lib/authProtocol';
import { getPendingAuthRevocations } from '@/lib/clientAuthCookieMutation';

const user = (id: string) => ({
  id,
  email: `${id}@example.com`,
  displayName: id.toUpperCase(),
  role: 'FREE' as const,
  createdAt: '2026-08-20T00:00:00.000Z',
});

function responseWithJson(
  binding: string,
  json: () => Promise<unknown>
): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ [AUTH_SESSION_BINDING_HEADER]: binding }),
    json,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.backing.clear();
  useAuthStore.setState({
    user: null,
    token: null,
    sessionBinding: null,
    quotas: null,
    sessionChecked: false,
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAuth auth-cookie commit ordering', () => {
  it('headers 先到、body 延迟时锁持续到 setAuth commit；第二个 login 不会发出旧 expected 请求', async () => {
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const fetchMock = vi.fn(async () =>
      responseWithJson('binding-a', async () => {
        await bodyGate;
        return {
          user: user('a'),
          token: '__cookie_session__',
          sessionBinding: 'binding-a',
        };
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth());

    let loginA!: ReturnType<typeof result.current.loginUser>;
    let loginB!: ReturnType<typeof result.current.loginUser>;
    act(() => {
      loginA = result.current.loginUser('a@example.com', 'Password1');
      loginB = result.current.loginUser('b@example.com', 'Password1');
    });
    const loginBExpectation = expect(loginB).rejects.toMatchObject({
      name: 'AbortError',
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    releaseBody();
    await act(async () => {
      await loginA;
      await loginBExpectation;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({
      user: { id: 'a' },
      sessionBinding: 'binding-a',
    });
  });

  it('2xx Set-Cookie 后 JSON 截断且补偿撤销 503 时，强制清除旧 A 边界', async () => {
    await useAuthStore.getState().setAuth(
      user('a'),
      '__cookie_session__',
      { sessionBinding: 'binding-a' }
    );
    harness.cleanup.mockClear();
    const bodyError = new SyntaxError('truncated JSON');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseWithJson('binding-uncommitted', async () => {
          throw bodyError;
        })
      )
      .mockResolvedValueOnce(
        new Response('{"error":"database unavailable"}', { status: 503 })
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await expect(
        result.current.loginUser('a@example.com', 'Password1')
      ).rejects.toBe(bodyError);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: {
          [AUTH_SESSION_BINDING_HEADER]: 'binding-uncommitted',
        },
      })
    );
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      token: null,
      sessionBinding: null,
      sessionChecked: true,
    });
    expect(harness.cleanup).toHaveBeenCalledTimes(2);
    expect(
      localStorage.getItem('lecture-live-pending-auth-revocation-v1')
    ).toBe('binding-uncommitted');

    let retryResult!: Awaited<ReturnType<typeof result.current.logout>>;
    await act(async () => {
      retryResult = await result.current.logout();
    });
    expect(retryResult).toMatchObject({
      durableRevocation: true,
      pendingRevocation: false,
    });
    expect(
      localStorage.getItem('lecture-live-pending-auth-revocation-v1')
    ).toBeNull();
  });

  it('2xx 合法 JSON 缺 user/token 时撤销新 family，并且不保留旧 A store', async () => {
    await useAuthStore.getState().setAuth(
      user('a'),
      '__cookie_session__',
      { sessionBinding: 'binding-a' }
    );
    harness.cleanup.mockClear();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseWithJson('binding-malformed', async () => ({}))
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await expect(
        result.current.loginUser('b@example.com', 'Password1')
      ).rejects.toThrow('Login session binding missing');
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/logout',
      expect.objectContaining({
        headers: {
          [AUTH_SESSION_BINDING_HEADER]: 'binding-malformed',
        },
      })
    );
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      token: null,
      sessionBinding: null,
      sessionChecked: true,
    });
    expect(harness.cleanup).toHaveBeenCalledTimes(2);
  });

  it('B login 已持锁时 A logout 不丢 pending；即使首个 A 请求丢包仍能按 capability 重试撤 A/B', async () => {
    await useAuthStore.getState().setAuth(
      user('a'),
      '__cookie_session__',
      { sessionBinding: 'binding-a' }
    );
    harness.cleanup.mockClear();

    let releaseLoginBody!: () => void;
    const loginBodyGate = new Promise<void>((resolve) => {
      releaseLoginBody = resolve;
    });
    const revoked = new Set<string>();
    let aLogoutAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          return responseWithJson('binding-b', async () => {
            await loginBodyGate;
            return {
              user: user('b'),
              token: '__cookie_session__',
              sessionBinding: 'binding-b',
            };
          });
        }
        if (url.includes('/api/auth/logout')) {
          const binding = new Headers(init?.headers).get(
            AUTH_SESSION_BINDING_HEADER
          );
          if (!binding) throw new Error('missing binding');
          if (binding === 'binding-a' && aLogoutAttempts++ === 0) {
            throw new TypeError('response lost after request dispatch');
          }
          revoked.add(binding);
          return new Response('{}', { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth());

    const loginB = result.current.loginUser('b@example.com', 'Password1');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const logoutA = result.current.logout();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // B may now finish and commit first; queued logout must retain A while also
    // discovering and revoking B's newly committed capability.
    releaseLoginBody();
    let firstLogout!: Awaited<ReturnType<typeof result.current.logout>>;
    await act(async () => {
      await loginB;
      firstLogout = await logoutA;
    });

    expect(firstLogout).toMatchObject({
      durableRevocation: false,
      pendingRevocation: true,
    });
    expect(revoked).toEqual(new Set(['binding-b']));
    expect(getPendingAuthRevocations()).toEqual(['binding-a']);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      token: null,
      sessionBinding: null,
    });

    let retry!: Awaited<ReturnType<typeof result.current.logout>>;
    await act(async () => {
      retry = await result.current.logout();
    });
    expect(retry).toMatchObject({
      durableRevocation: true,
      pendingRevocation: false,
    });
    expect(revoked).toEqual(new Set(['binding-a', 'binding-b']));
    expect(getPendingAuthRevocations()).toEqual([]);
  });

  it('refresh verification 503 保留持久主体/binding，返回 unavailable 供 UI 重试', async () => {
    await useAuthStore.getState().setAuth(
      user('a'),
      '__cookie_session__',
      { sessionBinding: 'binding-a' }
    );
    // 模拟页面刷新：非敏感 token 不持久化，但 user/binding 已从 localStorage 水合。
    useAuthStore.setState({ token: null, sessionChecked: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"error":"unavailable"}', { status: 503 })
      )
    );
    const { result } = renderHook(() => useAuth());

    let restoreResult!: Awaited<ReturnType<typeof result.current.restoreSession>>;
    await act(async () => {
      restoreResult = await result.current.restoreSession();
    });

    expect(restoreResult).toBe('unavailable');
    expect(useAuthStore.getState()).toMatchObject({
      user: { id: 'a' },
      token: null,
      sessionBinding: 'binding-a',
      sessionChecked: false,
    });
  });

  it('refresh 429 是可重试服务状态，不清除持久主体/binding', async () => {
    await useAuthStore.getState().setAuth(
      user('a'),
      '__cookie_session__',
      { sessionBinding: 'binding-a' }
    );
    useAuthStore.setState({ token: null, sessionChecked: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"rate limited"}', { status: 429 }))
    );
    const { result } = renderHook(() => useAuth());

    let restoreResult!: Awaited<ReturnType<typeof result.current.restoreSession>>;
    await act(async () => {
      restoreResult = await result.current.restoreSession();
    });

    expect(restoreResult).toBe('unavailable');
    expect(useAuthStore.getState()).toMatchObject({
      user: { id: 'a' },
      token: null,
      sessionBinding: 'binding-a',
      sessionChecked: false,
    });
  });

  it('配额 JSON 验证后若跨 Tab B 先提交，A sink 不得覆盖 B 持久边界', async () => {
    await useAuthStore.getState().setAuth(
      user('a'),
      '__cookie_session__',
      { sessionBinding: 'binding-a' }
    );
    const quotaPayload = {
      transcriptionMinutes: 10,
      translationWords: 20,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ quotas: quotaPayload }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    let releaseCommit!: () => void;
    const request = vi.fn(
      <T,>(
        _name: string,
        _options: LockOptions,
        operation: () => Promise<T>
      ) =>
        new Promise<T>((resolve, reject) => {
          releaseCommit = () => {
            operation().then(resolve, reject);
          };
        })
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    const { result } = renderHook(() => useAuth());

    const quotaRequest = result.current.fetchQuotas();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const persistedB = JSON.stringify({
      state: {
        user: user('b'),
        sessionBinding: 'binding-b',
        quotas: null,
      },
      version: 0,
    });
    localStorage.setItem('lecture-live-auth', persistedB);
    releaseCommit();

    await act(async () => {
      await quotaRequest;
    });

    expect(useAuthStore.getState()).toMatchObject({
      user: { id: 'a' },
      sessionBinding: 'binding-a',
      quotas: null,
    });
    expect(localStorage.getItem('lecture-live-auth')).toBe(persistedB);
  });
});
