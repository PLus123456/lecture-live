import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 会话页（/session/[id]）全局实时 store 归属 / 收尾回归锁。
 *
 * 前提事实：Next App Router 按动态段的段值给子树作 key，/session/A → /session/B 会**卸载并
 * 重挂**页面组件；但 transcript/translation/summary store 是 SPA 内存单例（并持久化到
 * sessionStorage），A 的数据会原样留给 B 的首帧。本文件锁住：
 *   - #1 B 挂载时不得把 A 的转录 PUT 进 B 的草稿（服务端草稿只增不减、收尾取段数多的一方）
 *   - #2 冷恢复必须绑定 activeSessionId；未绑定的 store 一律按外来数据处理
 *   - R5 开录撞并发闸 409 → 停录 + 明确提示，不再误报「会话已被回收」
 *   - #5 元信息未拉回时收尾不得带英文占位标题覆盖服务端标题
 *   - R4 刷新后 FINALIZING 恢复：本机分片补全前不得重试 finalize（否则截掉尾部音频）
 */

const routerMocks = vi.hoisted(() => {
  const replace = vi.fn();
  const push = vi.fn();
  return {
    replace,
    push,
    currentSessionId: { value: 'sess-a' },
    router: { replace, push, back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: routerMocks.currentSessionId.value }),
  useRouter: () => routerMocks.router,
}));

const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));

vi.mock('@/stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    show: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const sonioxMocks = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  pause: vi.fn(),
  switchMicrophone: vi.fn(async () => {}),
  rebuildSession: vi.fn(async () => {}),
  reconnectAfterRefresh: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  finalizeRemoteDraft: vi.fn(async () => true),
}));
// 记下页面传给 useSoniox 的回调（服务端时长闸的 onSessionDurationLimit 由测试直接触发）。
const sonioxOptions = vi.hoisted(() => ({
  current: null as null | { onSessionDurationLimit?: (limitMs: number | null) => void },
}));
vi.mock('@/hooks/useSoniox', () => ({
  useSoniox: (_sessionId: unknown, options: unknown) => {
    sonioxOptions.current = options as typeof sonioxOptions.current;
    return sonioxMocks;
  },
}));

const summaryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  onNewSentence: vi.fn(),
  triggerManual: vi.fn(),
  flush: vi.fn(async () => true),
  reset: vi.fn(),
}));
vi.mock('@/hooks/useSummary', () => ({ useSummary: () => summaryMocks }));

