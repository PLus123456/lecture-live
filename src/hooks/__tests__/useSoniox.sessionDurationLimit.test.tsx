/**
 * 服务端单场时长闸拒发 key（403 code=session_duration_limit）时，useSoniox 必须停止重连并通知上层。
 *
 * 这不是断线：继续重连只会被同样拒绝，空转 5 次后再误报「重连失败，请手动继续」——而手动继续也
 * 一样被拒。正确行为是立即交给上层（会话页提示「已达时长上限」并收尾）。
 *
 * 桩复用 reconnectFailure 测试的时序：mint 失败时先回调 onConnectionChange('connecting') 再抛错。
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
// 设置后，接下来每次 startSonioxRecording 都以它 reject（模拟 mint 被服务端拒绝）。
let startError: Error | null = null;

const startSonioxRecordingMock = vi.fn(
  async (_config: unknown, _token: string, callbacks: SonioxCallbacks) => {
    capturedCallbacks.push(callbacks);
    callbacks.onConnectionChange('connecting');
    if (startError) {
      throw startError;
    }
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
    // 断网续采：本地采集仍活，断线期间录音保持 recording，只有转录连接在重连。
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
import { TemporaryKeyError } from '@/lib/soniox/temporaryKeyError';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';

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

async function startConnectedThenDrop(result: {
  current: ReturnType<typeof useSoniox>;
}) {
  await act(async () => {
    await result.current.start();
  });
  act(() => {
    lastCb().onConnectionChange('connected');
  });
  expect(useTranscriptStore.getState().connectionState).toBe('connected');
  // WS 断开：onError → pauseForInterruption('disconnect') + attemptReconnect() 排退避定时器。
  await act(async () => {
    lastCb().onError(new Error('ws down'));
    await Promise.resolve();
  });
}

beforeEach(() => {
  capturedCallbacks.length = 0;
  startError = null;
  startSonioxRecordingMock.mockClear();
  resetStores();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const FOUR_HOURS_MS = 4 * 60 * 60_000;
const durationLimitError = () =>
  new TemporaryKeyError(
    'Session duration limit reached',
    403,
    'session_duration_limit',
    FOUR_HOURS_MS
  );

describe('useSoniox：服务端单场时长闸拒发 key', () => {
  it('重连时被拒 → 立即停止重连、置 error、通知 onSessionDurationLimit，不误报重连失败', async () => {
    vi.useFakeTimers();
    const onSessionDurationLimit = vi.fn();
    const onReconnectFailed = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-duration-limit', {
        idleTimeoutMs: 999_999_999,
        onReconnectFailed,
        onSessionDurationLimit,
      })
    );
    await startConnectedThenDrop(result);
    const startsBefore = startSonioxRecordingMock.mock.calls.length;

    startError = durationLimitError();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // 只尝试了 1 次：没有再排后续重连
    expect(startSonioxRecordingMock.mock.calls.length).toBe(startsBefore + 1);
    expect(onSessionDurationLimit).toHaveBeenCalledTimes(1);
    expect(onSessionDurationLimit).toHaveBeenCalledWith(FOUR_HOURS_MS);
    expect(onReconnectFailed).not.toHaveBeenCalled();
    expect(useTranscriptStore.getState().connectionState).toBe('error');
  });

  it('开录 / 续录时被拒 → 不进自动重连状态机，直接通知上层', async () => {
    vi.useFakeTimers();
    const onSessionDurationLimit = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-duration-limit-start', {
        idleTimeoutMs: 999_999_999,
        onSessionDurationLimit,
      })
    );

    startError = durationLimitError();
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(startSonioxRecordingMock).toHaveBeenCalledTimes(1);
    expect(onSessionDurationLimit).toHaveBeenCalledTimes(1);
    expect(onSessionDurationLimit).toHaveBeenCalledWith(FOUR_HOURS_MS);
  });

  it('普通的 mint 失败（断网）仍按原状态机重连，不当成时长上限', async () => {
    vi.useFakeTimers();
    const onSessionDurationLimit = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-duration-limit-control', {
        idleTimeoutMs: 999_999_999,
        onSessionDurationLimit,
      })
    );
    await startConnectedThenDrop(result);
    const startsBefore = startSonioxRecordingMock.mock.calls.length;

    startError = new TypeError('Failed to fetch');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(startSonioxRecordingMock.mock.calls.length).toBeGreaterThan(startsBefore + 1);
    expect(onSessionDurationLimit).not.toHaveBeenCalled();
  });
});
