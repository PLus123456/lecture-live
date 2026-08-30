import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT_BOUNDARY_EVENT = 'lecture-live:account-boundary-clear';

const harness = vi.hoisted(() => {
  const localStorageBacking = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageBacking.get(key) ?? null,
      setItem: (key: string, value: string) =>
        localStorageBacking.set(key, String(value)),
      removeItem: (key: string) => localStorageBacking.delete(key),
      clear: () => localStorageBacking.clear(),
      key: (index: number) => [...localStorageBacking.keys()][index] ?? null,
      get length() {
        return localStorageBacking.size;
      },
    },
  });
  return {
    localStorageBacking,
    cleanupBoundary: vi.fn(async () => undefined),
    pollAsyncTranscribeStatus: vi.fn(),
  };
});

vi.mock('@/lib/clientAccountCleanup', () => ({
  ACCOUNT_BOUNDARY_CLEAR_EVENT: 'lecture-live:account-boundary-clear',
  clearAccountBoundClientState: harness.cleanupBoundary,
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/transcribe/asyncUploadClient', () => ({
  pollAsyncTranscribeStatus: harness.pollAsyncTranscribeStatus,
}));

import UploadJobsTracker from '@/components/global/UploadJobsTracker';
import {
  AUTH_PERSIST_STORAGE_KEY,
  useAuthStore,
} from '@/stores/authStore';
import {
  uploadJobs,
  useUploadJobsStore,
} from '@/stores/uploadJobsStore';

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

const originalLocks = navigator.locks;

function persistBoundary(user: typeof USER_A, sessionBinding: string): void {
  localStorage.setItem(
    AUTH_PERSIST_STORAGE_KEY,
    JSON.stringify({
      state: { user, sessionBinding, quotas: null },
      version: 0,
    }),
  );
}

function immediateSharedLocks(): void {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(
        async <T,>(
          _name: string,
          _options: LockOptions,
          operation: () => Promise<T>,
        ) => operation(),
      ),
    },
  });
}

function activeResponse(jobs: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ jobs }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  uploadJobs.clearForAccountSwitch();
  useUploadJobsStore.setState({ jobs: {} });
  harness.cleanupBoundary.mockImplementation(async () => {
    window.dispatchEvent(new Event(ACCOUNT_BOUNDARY_EVENT));
    uploadJobs.clearForAccountSwitch();
  });
  useAuthStore.setState({
    user: USER_A,
    token: '__cookie_session__',
    sessionBinding: 'binding-a',
    quotas: null,
    sessionChecked: true,
  });
  persistBoundary(USER_A, 'binding-a');
  immediateSharedLocks();
});

afterEach(() => {
  cleanup();
  uploadJobs.clearForAccountSwitch();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
  vi.unstubAllGlobals();
});

describe('UploadJobsTracker account boundary', () => {
  it('A DELETE 的迟到 AbortError 在 B cleanup 后不再 upsert A，且 B 会重新 reconciliation', async () => {
    let activeCallCount = 0;
    let deleteStarted!: () => void;
    const deleteWasStarted = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    let rejectLateDelete!: (error: unknown) => void;
    const lateDelete = new Promise<Response>((_resolve, reject) => {
      rejectLateDelete = reject;
    });
    let deleteSignal: AbortSignal | null = null;

    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/sessions/active-async') {
          activeCallCount += 1;
          return Promise.resolve(
            activeCallCount === 1
              ? activeResponse([
                  {
                    id: 'session-a',
                    title: 'A-private-upload.mp3',
                    asyncTranscribeStatus: 'uploading_chunks',
                    asyncTranscribeError: null,
                  },
                ])
              : activeResponse([]),
          );
        }
        if (url === '/api/sessions/session-a/async-upload') {
          deleteSignal = init?.signal ?? null;
          deleteStarted();
          // Model a fetch implementation that reports the abort only after B's
          // two cleanup passes have completed.
          return lateDelete;
        }
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadJobsTracker />);
    await deleteWasStarted;

    await act(async () => {
      await useAuthStore.getState().setAuth(
        USER_B,
        '__cookie_session__',
        { sessionBinding: 'binding-b' },
      );
    });
    expect(harness.cleanupBoundary).toHaveBeenCalledTimes(2);
    expect(deleteSignal).not.toBeNull();
    expect((deleteSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(useUploadJobsStore.getState().jobs).toEqual({});

    await act(async () => {
      rejectLateDelete(new DOMException('boundary changed', 'AbortError'));
      await Promise.resolve();
    });

    await waitFor(() => expect(activeCallCount).toBe(2));
    expect(useUploadJobsStore.getState().jobs).toEqual({});
    expect(localStorage.getItem('lecture-live-upload-jobs')).not.toContain(
      'A-private-upload.mp3',
    );
    expect(harness.pollAsyncTranscribeStatus).not.toHaveBeenCalled();
  });

  it('同一主体的 uploading_chunks 僵尸任务仍会清服务端并显示 interrupted', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/sessions/active-async') {
          return activeResponse([
            {
              id: 'session-a',
              title: 'ordinary-upload.mp3',
              asyncTranscribeStatus: 'uploading_chunks',
              asyncTranscribeError: null,
            },
          ]);
        }
        if (url === '/api/sessions/session-a/async-upload') {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadJobsTracker />);

    await waitFor(() => {
      const [job] = Object.values(useUploadJobsStore.getState().jobs);
      expect(job).toMatchObject({
        fileName: 'ordinary-upload.mp3',
        sessionId: 'session-a',
        status: 'failed',
        errorMessage: 'upload.interrupted',
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/session-a/async-upload',
      expect.objectContaining({ method: 'DELETE', signal: expect.any(AbortSignal) }),
    );
    expect(localStorage.getItem('lecture-live-upload-jobs')).toContain(
      'ordinary-upload.mp3',
    );
  });

  it('同一主体的服务端 pipeline 仍会重挂 poll、注册 handle 并正常完成', async () => {
    let finishPoll!: (value: {
      finalStatus: 'completed';
    }) => void;
    const pollPromise = new Promise<{ finalStatus: 'completed' }>((resolve) => {
      finishPoll = resolve;
    });
    harness.pollAsyncTranscribeStatus.mockReturnValue(pollPromise);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/sessions/active-async') {
          return activeResponse([
            {
              id: 'session-running',
              title: 'running-upload.mp3',
              asyncTranscribeStatus: 'transcoding',
              asyncTranscribeError: null,
            },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<UploadJobsTracker />);

    await waitFor(() => {
      expect(harness.pollAsyncTranscribeStatus).toHaveBeenCalledTimes(1);
    });
    const [job] = Object.values(useUploadJobsStore.getState().jobs);
    expect(job).toMatchObject({
      fileName: 'running-upload.mp3',
      sessionId: 'session-running',
      status: 'transcoding',
    });
    expect(uploadJobs.hasCancel(job.id)).toBe(true);
    expect(harness.pollAsyncTranscribeStatus).toHaveBeenCalledWith(
      'session-running',
      '__cookie_session__',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => {
      finishPoll({ finalStatus: 'completed' });
      await pollPromise;
    });

    await waitFor(() => {
      expect(useUploadJobsStore.getState().jobs[job.id]?.status).toBe(
        'completed',
      );
    });
    expect(uploadJobs.hasCancel(job.id)).toBe(false);
  });
});
