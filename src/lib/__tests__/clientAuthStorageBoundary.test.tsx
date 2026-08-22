import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  return {
    backing,
    cleanup: vi.fn(async (): Promise<void> => undefined),
  };
});

vi.mock('@/lib/clientAccountCleanup', () => ({
  clearAccountBoundClientState: harness.cleanup,
}));

import { handleExternalAuthStorageBoundary } from '@/lib/clientAuthStorageBoundary';
import { useAuthStore } from '@/stores/authStore';

const USER_A = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: 'A',
  role: 'FREE' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({
    user: USER_A,
    token: '__cookie_session__',
    sessionBinding: 'binding-a',
    quotas: null,
    sessionChecked: true,
  });
});

describe('cross-tab auth storage boundary', () => {
  it('先匿名并完成两轮异步清扫，期间不覆盖来源 Tab 的值，最后才 reload', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    harness.cleanup
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSecond = resolve;
          })
      );

    const incoming = JSON.stringify({
      state: {
        user: { id: 'user-b' },
        sessionBinding: 'binding-b',
        quotas: null,
      },
      version: 0,
    });
    localStorage.setItem('lecture-live-auth', incoming);
    const reload = vi.fn();

    const handling = handleExternalAuthStorageBoundary(incoming, reload);

    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem('lecture-live-auth')).toBe(incoming);
    expect(reload).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    releaseFirst();
    await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'));
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem('lecture-live-auth')).toBe(incoming);

    releaseSecond();
    await expect(handling).resolves.toBe(true);
    expect(harness.cleanup).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('lecture-live-auth')).toBe(incoming);
  });
});
