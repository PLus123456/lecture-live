import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_COOKIE_MUTATION_LOCK,
  clearPendingAuthRevocation,
  getPendingAuthRevocations,
  parseAuthMutationSession,
  rememberPendingAuthRevocation,
  runAuthCookieMutation,
  runAuthCookieRead,
} from '@/lib/clientAuthCookieMutation';

const originalLocks = navigator.locks;

afterEach(() => {
  for (const binding of getPendingAuthRevocations()) {
    clearPendingAuthRevocation(binding);
  }
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
  vi.unstubAllGlobals();
});

describe('auth cookie mutation ordering', () => {
  it('并发 family 的 pending capability 是集合，清 B 绝不覆盖或误清 A', () => {
    rememberPendingAuthRevocation('binding-a');
    rememberPendingAuthRevocation('binding-b');

    expect(getPendingAuthRevocations()).toEqual([
      'binding-a',
      'binding-b',
    ]);
    clearPendingAuthRevocation('binding-b');
    expect(getPendingAuthRevocations()).toEqual(['binding-a']);
  });

  it('持久化签名 capability 不沿用旧 hash 的 256 字符上限', () => {
    const signedCapability = `v1.${'a'.repeat(300)}.${'b'.repeat(43)}`;
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });

    rememberPendingAuthRevocation(signedCapability);

    expect(getPendingAuthRevocations()).toEqual([signedCapability]);
    expect(localStorage.getItem('lecture-live-pending-auth-revocation-v1')).toBe(
      signedCapability
    );
  });

  it('只接受完整的 auth session 主体，拒绝 2xx 空对象/缺 token', () => {
    expect(parseAuthMutationSession({})).toBeNull();
    expect(
      parseAuthMutationSession({
        user: {
          id: 'u1',
          email: 'u@example.com',
          displayName: 'U',
          role: 'FREE',
        },
      })
    ).toBeNull();
    expect(
      parseAuthMutationSession({
        user: {
          id: 'u1',
          email: 'u@example.com',
          displayName: 'U',
          role: 'FREE',
        },
        token: '__cookie_session__',
      })
    ).toMatchObject({ user: { id: 'u1' }, token: '__cookie_session__' });
  });

  it('普通 API 请求使用与 auth cookie writer 同名的 shared Web Lock', async () => {
    const request = vi.fn(
      async <T>(
        _name: string,
        _options: LockOptions,
        operation: () => Promise<T>
      ) => operation()
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    await expect(runAuthCookieRead(async () => 'headers')).resolves.toBe(
      'headers'
    );
    expect(request).toHaveBeenCalledWith(
      AUTH_COOKIE_MUTATION_LOCK,
      { mode: 'shared' },
      expect.any(Function)
    );
  });

  it('旧 refresh 响应完成后才发送新 login，最终 cookie 不会被旧响应覆盖', async () => {
    let crossTabBarrier: Promise<void> = Promise.resolve();
    const request = vi.fn(
      <T>(
        _name: string,
        _options: LockOptions,
        operation: () => Promise<T>
      ): Promise<T> => {
        const result = crossTabBarrier.then(operation, operation);
        crossTabBarrier = result.then(
          () => undefined,
          () => undefined
        );
        return result;
      }
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    let releaseOldResponse!: () => void;
    const oldResponse = new Promise<void>((resolve) => {
      releaseOldResponse = resolve;
    });
    const order: string[] = [];
    let browserCookie = 'cookie-before';

    const staleRefresh = runAuthCookieMutation(async () => {
      order.push('refresh:start');
      await oldResponse;
      browserCookie = 'cookie-a-successor';
      order.push('refresh:end');
    });
    const newLogin = runAuthCookieMutation(async () => {
      order.push('login:start');
      browserCookie = 'cookie-b';
      order.push('login:end');
    });

    await vi.waitFor(() => expect(order).toEqual(['refresh:start']));
    releaseOldResponse();
    await Promise.all([staleRefresh, newLogin]);

    expect(browserCookie).toBe('cookie-b');
    expect(order).toEqual([
      'refresh:start',
      'refresh:end',
      'login:start',
      'login:end',
    ]);
    expect(request).toHaveBeenNthCalledWith(
      1,
      AUTH_COOKIE_MUTATION_LOCK,
      { mode: 'exclusive' },
      expect.any(Function)
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      AUTH_COOKIE_MUTATION_LOCK,
      { mode: 'exclusive' },
      expect.any(Function)
    );
  });
});
