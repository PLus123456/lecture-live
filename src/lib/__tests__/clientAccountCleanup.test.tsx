import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const storage = (backing: Map<string, string>) => ({
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, String(value)),
    removeItem: (key: string) => backing.delete(key),
    clear: () => backing.clear(),
    key: (index: number) => [...backing.keys()][index] ?? null,
    get length() { return backing.size; },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage(local),
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage(session),
  });
  return {
    local,
    session,
    teardownRecordings: vi.fn(async (): Promise<void> => undefined),
    clearAudio: vi.fn(async (): Promise<void> => undefined),
    cacheKeys: vi.fn(async () => ['private-images', 'runtime-cache']),
    cacheDelete: vi.fn(async () => true),
    createObjectUrl: vi.fn(() => 'blob:private-account-object'),
    revokeObjectUrl: vi.fn(),
  };
});

vi.mock('@/lib/audio/audioChunkStore', () => ({
  clearAllAudioArchives: harness.clearAudio,
}));
vi.mock('@/lib/audio/recordingArchiveRegistry', () => ({
  teardownActiveRecordingArchivesForAccountBoundary:
    harness.teardownRecordings,
}));

import { clearAccountBoundClientState } from '@/lib/clientAccountCleanup';
import { createAccountObjectUrl } from '@/lib/accountObjectUrls';
import {
  getAuthBoundaryAbortSignal,
  getAuthBoundarySnapshot,
  isAuthBoundaryCurrent,
  useAuthStore,
} from '@/stores/authStore';
import { useConversationListStore } from '@/stores/conversationListStore';
import { useKeywordStore } from '@/stores/keywordStore';
import { useLiveShareStore } from '@/stores/liveShareStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSharedLinksStore } from '@/stores/sharedLinksStore';
import { useSummaryStore } from '@/stores/summaryStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { uploadJobs, useUploadJobsStore } from '@/stores/uploadJobsStore';

const USER_A = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: 'A',
  role: 'FREE' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const USER_B = { ...USER_A, id: 'user-b', email: 'b@example.com', displayName: 'B' };

beforeEach(() => {
  vi.clearAllMocks();
  harness.local.clear();
  harness.session.clear();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { keys: harness.cacheKeys, delete: harness.cacheDelete },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: harness.createObjectUrl,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: harness.revokeObjectUrl,
  });
  useAuthStore.setState({
    user: null,
    token: null,
    quotas: null,
    sessionChecked: false,
  });
});

