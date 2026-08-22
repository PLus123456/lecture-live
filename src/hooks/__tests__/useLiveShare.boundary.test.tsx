import { act, renderHook, waitFor } from '@testing-library/react';
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
    broadcasterConstructed: vi.fn(),
    broadcasterDisconnect: vi.fn(),
  };
});

vi.mock('@/lib/clientAccountCleanup', () => ({
  clearAccountBoundClientState: vi.fn(async () => undefined),
}));
vi.mock('@/lib/liveShare/broadcaster', () => ({
  LiveBroadcaster: class {
    constructor(...args: unknown[]) {
      harness.broadcasterConstructed(...args);
    }
    disconnect() {
      harness.broadcasterDisconnect();
    }
    broadcastStatusUpdate() {}
  },
}));
vi.mock('@/lib/liveShare/viewer', () => ({
  LiveViewer: class {
    connect() {}
    disconnect() {}
  },
}));

import {
  disconnectLiveShareForAccountSwitch,
  useLiveShare,
} from '@/hooks/useLiveShare';
import { useAuthStore } from '@/stores/authStore';
import { useLiveShareStore } from '@/stores/liveShareStore';

const USER_A = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: 'A',
  role: 'FREE' as const,
  createdAt: '2026-08-20T00:00:00.000Z',
};
const USER_B = { ...USER_A, id: 'user-b', email: 'b@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  harness.backing.clear();
  disconnectLiveShareForAccountSwitch();
  useAuthStore.setState({
    user: USER_A,
    token: '__cookie_session__',
    sessionBinding: 'binding-a',
    quotas: null,
    sessionChecked: true,
  });
  useLiveShareStore.getState().reset();
});

describe('useLiveShare account-bound commit', () => {
  it('A share JSON 返回后 B 先提交时，不构造或持久化 A broadcaster', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ token: 'share-token-a' }), {
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
          releaseCommit = () => operation().then(resolve, reject);
        })
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    const { result } = renderHook(() => useLiveShare());

    const start = result.current.startSharing('session-a');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
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
    releaseCommit();

    let value: unknown;
    await act(async () => {
      value = await start;
    });
    expect(value).toBeNull();
    expect(harness.broadcasterConstructed).not.toHaveBeenCalled();
    expect(useLiveShareStore.getState()).toMatchObject({
      isSharing: false,
      shareToken: null,
    });
  });
});