vi.mock('@/hooks/useTranslation', () => ({
  useLocalTranslation: () => ({
    initLocal: vi.fn(),
    translateSentence: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock('@/hooks/useLiveShare', () => ({
  useLiveShare: () => ({
    broadcaster: null,
    isSharing: false,
    shareToken: null,
    startSharing: vi.fn(),
    stopSharing: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ restoreSession: async () => true }),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

vi.mock('@/lib/soniox/clientPing', () => ({
  pingAllRegions: async () => [],
  setCachedPingResults: () => {},
}));

/* 本机 IndexedDB 分片（R4）：按测试配置返回 */
const chunkStoreMocks = vi.hoisted(() => ({
  localSeqs: [] as number[],
}));
vi.mock('@/lib/audio/audioChunkStore', () => ({
  getAudioChunkEntries: vi.fn(async () =>
    chunkStoreMocks.localSeqs.map((seq) => ({ seq, blob: new Blob(['x']) }))
  ),
  clearAudioChunks: vi.fn(async () => {}),
}));

vi.mock('@/components/Sidebar', () => ({ default: () => null }));
vi.mock('@/components/UserSettingsModal', () => ({ default: () => null }));
vi.mock('@/components/TranscriptPanel', () => ({ default: () => null }));
vi.mock('@/components/SettingsDrawer', () => ({ default: () => null }));
vi.mock('@/components/ExportModal', () => ({ default: () => null }));
vi.mock('@/components/mobile/MobileSessionLayout', () => ({ default: () => null }));
vi.mock('@/components/session/LiveShareBadge', () => ({ default: () => null }));
vi.mock('@/components/FlagImg', () => ({ default: () => null }));
vi.mock('@/components/session/AiPanel', () => ({ default: () => null }));
vi.mock('@/components/session/SessionFinalizingOverlay', () => ({
  SessionFinalizingOverlay: () => null,
}));
vi.mock('@/components/session/PipReferenceTool', () => ({
  usePipReferenceTool: () => ({
    isOpen: false,
    mode: 'inline',
    pipWindow: null,
    pinned: false,
    setPinned: () => {},
    close: () => {},
    toggle: () => {},
    videoPipUpdate: () => {},
  }),
  PipPortal: () => null,
  InlinePipPanel: () => null,
  VideoPipBridge: () => null,
}));

/* zustand persist 写 localStorage 会在 vitest 里抛错：先换内存实现再动态加载 */
const memStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memStorage.set(k, String(v));
    },
    removeItem: (k: string) => {
      memStorage.delete(k);
    },
    clear: () => memStorage.clear(),
    key: () => null,
    length: 0,
  },
});

const { default: ActiveSessionPage } = await import('@/app/session/[id]/page');
const { useAuthStore } = await import('@/stores/authStore');
const { useSettingsStore } = await import('@/stores/settingsStore');
const { useTranscriptStore } = await import('@/stores/transcriptStore');
const { useTranslationStore } = await import('@/stores/translationStore');
const { useSummaryStore } = await import('@/stores/summaryStore');
const { toast } = await import('@/stores/toastStore');

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): FakeResponse {
  return { ok: init?.ok ?? true, status: init?.status ?? 200, json: async () => body };
}

let sessionMeta: Record<string, FakeResponse>;
let draftBody: Record<string, unknown>;
let remoteAudioSeqs: Record<string, number[]>;
let patchResponse: (sessionId: string, status: string) => FakeResponse;
let patchCalls: Array<{ sessionId: string; status?: string }>;
let draftPuts: Array<{ sessionId: string; texts: string[] }>;
let finalizeCalls: Array<{ sessionId: string; body: Record<string, unknown> }>;

function sessionIdFromUrl(url: string): string {
  return decodeURIComponent(url.split('/api/sessions/')[1]?.split(/[/?]/)[0] ?? '');
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<unknown> => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      if (url.includes('/api/soniox/ping')) return jsonResponse({ ok: true });
      if (url.includes('/api/users/quota')) {
        return jsonResponse({
          quotas: {
            transcriptionMinutesUsed: 0,
            transcriptionMinutesLimit: 600,
            remainingTranscriptionMinutes: 600,
            storageMbUsed: 0,
            storageMbLimit: 1024,
            featureFlags: {},
          },
        });
      }
      if (url.includes('/transcript/draft')) {
        const id = sessionIdFromUrl(url);
        if (method === 'PUT') {
          draftPuts.push({
            sessionId: id,
            texts: (body?.segments ?? []).map((s: { text: string }) => s.text),
          });
          return jsonResponse({ success: true });
        }
        return jsonResponse(draftBody[id] ?? { exists: false });
      }
      if (url.includes('/audio/draft')) {
        const id = sessionIdFromUrl(url);
        return jsonResponse({ seqs: remoteAudioSeqs[id] ?? [] });
      }
      if (url.endsWith('/finalize')) {
        const id = sessionIdFromUrl(url);
        finalizeCalls.push({ sessionId: id, body: body ?? {} });
        return jsonResponse({ success: true });
      }
      if (url.includes('/api/sessions/')) {
        const id = sessionIdFromUrl(url);
        if (method === 'PATCH') {
          patchCalls.push({ sessionId: id, status: body?.status });
          return patchResponse(id, body?.status);
        }
        const res = sessionMeta[id];
        if (!res) return new Promise<never>(() => {});
        return res;
      }
      return jsonResponse({});
    })
  );
}

function resetStores() {
  useTranscriptStore.getState().clearAll();
  useTranslationStore.getState().clearAll();
  useSummaryStore.getState().clearAll();
  useSettingsStore.setState({ pendingAutoStart: false, translationMode: 'soniox' });
  useAuthStore.setState({
    user: { id: 'u-1', email: 'u@test', displayName: 'U', role: 'PRO' } as never,
    token: 'test-token',
    quotas: null,
  });
}

