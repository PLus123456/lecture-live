import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 会话页（/session/[id]）的异步归属 / 时序回归锁。
 *
 * 前提事实：App Router 下同一动态段互跳（/session/A → /session/B）**复用同一个页面组件
 * 实例**，只重跑 effect。所以任何异步回调都必须自证归属，任何"await 之后再读闭包变量"
 * 都是错的。本文件锁住：
 *   - M19 元信息 fetch 的归属守卫（A 的慢响应不得覆盖 B、不得把用户踢到 A 的回放页）
 *   - M19 同族：A 录音中导航到 B，状态回写 effect 不得把 B 也 PATCH 成 RECORDING
 *   - L45 元信息 fetch 不看 res.ok（500 的错误体被当成合法元信息静默放行）
 *   - M20 暂停态注入关键词后不得再补一次 pauseRecording（与 rebuild 内建的暂停保持打架）
 *   - L46 冷恢复灌入的历史段落不得被当成新句子喂进摘要/本地翻译管线
 *   - L47 开麦失败时不得把后端置成 RECORDING（刷新后会变成"幽灵录制中"）
 */

/* ─── next/navigation：sessionId 可变，router.replace 可观测 ─── */
const routerMocks = vi.hoisted(() => {
  const replace = vi.fn();
  const push = vi.fn();
  return {
    replace,
    push,
    currentSessionId: { value: 'sess-a' },
    // 必须是**同一个对象**：真实 useRouter 从 context 拿到的实例是稳定的，
    // 每次返回新对象会让所有把 router 放进依赖数组的 effect 每渲染都重跑。
    router: { replace, push, back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: routerMocks.currentSessionId.value }),
  useRouter: () => routerMocks.router,
}));

/* ─── i18n：t 必须是稳定引用（页面里多个 useCallback 把 t 放进依赖） ─── */
const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));

vi.mock('@/stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

/* ─── 录音/翻译/摘要/直播 hooks：全部替身，句柄引用稳定 ─── */
const sonioxMocks = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  pause: vi.fn(),
  switchMicrophone: vi.fn(async () => {}),
  rebuildSession: vi.fn(async () => {}),
  reconnectAfterRefresh: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  finalizeRemoteDraft: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/hooks/useSoniox', () => ({
  useSoniox: () => sonioxMocks,
}));

const summaryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  onNewSentence: vi.fn(),
  triggerManual: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('@/hooks/useSummary', () => ({ useSummary: () => summaryMocks }));

