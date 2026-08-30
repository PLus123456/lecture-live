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
    startRecording: vi.fn(),
  };
});

vi.mock('@/lib/soniox/client', () => ({
  buildSonioxConfig: vi.fn(() => ({})),
  startSonioxRecording: (...args: unknown[]) => harness.startRecording(...args),
}));

vi.mock('@/lib/soniox/tokenProcessor', () => ({
  TokenProcessor: class {
    setLanguagePair() {}
    processTokens() {}
    onEndpoint() {}
  },
}));

import { useInterpret } from '@/hooks/useInterpret';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';

const USER_A = {
  id: 'interpret-a',
  email: 'a@example.com',
  displayName: 'A',
  role: 'FREE' as const,
  createdAt: '2026-08-20T00:00:00.000Z',
};
const USER_B = { ...USER_A, id: 'interpret-b', email: 'b@example.com' };

function persistBoundary(user: typeof USER_A, sessionBinding: string) {
  localStorage.setItem(
    'lecture-live-auth',
    JSON.stringify({
      state: { user, sessionBinding, quotas: null },
      version: 0,
    })
  );
}

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
  persistBoundary(USER_A, 'binding-a');
  useSettingsStore.setState({
    endpointDetectionMs: 800,
    sonioxRegionPreference: 'auto',
  } as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ anchorId: 'anchor-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
});

describe('useInterpret account-bound capabilities', () => {
  it('stops a recording handle that resolves after the account boundary changed', async () => {
    let release!: (value: unknown) => void;
    const lateStop = vi.fn(async () => undefined);
    harness.startRecording.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const { result } = renderHook(() => useInterpret());
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start('en', 'zh');
    });
    await waitFor(() => expect(harness.startRecording).toHaveBeenCalledTimes(1));

    act(() => {
      useAuthStore.setState({
        user: USER_B,
        token: '__cookie_session__',
        sessionBinding: 'binding-b',
      });
      persistBoundary(USER_B, 'binding-b');
      window.dispatchEvent(
        new Event('lecture-live:account-boundary-clear')
      );
    });

    await act(async () => {
      release({
        recording: { stop: lateStop },
        client: {},
        temporaryKey: { max_session_duration_seconds: 300 },
      });
      await startPromise;
    });

    expect(lateStop).toHaveBeenCalledTimes(1);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.connectionState).toBe('disconnected');
  });
});
