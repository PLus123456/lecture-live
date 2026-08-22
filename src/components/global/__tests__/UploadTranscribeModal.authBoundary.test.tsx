import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    startAsyncUpload: vi.fn(),
    toastShow: vi.fn(),
    toastError: vi.fn(),
    settings: {
      sourceLang: 'en',
      targetLang: 'zh',
      sonioxRegionPreference: 'global',
      setSourceLang: vi.fn(),
      setTargetLang: vi.fn(),
    },
  };
});

vi.mock('@/lib/clientAccountCleanup', () => ({
  ACCOUNT_BOUNDARY_CLEAR_EVENT: 'lecture-live:account-boundary-clear',
  clearAccountBoundClientState: harness.cleanupBoundary,
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ token: '__cookie_session__' }),
}));
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: typeof harness.settings) => unknown) =>
    selector(harness.settings),
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('@/stores/toastStore', () => ({
  toast: {
    show: harness.toastShow,
    error: harness.toastError,
  },
}));
vi.mock('@/lib/transcribe/fileTranscriber', () => ({
  probeAudioDurationMs: vi.fn(async () => 0),
}));
vi.mock('@/lib/transcribe/asyncUploadClient', () => ({
  estimateAsyncTranscribeMs: vi.fn(() => 1_000),
  startAsyncUpload: harness.startAsyncUpload,
}));
vi.mock('@/components/ModalPortal', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ConfirmDialog', () => ({ default: () => null }));
vi.mock('@/components/LanguageSelect', () => ({ default: () => null }));

import UploadTranscribeModal from '@/components/global/UploadTranscribeModal';
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

function immediateSharedLocks() {
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

function mockApiFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/folders') {
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/sessions') {
      return new Response(JSON.stringify({ id: 'session-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  uploadJobs.clearForAccountSwitch();
  useUploadJobsStore.setState({ jobs: {} });
  harness.cleanupBoundary.mockImplementation(async () => {
    window.dispatchEvent(
      new Event('lecture-live:account-boundary-clear'),
    );
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
  mockApiFetch();
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

describe('UploadTranscribeModal account boundary', () => {
  it('B cleanup 在 session JSON 后、registerCancel 前完成时，不复活 A job 或启动 pipeline', async () => {
    let releaseCriticalCommit!: () => void;
    const criticalCommitGate = new Promise<void>((resolve) => {
      releaseCriticalCommit = resolve;
    });
    let reachedCriticalCommit!: () => void;
    const criticalCommitReached = new Promise<void>((resolve) => {
      reachedCriticalCommit = resolve;
    });
    let commitCount = 0;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn(
          <T,>(
            _name: string,
            _options: LockOptions,
            operation: () => Promise<T>,
          ): Promise<T> => {
            commitCount += 1;
            if (commitCount === 2) {
              reachedCriticalCommit();
              return criticalCommitGate.then(operation);
            }
            return Promise.resolve().then(operation);
          },
        ),
      },
    });

    const onClose = vi.fn();
    render(
      <UploadTranscribeModal
        file={new File(['A-private-audio'], 'A-private.mp3', {
          type: 'audio/mpeg',
        })}
        onClose={onClose}
        onNavigate={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'upload.startButton' }),
      );
      await criticalCommitReached;
    });

    const [aJob] = Object.values(useUploadJobsStore.getState().jobs);
    expect(aJob).toMatchObject({
      fileName: 'A-private.mp3',
      status: 'creating',
    });

    await act(async () => {
      await useAuthStore.getState().setAuth(
        USER_B,
        '__cookie_session__',
        { sessionBinding: 'binding-b' },
      );
    });
    expect(harness.cleanupBoundary).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalled();
    expect(useUploadJobsStore.getState().jobs).toEqual({});

    await act(async () => {
      releaseCriticalCommit();
      await criticalCommitGate;
    });

    await waitFor(() => {
      expect(harness.startAsyncUpload).not.toHaveBeenCalled();
      expect(useUploadJobsStore.getState().jobs).toEqual({});
    });
    expect(uploadJobs.hasCancel(aJob.id)).toBe(false);
    expect(localStorage.getItem('lecture-live-upload-jobs')).not.toContain(
      'A-private.mp3',
    );
  });

  it('边界未变化时仍正常启动、注册取消句柄并提交完成状态', async () => {
    let finishPipeline!: (value: {
      sessionId: string;
      finalStatus: 'completed';
    }) => void;
    const pipelinePromise = new Promise<{
      sessionId: string;
      finalStatus: 'completed';
    }>((resolve) => {
      finishPipeline = resolve;
    });
    const cancel = vi.fn();
    harness.startAsyncUpload.mockReturnValue({
      promise: pipelinePromise,
      cancel,
    });

    render(
      <UploadTranscribeModal
        file={new File(['ordinary-audio'], 'ordinary.mp3', {
          type: 'audio/mpeg',
        })}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'upload.startButton' }));

    await waitFor(() => expect(harness.startAsyncUpload).toHaveBeenCalledTimes(1));
    const [job] = Object.values(useUploadJobsStore.getState().jobs);
    expect(job).toMatchObject({
      fileName: 'ordinary.mp3',
      sessionId: 'session-a',
      status: 'creating',
    });
    expect(uploadJobs.hasCancel(job.id)).toBe(true);
    expect(harness.startAsyncUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        authToken: '__cookie_session__',
        signal: expect.any(AbortSignal),
      }),
    );

    await act(async () => {
      finishPipeline({ sessionId: 'session-a', finalStatus: 'completed' });
      await pipelinePromise;
    });

    await waitFor(() => {
      expect(useUploadJobsStore.getState().jobs[job.id]?.status).toBe(
        'completed',
      );
    });
    expect(uploadJobs.hasCancel(job.id)).toBe(false);
    expect(harness.toastShow).toHaveBeenCalledTimes(1);
  });
});