const translationMocks = vi.hoisted(() => ({
  initLocal: vi.fn(),
  translateSentence: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('@/hooks/useTranslation', () => ({
  useLocalTranslation: () => translationMocks,
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

/* ─── 重组件 stub —— 本文件测的是页面的状态/时序，不是这些面板的渲染 ─── */
vi.mock('@/components/Sidebar', () => ({ default: () => null }));
vi.mock('@/components/UserSettingsModal', () => ({ default: () => null }));
vi.mock('@/components/TranscriptPanel', () => ({ default: () => null }));
vi.mock('@/components/SettingsDrawer', () => ({ default: () => null }));
vi.mock('@/components/ExportModal', () => ({ default: () => null }));
vi.mock('@/components/mobile/MobileSessionLayout', () => ({ default: () => null }));
vi.mock('@/components/session/LiveShareBadge', () => ({ default: () => null }));
vi.mock('@/components/FlagImg', () => ({ default: () => null }));
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
// AiPanel 用可点击替身暴露 onInjectKeywords（M20 的唯一触发入口）。
vi.mock('@/components/session/AiPanel', () => ({
  default: ({ onInjectKeywords }: { onInjectKeywords: (k: string[]) => void }) => (
    <button data-testid="inject-keywords" onClick={() => void onInjectKeywords(['向量场'])}>
      inject
    </button>
  ),
}));

/* ─── zustand persist 写 localStorage 会在 vitest 里抛错：先换内存实现再动态加载 ─── */
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** GET /api/sessions/{id} 的响应（可以是尚未兑现的 promise，用于制造慢响应）。 */
let sessionMeta: Record<string, FakeResponse | Promise<FakeResponse>>;
/** GET /api/sessions/{id}/transcript/draft 的响应体 */
let draftBody: Record<string, unknown>;
/** 观测到的 PATCH /api/sessions/{id} */
let patchCalls: Array<{ sessionId: string; body: unknown }>;

function sessionIdFromUrl(url: string): string {
  return decodeURIComponent(url.split('/api/sessions/')[1]?.split(/[/?]/)[0] ?? '');
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<unknown> => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

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
        return jsonResponse(draftBody[id] ?? { exists: false });
      }
      if (url.includes('/api/sessions/')) {
        const id = sessionIdFromUrl(url);
        if (method === 'PATCH') {
          patchCalls.push({
            sessionId: id,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          return jsonResponse({ ok: true });
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
    user: {
      id: 'u-1',
      email: 'u@test',
      displayName: 'U',
      role: 'PRO',
    } as never,
    token: 'test-token',
    quotas: null,
  });
}

describe('会话页异步归属与时序', () => {
  beforeEach(() => {
    sessionStorage.clear();
    memStorage.clear();
    sessionMeta = {};
    draftBody = {};
    patchCalls = [];
    routerMocks.currentSessionId.value = 'sess-a';
    routerMocks.replace.mockClear();
    routerMocks.push.mockClear();
    Object.values(sonioxMocks).forEach((fn) => fn.mockClear());
    Object.values(summaryMocks).forEach((fn) => fn.mockClear());
    Object.values(translationMocks).forEach((fn) => fn.mockClear());
    vi.mocked(toast.error).mockClear();
    resetStores();
    installFetch();
  });

  afterEach(() => {
    // 先卸载再撤销 fetch 替身：卸载 cleanup 里有 flushDraftForUnload 会真的发请求，
    // 撤销在前会打到 undici 的真实 fetch 上（相对 URL 直接抛 unhandled rejection）。
    cleanup();
    vi.unstubAllGlobals();
  });

  it('M19：A 的慢响应晚于 B 到达时，既不覆盖 B 的标题，也不把用户踢到 A 的回放页', async () => {
    const slowA = deferred<FakeResponse>();
    sessionMeta['sess-a'] = slowA.promise;
    sessionMeta['sess-b'] = jsonResponse({
      id: 'sess-b',
      title: '乙课 · 泛函分析',
      status: 'RECORDING',
      sourceLang: 'en',
      targetLang: 'zh',
    });

    const { rerender } = render(<ActiveSessionPage />);

    // 切到 B（同动态段互跳：组件实例复用，只有 useParams 变了）
    routerMocks.currentSessionId.value = 'sess-b';
    await act(async () => {
      rerender(<ActiveSessionPage />);
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课 · 泛函分析');
    });

    // A 的响应姗姗来迟，而且是个已收尾的会话
    await act(async () => {
      slowA.resolve(
        jsonResponse({
          id: 'sess-a',
          title: '甲课 · 已收尾',
          status: 'COMPLETED',
          sourceLang: 'ja',
          targetLang: 'ko',
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(routerMocks.replace).not.toHaveBeenCalledWith('/session/sess-a/playback');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课 · 泛函分析');
  });

  it('M19：A 的慢响应（非终态）不得把标题/语言覆盖到 B 上', async () => {
    const slowA = deferred<FakeResponse>();
    sessionMeta['sess-a'] = slowA.promise;
    sessionMeta['sess-b'] = jsonResponse({
      id: 'sess-b',
      title: '乙课 · 泛函分析',
      status: 'RECORDING',
      sourceLang: 'en',
      targetLang: 'zh',
    });

    const { rerender } = render(<ActiveSessionPage />);

    routerMocks.currentSessionId.value = 'sess-b';
    await act(async () => {
      rerender(<ActiveSessionPage />);
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课 · 泛函分析');
    });

    await act(async () => {
      slowA.resolve(
        jsonResponse({
          id: 'sess-a',
          title: '甲课 · 线性代数',
          status: 'RECORDING',
          sourceLang: 'ja',
          targetLang: 'ko',
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课 · 泛函分析');
    expect(screen.queryByRole('heading', { level: 1 })).not.toHaveTextContent('甲课 · 线性代数');
  });

  it('M19 同族：A 录音中导航到 B，不得把 B 也 PATCH 成 RECORDING', async () => {
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'RECORDING',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    sessionMeta['sess-b'] = jsonResponse({
      id: 'sess-b',
      title: '乙课',
      status: 'CREATED',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    // A 正在录：全局 store 绑定到 A
    useTranscriptStore.setState({
      recordingState: 'recording',
      activeSessionId: 'sess-a',
      recordingStartTime: Date.now() - 30_000,
    });

    const { rerender } = render(<ActiveSessionPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('甲课');
    });

    // SPA 导航到 B（页面实例复用；store 仍绑定 A、仍是 recording）
    patchCalls.length = 0;
    routerMocks.currentSessionId.value = 'sess-b';
    await act(async () => {
      rerender(<ActiveSessionPage />);
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('乙课');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchCalls.filter((c) => c.sessionId === 'sess-b')).toHaveLength(0);
  });

  it('L45：元信息 500（JSON 错误体）不再当成合法元信息静默放行', async () => {
    sessionMeta['sess-a'] = jsonResponse(
      { error: 'database unavailable' },
      { ok: false, status: 500 }
    );

    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });
    // 错误体里没有 status → 绝不能被当成"这个会话没有状态"的正常结果去驱动后续恢复分支
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New Lecture Session');
  });

  it('M20：暂停态注入关键词只重建会话，不再补一次 pauseRecording', async () => {
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'PAUSED',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    // 本地也在录（live-refresh），使页面进入 paused 态
    useTranscriptStore.setState({
      recordingState: 'paused',
      activeSessionId: 'sess-a',
      recordingStartTime: Date.now() - 60_000,
      pausedAt: Date.now(),
    });

    const user = userEvent.setup();
    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(screen.getByTestId('inject-keywords')).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByTestId('inject-keywords'));
    });

    expect(sonioxMocks.rebuildSession).toHaveBeenCalledTimes(1);
    expect(sonioxMocks.pause).not.toHaveBeenCalled();
  });

  it('L47：开麦失败（本地态落回 idle）时不把后端置成 RECORDING', async () => {
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'CREATED',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    // 模拟麦克风授权被拒：start 走完但本地态停在 idle
    sonioxMocks.start.mockImplementationOnce(async () => {
      useTranscriptStore.getState().setRecordingState('idle');
    });
    useSettingsStore.setState({ pendingAutoStart: true });

    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(sonioxMocks.start).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchCalls.filter((c) => c.body && (c.body as { status?: string }).status === 'RECORDING')).toHaveLength(0);
  });

  it('L47 正向对照：开麦成功时仍然会把后端置成 RECORDING', async () => {
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'CREATED',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    sonioxMocks.start.mockImplementationOnce(async () => {
      useTranscriptStore.getState().setActiveSessionId('sess-a');
      useTranscriptStore.getState().setRecordingState('recording');
    });
    useSettingsStore.setState({ pendingAutoStart: true });

    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(
        patchCalls.filter((c) => (c.body as { status?: string })?.status === 'RECORDING').length
      ).toBeGreaterThan(0);
    });
  });

  it('L46：冷恢复灌入的历史段落不再被当成新句子喂给摘要/本地翻译', async () => {
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'PAUSED',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    draftBody['sess-a'] = {
      exists: true,
      payload: {
        segments: [
          { id: 'seg-1', text: '第一句', language: 'en', globalStartMs: 0, globalEndMs: 1000 },
          { id: 'seg-2', text: '第二句', language: 'en', globalStartMs: 1000, globalEndMs: 2000 },
        ],
        totalDurationMs: 2000,
        currentSessionIndex: 1,
        translations: { 'seg-1': '一', 'seg-2': '二' },
        summaries: [],
      },
    };
    // 本地无录音态 + 后端 PAUSED → resume-cold
    useSettingsStore.setState({ translationMode: 'local' });

    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(useTranscriptStore.getState().segments).toHaveLength(2);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(summaryMocks.onNewSentence).not.toHaveBeenCalled();
    expect(translationMocks.translateSentence).not.toHaveBeenCalled();
  });

  it('L46 正向对照：冷恢复之后新到的段落照常进管线', async () => {
    sessionMeta['sess-a'] = jsonResponse({
      id: 'sess-a',
      title: '甲课',
      status: 'PAUSED',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    draftBody['sess-a'] = {
      exists: true,
      payload: {
        segments: [
          { id: 'seg-1', text: '第一句', language: 'en', globalStartMs: 0, globalEndMs: 1000 },
        ],
        totalDurationMs: 1000,
        translations: {},
        summaries: [],
      },
    };
    useSettingsStore.setState({ translationMode: 'local' });

    render(<ActiveSessionPage />);

    await waitFor(() => {
      expect(useTranscriptStore.getState().segments).toHaveLength(1);
    });

    await act(async () => {
      useTranscriptStore.getState().addFinalSegment({
        id: 'seg-2',
        text: '续录的新句子',
        language: 'en',
        globalStartMs: 1000,
        globalEndMs: 2000,
      } as never);
    });

    await waitFor(() => {
      expect(summaryMocks.onNewSentence).toHaveBeenCalledWith('续录的新句子');
    });
  });
});
