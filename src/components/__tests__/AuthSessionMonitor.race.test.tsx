import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup as cleanupReact,
  render,
  renderHook,
} from '@testing-library/react';

const harness = vi.hoisted(() => ({
  ...(() => {
    const backing = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) =>
          backing.set(key, String(value)),
        removeItem: (key: string) => backing.delete(key),
        clear: () => backing.clear(),
        key: (index: number) => [...backing.keys()][index] ?? null,
        get length() {
          return backing.size;
        },
      },
    });
    return { backing };
  })(),
  replace: vi.fn(),
  cleanupBoundary: vi.fn(async () => undefined),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: harness.replace }),
  usePathname: () => '/home',
}));
vi.mock('@/lib/clientAccountCleanup', () => ({
  clearAccountBoundClientState: harness.cleanupBoundary,
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import AuthSessionMonitor from '@/components/AuthSessionMonitor';
import { useAuthStore } from '@/stores/authStore';
import { useAuth } from '@/hooks/useAuth';
import {
  getPendingAuthRevocation,
  runAuthCookieMutation,
} from '@/lib/clientAuthCookieMutation';

const USER_A = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: 'A',
  role: 'FREE' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const USER_B = {
  ...USER_A,
  id: 'user-b',
  email: 'b@example.com',
  displayName: 'B',
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.backing.clear();
  useAuthStore.setState({
    user: USER_A,
    token: '__cookie_session__',
    sessionBinding: 'binding-a',
    quotas: null,
    sessionChecked: true,
  });
});

afterEach(() => {
  cleanupReact();
  vi.unstubAllGlobals();
});

describe('AuthSessionMonitor auth epoch race', () => {
  it('A 请求的延迟 401 在切到 B 后被丢弃，不 logout/清理 B', async () => {
    let resolveLate!: (response: Response) => void;
    const originalFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        })
    );
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);

    const lateARequest = window.fetch('/api/private-a');
    await vi.waitFor(() => expect(originalFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await useAuthStore.getState().setAuth(
        USER_B,
        '__cookie_session__',
        { sessionBinding: 'binding-b' }
      );
    });

    resolveLate(new Response('{}', { status: 401 }));
    await expect(lateARequest).rejects.toMatchObject({ name: 'AbortError' });

    expect(useAuthStore.getState()).toMatchObject({
      user: USER_B,
      sessionBinding: 'binding-b',
    });
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(harness.cleanupBoundary).toHaveBeenCalledTimes(2);
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('A response 已交付但 body chunk 在第二轮 cleanup 后到达时仍被 epoch 拒绝', async () => {
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    const originalFetch = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await chunkGate;
            controller.enqueue(
              new TextEncoder().encode('event: text\ndata: {"delta":"A-secret"}\n\n')
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }
      )
    );
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);

    let lateWrite = '';
    const bodyConsumer = window.fetch('/api/llm/chat').then(async (response) => {
      const chunk = await response.body!.getReader().read();
      lateWrite = new TextDecoder().decode(chunk.value);
    });
    // 立刻挂 rejection handler，避免测试在释放迟到 chunk 前把预期 AbortError 记作 unhandled。
    const bodyExpectation = expect(bodyConsumer).rejects.toMatchObject({
      name: 'AbortError',
    });
    await Promise.resolve();

    await act(async () => {
      await useAuthStore.getState().setAuth(
        USER_B,
        '__cookie_session__',
        { sessionBinding: 'binding-b' }
      );
    });
    expect(harness.cleanupBoundary).toHaveBeenCalledTimes(2);

    releaseChunk();
    await bodyExpectation;
    expect(lateWrite).toBe('');
    expect(useAuthStore.getState().user?.id).toBe(USER_B.id);
  });

  it('跨 Tab B 已持久新边界但 storage event 未到时，A 的迟到 body 不得交付', async () => {
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const originalFetch = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await bodyGate;
            controller.enqueue(new TextEncoder().encode('{"secret":"A"}'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);

    const response = await window.fetch('/api/private-a');
    const consumption = response.json();
    const consumptionExpectation = expect(consumption).rejects.toMatchObject({
      name: 'AbortError',
    });
    localStorage.setItem(
      'lecture-live-auth',
      JSON.stringify({
        state: {
          user: USER_B,
          sessionBinding: 'binding-b',
          quotas: null,
        },
        version: 0,
      })
    );
    releaseBody();

    await consumptionExpectation;
    // The delayed storage event has intentionally not been dispatched.
    expect(useAuthStore.getState()).toMatchObject({
      user: { id: USER_A.id },
      sessionBinding: 'binding-a',
    });
  });

  it('未读取 body 时不会提前锁流，json 与 clone().json 保持原生语义', async () => {
    const originalFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);

    const response = await window.fetch('/api/json');
    const cloned = response.clone();
    await expect(response.json()).resolves.toEqual({ ok: true });
    await expect(cloned.json()).resolves.toEqual({ ok: true });
  });

  it('普通 API 401 后 logout 503 会保留 pending binding，并阻止新 cookie mutation', async () => {
    const originalFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url.includes('/api/auth/logout')
        ? new Response('{"error":"unavailable"}', { status: 503 })
        : new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);

    await window.fetch('/api/private-a');

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      token: null,
      sessionBinding: null,
    });
    expect(getPendingAuthRevocation()).toBe('binding-a');
    await expect(
      runAuthCookieMutation(async () => 'must-not-run')
    ).rejects.toThrow('Pending logout revocation must be retried');
    expect(harness.replace).toHaveBeenCalledWith('/login');
  });

  it('B login 持有 cookie lock 时，A 的迟到 401 等待并在锁内重验后不得清 B', async () => {
    let resolvePrivate!: (response: Response) => void;
    let releaseLoginBody!: () => void;
    const loginBodyGate = new Promise<void>((resolve) => {
      releaseLoginBody = resolve;
    });
    const originalFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/private-a')) {
        return new Promise<Response>((resolve) => {
          resolvePrivate = resolve;
        });
      }
      if (url.includes('/api/auth/login')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'X-Lecture-Live-Auth-Session': 'binding-b',
          }),
          json: async () => {
            await loginBodyGate;
            return {
              user: USER_B,
              token: '__cookie_session__',
              sessionBinding: 'binding-b',
            };
          },
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);
    const { result } = renderHook(() => useAuth());

    const latePrivate = window.fetch('/api/private-a');
    const loginB = result.current.loginUser('b@example.com', 'Password1');
    // The shared request owns the lock until its headers arrive, so login must
    // not send its cookie-writing request yet.
    await vi.waitFor(() => expect(originalFetch).toHaveBeenCalledTimes(1));

    resolvePrivate(new Response('{}', { status: 401 }));
    await vi.waitFor(() => expect(originalFetch).toHaveBeenCalledTimes(2));

    releaseLoginBody();
    await act(async () => {
      await loginB;
      await latePrivate;
    });

    expect(useAuthStore.getState()).toMatchObject({
      user: { id: USER_B.id },
      sessionBinding: 'binding-b',
    });
    expect(getPendingAuthRevocation()).toBeNull();
    expect(
      originalFetch.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout')
      )
    ).toBe(false);
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('B login 响应头已写 cookie 但 body 未 commit 时，排队的 A 业务请求不得按 B 发出', async () => {
    let releaseLoginBody!: () => void;
    const loginBodyGate = new Promise<void>((resolve) => {
      releaseLoginBody = resolve;
    });
    const originalFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'X-Lecture-Live-Auth-Session': 'binding-b',
          }),
          json: async () => {
            await loginBodyGate;
            return {
              user: USER_B,
              token: '__cookie_session__',
              sessionBinding: 'binding-b',
            };
          },
        } as Response;
      }
      if (url.includes('/api/sessions')) {
        return new Response('{"id":"must-not-be-created"}', { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);
    const { result } = renderHook(() => useAuth());

    const loginB = result.current.loginUser('b@example.com', 'Password1');
    await vi.waitFor(() => expect(originalFetch).toHaveBeenCalledTimes(1));

    // This payload was prepared while the visible account was still A. The
    // shared reader queues behind login's exclusive lock and must retain that
    // invocation snapshot instead of being reinterpreted as a B action.
    const queuedAWrite = window.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'A private recording' }),
    });
    const queuedExpectation = expect(queuedAWrite).rejects.toMatchObject({
      name: 'AbortError',
    });
    await Promise.resolve();
    expect(originalFetch).toHaveBeenCalledTimes(1);

    releaseLoginBody();
    await act(async () => {
      await loginB;
      await queuedExpectation;
    });

    expect(useAuthStore.getState()).toMatchObject({
      user: { id: USER_B.id },
      sessionBinding: 'binding-b',
    });
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(
      originalFetch.mock.calls.some(([input]) =>
        String(input).includes('/api/sessions')
      )
    ).toBe(false);
  });

  it('跨 Tab B 已提交持久边界但 storage event 尚未派发时，A 迟到 401 不得 logout', async () => {
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const originalFetch = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', originalFetch);
    render(<AuthSessionMonitor />);

    const lateA = window.fetch('/api/private-a');
    // Queue B's exclusive mutation after A has invoked its shared request but
    // before A's 401 handler can acquire a second exclusive lock.
    const heldMutation = runAuthCookieMutation(async () => {
      await lockGate;
    });
    await vi.waitFor(() => expect(originalFetch).toHaveBeenCalledTimes(1));
    localStorage.setItem(
      'lecture-live-auth',
      JSON.stringify({
        state: {
          user: USER_B,
          sessionBinding: 'binding-b',
          quotas: null,
        },
        version: 0,
      })
    );

    releaseLock();
    await heldMutation;
    await lateA;

    expect(useAuthStore.getState()).toMatchObject({
      user: { id: USER_A.id },
      sessionBinding: 'binding-a',
    });
    expect(getPendingAuthRevocation()).toBeNull();
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(harness.replace).not.toHaveBeenCalled();
  });
});
