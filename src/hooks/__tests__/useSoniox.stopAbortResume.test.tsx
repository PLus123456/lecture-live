/**
 * useSoniox 审计 #6 回归：stop() 之后收尾失败、页面把会话回落成 paused，再续录。
 *
 * stop() 会清空 recordingStartTime 与 processor（「本场结束」语义），而收尾失败时页面只把
 * recordingState 改回 'paused'。两者都随 sessionStorage 持久化 —— 刷新 / SPA 返回后
 * reconnectAfterRefresh 因 recordingStartTime 为空直接 return，续录的 startNewRecording 也拿不到
 * 计时基准：新 processor 从 seg-1、00:00 起编号，与已有段撞 id（译文按段 id 存，互相覆盖），
 * 时间轴叠回开头。修复后从已有段落推导段号与偏移。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const make = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as unknown as Storage;
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: make(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: make(),
    configurable: true,
    writable: true,
  });
});

type SonioxCallbacks = {
  onPartialResult: (tokens: unknown[]) => void;
  onEndpoint: () => void;
  onError: (error: Error) => void;
  onConnectionChange: (state: string) => void;
};

const capturedCallbacks: SonioxCallbacks[] = [];

const startSonioxRecordingMock = vi.fn(
  async (_config: unknown, _token: string, callbacks: SonioxCallbacks) => {
    capturedCallbacks.push(callbacks);
    callbacks.onConnectionChange('connecting');
    return {
      recording: {
        stop: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        resume: vi.fn(),
      },
      client: {},
      temporaryKey: { region: 'test', ws_base_url: 'wss://test' },
    };
  }
);

vi.mock('@/lib/soniox/client', () => ({
  buildSonioxConfig: vi.fn(() => ({})),
  startSonioxRecording: (...args: unknown[]) =>
    // @ts-expect-error 测试桩：把 unknown[] 参数透传给 mock（签名不完全匹配无碍）
    startSonioxRecordingMock(...args),
}));

vi.mock('@/lib/audio/recordingArchiveManager', () => ({
  RecordingArchiveManager: class {
    setChunkStoredHandler() {}
    setCaptureEndedHandler() {}
    async ensureArchive() {}
    async getSenderStream() {
      return {} as MediaStream;
    }
    async resume() {}
    async pause() {}
    async stop() {}
    async buildBlob() {
      return null;
    }
    checkpoint() {}
    flushForPageUnload() {}
    hasLiveCapture() {
      return true;
    }
    ensureSeqAbove() {}
  },
}));

vi.mock('@/lib/audio/audioChunkStore', () => ({
  getAllAudioChunks: vi.fn(async () => []),
  getArchiveMimeType: vi.fn(async () => 'audio/webm'),
  getAudioChunkEntries: vi.fn(async () => []),
  hasAudioChunks: vi.fn(async () => false),
}));

import { useSoniox } from '@/hooks/useSoniox';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import type { TranscriptSegment } from '@/types/transcript';

function makeSegment(n: number): TranscriptSegment {
  return {
    id: `seg-${n}`,
    sessionIndex: 1,
    speaker: '',
    language: 'en',
    text: `old ${n}`,
    globalStartMs: n * 10_000,
    globalEndMs: n * 10_000 + 5_000,
    startMs: n * 10_000,
    endMs: n * 10_000 + 5_000,
    isFinal: true,
    confidence: 1,
    timestamp: '00:00:10',
  };
}

function resetStores() {
  useAuthStore.setState({ token: 'test-token' });
  useSettingsStore.setState({
    audioSource: 'mic',
    preferredMicDeviceId: 'mic-a',
    targetLang: 'zh',
    sourceLang: 'en',
  } as never);
  useTranscriptStore.setState({
    segments: [],
    recordingState: 'idle',
    recordingStartTime: null,
    pausedAt: null,
    totalPausedMs: 0,
    connectionState: 'disconnected',
    currentSessionIndex: 0,
    activeSessionId: null,
    currentPreviewText: { finalText: '', nonFinalText: '' },
  } as never);
}

const lastCb = () => capturedCallbacks[capturedCallbacks.length - 1];

function speakOneSentence(text: string) {
  act(() => {
    lastCb().onPartialResult([
      {
        text,
        start_ms: 100,
        end_ms: 900,
        confidence: 1,
        is_final: true,
        language: 'en',
      },
    ]);
    lastCb().onEndpoint();
  });
}

function expectUniqueIds() {
  const ids = useTranscriptStore.getState().segments.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
}

beforeEach(() => {
  capturedCallbacks.length = 0;
  startSonioxRecordingMock.mockClear();
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSoniox 审计 #6：stop() 收尾失败回落 paused 后续录', () => {
  it('刷新/返回后（计时基准为空）续录：段号接在已有段之后、时间轴不叠回开头', async () => {
    // 刷新前 stop() 已清空计时基准，页面收尾失败回落 paused —— 二者都被持久化下来。
    useTranscriptStore.setState({
      segments: [makeSegment(1), makeSegment(2), makeSegment(3)],
      recordingState: 'paused',
      recordingStartTime: null,
      pausedAt: null,
      totalPausedMs: 0,
      activeSessionId: 'sess-abort',
    } as never);
    const { result } = renderHook(() =>
      useSoniox('sess-abort', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.reconnectAfterRefresh();
    });
    // 计时基准被推导回来（计时器不再从 0 起）。
    expect(useTranscriptStore.getState().recordingStartTime).not.toBeNull();

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      lastCb().onConnectionChange('connected');
    });
    speakOneSentence('new words.');

    const segments = useTranscriptStore.getState().segments;
    const created = segments[segments.length - 1];
    // 修复前：新段 id 为 seg-1（与第一段撞号）、globalStartMs 为 100（叠回开头）。
    expectUniqueIds();
    expect(created.id).toBe('seg-4');
    expect(created.globalStartMs).toBeGreaterThanOrEqual(35_000);
  });

  it('不刷新、直接在 stop() 之后回落 paused 再续录：同样不撞 id', async () => {
    const { result } = renderHook(() =>
      useSoniox('sess-abort-inline', { idleTimeoutMs: 999_999_999 })
    );
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      lastCb().onConnectionChange('connected');
    });
    speakOneSentence('first sentence.');
    expect(useTranscriptStore.getState().segments.map((s) => s.id)).toEqual(['seg-1']);
    const firstEnd = useTranscriptStore.getState().segments[0].globalEndMs;

    await act(async () => {
      await result.current.stop();
    });
    // 页面：收尾失败（如补传不完整）→ 回落 paused、保留本地数据。
    act(() => {
      useTranscriptStore.getState().setRecordingState('paused');
    });

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      lastCb().onConnectionChange('connected');
    });
    speakOneSentence('second sentence.');

    const segments = useTranscriptStore.getState().segments;
    expectUniqueIds();
    expect(segments[segments.length - 1].id).toBe('seg-2');
    expect(segments[segments.length - 1].globalStartMs).toBeGreaterThanOrEqual(firstEnd);
  });
});
