/**
 * useSoniox 审计 #1 回归：断线重连时 mint 临时 key 失败（断网 / 额度耗尽 403 最常见）。
 *
 * 旧实现：attemptReconnect 在调用 startSonioxRecording **之前**就把 runIdRef 推进到 genAtStart+1，
 * 而 catch 仍拿 genAtStart 比对 —— 任何 startSonioxRecording 的 reject 都被当成「已被 stop/接管」
 * 静默 return：不排下一轮重连、到上限也不触发 onReconnectFailed，connectionState 永远停在
 * 'connecting'（手动「重新连接」按钮只在 'error' 时出现），整节课实时转录就此死掉。
 *
 * 真实 client.ts 的 startSonioxRecording 在 mint 失败时先回调 onConnectionChange('connecting')
 * 再抛错、且**不**回调 onError —— 桩按同样的时序模拟。
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
// 接下来多少次 startSonioxRecording 以「mint 临时 key 失败」reject。
let failingStarts = 0;

const startSonioxRecordingMock = vi.fn(
  async (_config: unknown, _token: string, callbacks: SonioxCallbacks) => {
    capturedCallbacks.push(callbacks);
    callbacks.onConnectionChange('connecting');
    if (failingStarts > 0) {
      failingStarts -= 1;
      throw new TypeError('Failed to fetch');
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
  failingStarts = 0;
  startSonioxRecordingMock.mockClear();
  resetStores();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useSoniox 审计 #1：重连 mint 失败后必须继续重连', () => {
  it('第一次重连 mint 失败 → 退避后排出第二次重连，并能连上恢复转录', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSoniox('sess-reconnect-fail', { idleTimeoutMs: 999_999_999 })
    );
    await startConnectedThenDrop(result);
    const startsBefore = startSonioxRecordingMock.mock.calls.length;

    failingStarts = 1;
    // 第 1 次重连（退避 1500ms）：mint 失败。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBe(startsBefore + 1);

    // 修复前：catch 静默 return，此后再也没有任何重连尝试。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_400);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBe(startsBefore + 2);

    act(() => {
      lastCb().onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().connectionState).toBe('connected');
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
  });

  it('每次重连都 mint 失败 → 到上限后置 error 并触发 onReconnectFailed（不再静默卡在 connecting）', async () => {
    vi.useFakeTimers();
    const onReconnectFailed = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-reconnect-cap', {
        idleTimeoutMs: 999_999_999,
        onReconnectFailed,
      })
    );
    await startConnectedThenDrop(result);
    const startsBefore = startSonioxRecordingMock.mock.calls.length;

    failingStarts = Number.POSITIVE_INFINITY;
    // 5 次退避合计约 19.8s（1.5s × 1.5^n），留足余量。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(startSonioxRecordingMock.mock.calls.length).toBe(startsBefore + 5);
    expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    expect(useTranscriptStore.getState().connectionState).toBe('error');
    // 本地采集仍活（断网续采），录音态保持 recording，等用户手动「重新连接」。
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
  });
});