function seg(id: string, text: string, startMs: number) {
  return {
    id,
    text,
    language: 'en',
    globalStartMs: startMs,
    globalEndMs: startMs + 1000,
    startMs,
    endMs: startMs + 1000,
    isFinal: true,
    sessionIndex: 0,
  } as never;
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('会话页：全局实时 store 归属与收尾', () => {
  beforeEach(() => {
    sessionStorage.clear();
    memStorage.clear();
    sessionMeta = {};
    draftBody = {};
    remoteAudioSeqs = {};
    patchCalls = [];
    draftPuts = [];
    finalizeCalls = [];
    patchResponse = () => jsonResponse({ ok: true });
    chunkStoreMocks.localSeqs = [];
    routerMocks.currentSessionId.value = 'sess-a';
    routerMocks.replace.mockClear();
    routerMocks.push.mockClear();
    Object.values(sonioxMocks).forEach((fn) => fn.mockClear());
    sonioxMocks.finalizeRemoteDraft.mockImplementation(async () => true);
    vi.mocked(toast.error).mockClear();
    resetStores();
    installFetch();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('#1：A 暂停中导航到 B（页面卸载重挂），B 不得把 A 的转录 PUT 进 B 的草稿', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '甲课', status: 'PAUSED', sourceLang: 'en', targetLang: 'zh' });
    sessionMeta['sess-b'] = jsonResponse({ id: 'sess-b', title: '乙课', status: 'CREATED', sourceLang: 'en', targetLang: 'zh' });
    useTranscriptStore.setState({
      recordingState: 'paused',
      activeSessionId: 'sess-a',
      recordingStartTime: Date.now() - 60_000,
      pausedAt: Date.now() - 1000,
      segments: [seg('seg-1', 'A 的第一句', 0), seg('seg-2', 'A 的第二句', 1000)],
    });

    const pageA = render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('甲课');
    });
    pageA.unmount();
    // A 卸载时把自己的转录冲刷到 A 的草稿（既有 P0-3(b) 行为，必须保留）
    expect(draftPuts.some((p) => p.sessionId === 'sess-a')).toBe(true);

    routerMocks.currentSessionId.value = 'sess-b';
    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课');
    });
    await flushMicrotasks();

    expect(draftPuts.filter((p) => p.sessionId === 'sess-b')).toHaveLength(0);
    // B 判定 store 不归属自己 → 清空，不展示 A 的转录
    expect(useTranscriptStore.getState().segments).toHaveLength(0);
    expect(patchCalls.filter((c) => c.sessionId === 'sess-b')).toHaveLength(0);
  });

  it('#1 正向对照：同会话刷新恢复（store 绑定本会话）仍会立即补传草稿', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '甲课', status: 'PAUSED', sourceLang: 'en', targetLang: 'zh' });
    useTranscriptStore.setState({
      recordingState: 'paused',
      activeSessionId: 'sess-a',
      recordingStartTime: Date.now() - 60_000,
      pausedAt: Date.now() - 1000,
      segments: [seg('seg-1', 'A 的第一句', 0)],
    });

    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(draftPuts.filter((p) => p.sessionId === 'sess-a').length).toBeGreaterThan(0);
    });
    expect(draftPuts[0].texts).toEqual(['A 的第一句']);
  });

  it('#2：冷恢复会绑定 activeSessionId；之后进入新会话 B，B 不展示/不回写/不 PUT A 的数据', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '甲课', status: 'PAUSED', sourceLang: 'en', targetLang: 'zh' });
    sessionMeta['sess-b'] = jsonResponse({ id: 'sess-b', title: '乙课', status: 'CREATED', sourceLang: 'en', targetLang: 'zh' });
    draftBody['sess-a'] = {
      exists: true,
      payload: {
        segments: [
          { id: 'seg-1', text: 'A 草稿一', language: 'en', globalStartMs: 0, globalEndMs: 1000 },
          { id: 'seg-2', text: 'A 草稿二', language: 'en', globalStartMs: 1000, globalEndMs: 2000 },
        ],
        totalDurationMs: 2000,
      },
    };

    const pageA = render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(useTranscriptStore.getState().segments).toHaveLength(2);
    });
    expect(useTranscriptStore.getState().recordingState).toBe('paused');
    expect(useTranscriptStore.getState().activeSessionId).toBe('sess-a');
    pageA.unmount();

    draftPuts.length = 0;
    routerMocks.currentSessionId.value = 'sess-b';
    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课');
    });
    await flushMicrotasks();

    expect(useTranscriptStore.getState().segments).toHaveLength(0);
    expect(useTranscriptStore.getState().recordingState).toBe('idle');
    expect(patchCalls.filter((c) => c.sessionId === 'sess-b')).toHaveLength(0);
    expect(draftPuts.filter((p) => p.sessionId === 'sess-b')).toHaveLength(0);
    expect(sonioxMocks.reconnectAfterRefresh).not.toHaveBeenCalled();
  });

  it('#2：未绑定却持有 paused 数据的 store（旧冷恢复遗留）按外来数据清空，不当成本会话的刷新恢复', async () => {
    sessionMeta['sess-b'] = jsonResponse({ id: 'sess-b', title: '乙课', status: 'CREATED', sourceLang: 'en', targetLang: 'zh' });
    useTranscriptStore.setState({
      recordingState: 'paused',
      activeSessionId: null,
      recordingStartTime: Date.now() - 60_000,
      pausedAt: Date.now(),
      segments: [seg('seg-1', '来历不明的一句', 0)],
    });
    routerMocks.currentSessionId.value = 'sess-b';

    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课');
    });
    await flushMicrotasks();

    expect(useTranscriptStore.getState().segments).toHaveLength(0);
    expect(patchCalls.filter((c) => c.sessionId === 'sess-b')).toHaveLength(0);
    expect(draftPuts).toHaveLength(0);
  });

  it('#2：冷恢复的草稿响应迟到（页面已卸载）不得写入全局 store', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '甲课', status: 'PAUSED', sourceLang: 'en', targetLang: 'zh' });
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    const baseFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/transcript/draft?full=true')) {
        await draftGate;
        return jsonResponse({
          exists: true,
          payload: {
            segments: [{ id: 'seg-1', text: 'A 迟到的草稿', language: 'en', globalStartMs: 0, globalEndMs: 1000 }],
            totalDurationMs: 1000,
          },
        }) as unknown as Response;
      }
      return baseFetch(input, init) as Promise<Response>;
    });

    const pageA = render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/transcript/draft?full=true'))).toBe(true);
    });
    pageA.unmount();

    await act(async () => {
      releaseDraft();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useTranscriptStore.getState().segments).toHaveLength(0);
    expect(useTranscriptStore.getState().activeSessionId).toBeNull();
  });

  it('R5：开录 PATCH 撞并发闸 409 → 停录、复位 idle、提示并发超限，不误报「会话被回收」', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '甲课', status: 'CREATED', sourceLang: 'en', targetLang: 'zh' });
    patchResponse = (_id, status) =>
      status === 'RECORDING'
        ? jsonResponse(
            { error: 'Too many concurrent recordings in progress (max 1). Finish or discard an existing recording first.' },
            { ok: false, status: 409 }
          )
        : jsonResponse({ ok: true });
    sonioxMocks.start.mockImplementationOnce(async () => {
      useTranscriptStore.getState().setActiveSessionId('sess-a');
      useTranscriptStore.getState().setRecordingState('recording');
    });
    sonioxMocks.stop.mockImplementationOnce(async () => {
      useTranscriptStore.getState().setRecordingState('stopped');
    });
    useSettingsStore.setState({ pendingAutoStart: true });

    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(sonioxMocks.stop).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(useTranscriptStore.getState().recordingState).toBe('idle');
    });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('session.notices.concurrentRecordingLimit');
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith('session.notices.sessionReclaimed');
    expect(screen.getByText('session.notices.concurrentRecordingLimit')).toBeInTheDocument();
  });

  it('服务端单场时长闸拒发 key → 提示「已达时长上限」并收尾（暂停中同样收尾）', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '甲课', status: 'PAUSED', sourceLang: 'en', targetLang: 'zh' });
    useTranscriptStore.setState({
      recordingState: 'paused',
      activeSessionId: 'sess-a',
      recordingStartTime: Date.now() - 60_000,
      pausedAt: Date.now(),
      segments: [seg('seg-1', 'A 的一句', 0)],
    });

    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByTitle('session.actions.stopTitle')).not.toBeDisabled();
    });

    await act(async () => {
      sonioxOptions.current?.onSessionDurationLimit?.(4 * 60 * 60_000);
    });

    await waitFor(() => {
      expect(finalizeCalls).toHaveLength(1);
    });
    expect(sonioxMocks.stop).toHaveBeenCalled();
    expect(screen.getByText('session.notices.maxDurationReached')).toBeInTheDocument();
  });

  it('服务端单场时长闸拒发 key 时本地并未在录（idle）→ 只提示，不收尾', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '甲课', status: 'CREATED', sourceLang: 'en', targetLang: 'zh' });

    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(sonioxOptions.current?.onSessionDurationLimit).toBeTypeOf('function');
    });

    await act(async () => {
      sonioxOptions.current?.onSessionDurationLimit?.(4 * 60 * 60_000);
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('session.notices.maxDurationReached');
    });
    expect(finalizeCalls).toHaveLength(0);
    expect(sonioxMocks.stop).not.toHaveBeenCalled();
  });

  it('#5：元信息拉取失败时，收尾不带英文占位标题（避免覆盖服务端标题）', async () => {
    sessionMeta['sess-a'] = jsonResponse({ error: 'database unavailable' }, { ok: false, status: 500 });
    useTranscriptStore.setState({
      recordingState: 'paused',
      activeSessionId: 'sess-a',
      recordingStartTime: Date.now() - 60_000,
      pausedAt: Date.now(),
      segments: [seg('seg-1', 'A 的一句', 0)],
    });

    const user = userEvent.setup();
    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByTitle('session.actions.stopTitle')).not.toBeDisabled();
    });

    await act(async () => {
      await user.click(screen.getByTitle('session.actions.stopTitle'));
    });

    await waitFor(() => {
      expect(finalizeCalls).toHaveLength(1);
    });
    expect(finalizeCalls[0].body).not.toHaveProperty('title');
  });

  it('#5 正向对照：元信息正常拉回时，收尾照常带上标题', async () => {
    sessionMeta['sess-a'] = jsonResponse({ id: 'sess-a', title: '线性代数 第三讲', status: 'PAUSED', sourceLang: 'en', targetLang: 'zh' });
    useTranscriptStore.setState({
      recordingState: 'paused',
      activeSessionId: 'sess-a',
      recordingStartTime: Date.now() - 60_000,
      pausedAt: Date.now(),
      segments: [seg('seg-1', 'A 的一句', 0)],
    });

    const user = userEvent.setup();
    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('线性代数 第三讲');
    });

    await act(async () => {
      await user.click(screen.getByTitle('session.actions.stopTitle'));
    });

    await waitFor(() => {
      expect(finalizeCalls).toHaveLength(1);
    });
    expect(finalizeCalls[0].body.title).toBe('线性代数 第三讲');
  });

  it('R4：刷新后 FINALIZING 恢复 —— 本机分片未完整补传（finalizeRemoteDraft=false）时不 POST /finalize，补齐后才收尾', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'FINALIZING',
      recordingPath: null,
      sourceLang: 'en',
      targetLang: 'zh',
    });
    chunkStoreMocks.localSeqs = [0, 1, 2];
    // 第一轮：尾块还没传上去（补传缺片 / 完整性校验未过）；第二轮补齐并完成 seal+合并
    sonioxMocks.finalizeRemoteDraft
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => true);

    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('甲课');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(sonioxMocks.finalizeRemoteDraft).toHaveBeenCalledTimes(1);
    expect(finalizeCalls).toHaveLength(0);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('session.finalizing.audioIncomplete');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => {
      expect(finalizeCalls).toHaveLength(1);
    });
    expect(sonioxMocks.finalizeRemoteDraft).toHaveBeenCalledTimes(2);
    expect(finalizeCalls[0].sessionId).toBe('sess-a');
    // 「音频未完整」只提示一次，不随每轮轮询刷屏
    expect(
      vi.mocked(toast.error).mock.calls.filter(([m]) => m === 'session.finalizing.audioIncomplete')
    ).toHaveLength(1);
  });

  it('R4 正向对照：本机没有分片（换设备/已清理）时不走 finalizeRemoteDraft，照常重试 finalize', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'FINALIZING',
      recordingPath: null,
      sourceLang: 'en',
      targetLang: 'zh',
    });
    chunkStoreMocks.localSeqs = [];

    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('甲课');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => {
      expect(finalizeCalls).toHaveLength(1);
    });
    // 草稿为空时合并端点回 404 → finalizeRemoteDraft 恒为 false；绝不能拿它拦截，否则永远卡在 FINALIZING
    expect(sonioxMocks.finalizeRemoteDraft).not.toHaveBeenCalled();
  });

  it('R4 正向对照：录音已定稿（recordingPath 已写入）时直接重试 finalize', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'FINALIZING',
      recordingPath: 'rec/sess-a.webm',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    chunkStoreMocks.localSeqs = [0, 1];

    render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('甲课');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => {
      expect(finalizeCalls).toHaveLength(1);
    });
    expect(sonioxMocks.finalizeRemoteDraft).not.toHaveBeenCalled();
  });
});