describe('clearAccountBoundClientState', () => {
  it('统一清 store、任务/媒体、持久存储、IndexedDB 与 Cache Storage', async () => {
    useConversationListStore.setState({
      items: [{ id: 'c1', title: 'private' }] as never,
    });
    useSharedLinksStore.getState().rememberViewedLink({
      token: 'share-secret',
      url: '/share/secret',
      sessionId: 's1',
      title: 'private',
      sourceLang: 'en',
      targetLang: 'zh',
      status: 'LIVE',
      viewedAt: new Date().toISOString(),
    });
    useTranscriptStore.setState({ segments: [{ id: 'private-segment' }] as never });
    useTranslationStore.getState().setTranslation('seg-1', 'private translation');
    useSummaryStore.setState({ runningContext: 'private summary' });
    useKeywordStore.getState().addKeywords([
      { text: 'private keyword', active: true, source: 'manual' } as never,
    ]);
    useLiveShareStore.getState().setSharing(true, 'live-secret');
    useToastStore.getState().info('private toast');

    const cancel = vi.fn();
    const jobId = uploadJobs.create({
      fileName: 'private.mp4',
      fileSize: 12,
      sourceLang: 'en',
      targetLang: 'zh',
    });
    uploadJobs.registerCancel(jobId, cancel);

    const stopTrack = vi.fn();
    useSettingsStore.setState({
      topic: 'private topic',
      terms: ['private term'],
      pendingSessionId: 's1',
      pendingSessionTerms: ['private'],
      pendingSystemStream: { getTracks: () => [{ stop: stopTrack }] } as never,
    });
    localStorage.setItem('lecture-live-viewed-share-links', 'secret');
    localStorage.setItem('lecture-live-upload-jobs', 'secret');
    sessionStorage.setItem('lecture-live-transcript', 'secret');
    sessionStorage.setItem('lecture-live-archive-state:s1', 'secret');
    createAccountObjectUrl(new Blob(['private']));

    await clearAccountBoundClientState();

    expect(useConversationListStore.getState().items).toBeNull();
    expect(useSharedLinksStore.getState().viewedLinks).toEqual([]);
    expect(useTranscriptStore.getState().segments).toEqual([]);
    expect(useTranslationStore.getState().translations).toEqual({});
    expect(useSummaryStore.getState().runningContext).toBe('');
    expect(useKeywordStore.getState().keywords).toEqual([]);
    expect(useLiveShareStore.getState().shareToken).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useUploadJobsStore.getState().jobs).toEqual({});
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState()).toMatchObject({
      topic: '',
      terms: [],
      pendingSessionId: null,
      pendingSystemStream: null,
    });
    expect(localStorage.getItem('lecture-live-viewed-share-links')).toBeNull();
    expect(localStorage.getItem('lecture-live-upload-jobs')).toBeNull();
    expect(sessionStorage.getItem('lecture-live-transcript')).toBeNull();
    expect(sessionStorage.getItem('lecture-live-archive-state:s1')).toBeNull();
    expect(harness.teardownRecordings).toHaveBeenCalledTimes(1);
    expect(harness.clearAudio).toHaveBeenCalledTimes(1);
    expect(harness.cacheDelete).toHaveBeenCalledWith('private-images');
    expect(harness.cacheDelete).toHaveBeenCalledWith('runtime-cache');
    expect(harness.revokeObjectUrl).toHaveBeenCalledWith(
      'blob:private-account-object'
    );
  });

  it('await active recording teardown before clearing IndexedDB', async () => {
    let releaseTeardown!: () => void;
    harness.teardownRecordings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTeardown = resolve;
        })
    );

    const cleanup = clearAccountBoundClientState();
    await vi.waitFor(() => expect(releaseTeardown).toBeTypeOf('function'));

    // The old recorder may still have an IDB transaction in flight. Clearing
    // before teardown settles would allow that transaction to resurrect A.
    expect(harness.clearAudio).not.toHaveBeenCalled();

    releaseTeardown();
    await cleanup;
    expect(harness.clearAudio).toHaveBeenCalledTimes(1);
  });

  it('持久清理失败时拒绝确认完成，换号保持匿名且不提交新主体', async () => {
    useAuthStore.setState({
      user: USER_A,
      token: 'a',
      sessionBinding: 'binding-a',
      sessionChecked: true,
    });
    harness.clearAudio.mockRejectedValueOnce(new Error('idb unavailable'));
    await expect(clearAccountBoundClientState()).rejects.toThrow(
      'Account-bound persistent state cleanup failed'
    );

    harness.clearAudio
      .mockRejectedValueOnce(new Error('idb unavailable'))
      .mockRejectedValueOnce(new Error('idb unavailable'));
    await expect(
      useAuthStore.getState().setAuth(USER_B, '__cookie_session__', {
        sessionBinding: 'binding-b',
      })
    ).resolves.toBe(false);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      token: null,
      sessionBinding: null,
      sessionChecked: false,
    });
  });

  it('direct user switch 在建立新主体前清掉上一账号；同主体刷新不误清', async () => {
    useAuthStore.setState({ user: USER_A, token: 'a', sessionChecked: true });
    useSharedLinksStore.setState({
      viewedLinks: [{ token: 'old-account' }] as never,
    });

    await useAuthStore.getState().setAuth(USER_B, '__cookie_session__');
    expect(useAuthStore.getState().user?.id).toBe(USER_B.id);
    expect(useSharedLinksStore.getState().viewedLinks).toEqual([]);
    expect(harness.clearAudio).toHaveBeenCalledTimes(2);

    harness.clearAudio.mockClear();
    await useAuthStore.getState().setAuth(USER_B, '__cookie_session__');
    expect(harness.clearAudio).not.toHaveBeenCalled();
  });

  it('logout 清 auth 状态与其 persist key', async () => {
    useAuthStore.setState({ user: USER_A, token: 'a', sessionChecked: true });
    localStorage.setItem('lecture-live-auth', 'old-user');
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState()).toMatchObject({ user: null, token: null, quotas: null });
    expect(localStorage.getItem('lecture-live-auth')).toBeNull();
  });

  it('主体切换先匿名/abort 旧 epoch，并用第二轮清扫擦除异步窗口中的 A 回写', async () => {
    useAuthStore.setState({
      user: USER_A,
      token: 'a',
      sessionBinding: 'binding-a',
      sessionChecked: true,
    });
    const oldBoundary = getAuthBoundarySnapshot();
    const oldSignal = getAuthBoundaryAbortSignal();

    let releaseFirstCleanup!: () => void;
    harness.clearAudio.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstCleanup = resolve;
        })
    );

    const switching = useAuthStore.getState().setAuth(
      USER_B,
      '__cookie_session__',
      { sessionBinding: 'binding-b', expected: oldBoundary }
    );

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      sessionChecked: false,
    });
    expect(oldSignal.aborted).toBe(true);
    expect(isAuthBoundaryCurrent(oldBoundary)).toBe(false);

    await vi.waitFor(() => expect(releaseFirstCleanup).toBeTypeOf('function'));
    // 模拟一个未遵守 AbortSignal、已排进微任务的旧 A consumer 在首轮异步清扫窗口回写。
    useSharedLinksStore.setState({
      viewedLinks: [{ token: 'late-a-write' }] as never,
    });
    releaseFirstCleanup();

    await expect(switching).resolves.toBe(true);
    expect(useAuthStore.getState()).toMatchObject({
      user: USER_B,
      sessionBinding: 'binding-b',
    });
    expect(useSharedLinksStore.getState().viewedLinks).toEqual([]);
    expect(harness.clearAudio).toHaveBeenCalledTimes(2);
  });

  it('logout 清扫期间被 B 边界取代时返回 false，调用方不得把 B 误判成 invalid', async () => {
    useAuthStore.setState({
      user: USER_A,
      token: '__cookie_session__',
      sessionBinding: 'binding-a',
      sessionChecked: true,
    });
    const expectedA = getAuthBoundarySnapshot();
    let releaseLogoutCleanup!: () => void;
    harness.clearAudio.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseLogoutCleanup = resolve;
        })
    );

    const logoutA = useAuthStore.getState().logout({ expected: expectedA });
    const loginB = useAuthStore.getState().setAuth(
      USER_B,
      '__cookie_session__',
      { sessionBinding: 'binding-b' }
    );
    await vi.waitFor(() => expect(releaseLogoutCleanup).toBeTypeOf('function'));
    releaseLogoutCleanup();

    await expect(logoutA).resolves.toBe(false);
    await expect(loginB).resolves.toBe(true);
    expect(useAuthStore.getState()).toMatchObject({
      user: USER_B,
      sessionBinding: 'binding-b',
      sessionChecked: true,
    });
  });
});
