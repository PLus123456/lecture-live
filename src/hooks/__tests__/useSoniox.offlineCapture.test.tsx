/**
 * useSoniox 断网续采（offline continuous capture）测试。
 *
 * 断网期间：只停 Soniox 转录发送，本地 MediaRecorder 继续录音频写 IndexedDB。
 * 断言 recordingState 保持 'recording'、不 pause 归档、不进暂停语义、发出「转录中断」通知；
 * 本地采集不可用时回退到完整暂停。
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

// 可控归档桩：hasLiveCapture 默认 true（续采可行），pause 是可追踪 spy。
const archiveSpy = vi.hoisted(() => ({
  pause: vi.fn(),
  hasLiveCapture: vi.fn(() => true),
}));

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
    // @ts-expect-error 透传参数
    startSonioxRecordingMock(...args),
}));

vi.mock('@/lib/audio/recordingArchiveManager', () => ({
  RecordingArchiveManager: class {
    setChunkStoredHandler() {}
    async ensureArchive() {}
    async getSenderStream() {
      return {} as MediaStream;
    }
    async resume() {}
    async pause() {
      archiveSpy.pause();
    }
    async stop() {}
    async buildBlob() {
      return null;
    }
    checkpoint() {}
    flushForPageUnload() {}
    hasLiveCapture() {
      return archiveSpy.hasLiveCapture();
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
    currentPreviewText: { finalText: '', nonFinalText: '' },
  } as never);
}

const lastCb = () => capturedCallbacks[capturedCallbacks.length - 1];

async function startAndConnect(result: { current: { start: () => Promise<void> } }) {
  await act(async () => {
    await result.current.start();
  });
  act(() => {
    lastCb().onConnectionChange('connected');
  });
}

beforeEach(() => {
  capturedCallbacks.length = 0;
  startSonioxRecordingMock.mockClear();
  archiveSpy.pause.mockClear();
  archiveSpy.hasLiveCapture.mockReturnValue(true);
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('断网续采（offline continuous capture）', () => {
  it('本地采集仍活时：断网不暂停归档、录音保持 recording、只中断转录', async () => {
    const onTranscriptionInterrupted = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-offline', {
        onTranscriptionInterrupted,
        idleTimeoutMs: 999_999_999,
      })
    );
    await startAndConnect(result);
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    archiveSpy.pause.mockClear();

    // 断网
    await act(async () => {
      lastCb().onError(new Error('disconnect'));
      await Promise.resolve();
    });

    // 续采：归档未被暂停、录音保持 recording、不进暂停语义、连接为 reconnecting、发中断通知
    expect(archiveSpy.pause).not.toHaveBeenCalled();
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    expect(useTranscriptStore.getState().pausedAt).toBeNull();
    expect(useTranscriptStore.getState().connectionState).toBe('reconnecting');
    expect(onTranscriptionInterrupted).toHaveBeenCalledTimes(1);
  });

  it('续采后重连成功：转录续接、仍为 recording、不误累计暂停时长', async () => {
    const { result } = renderHook(() =>
      useSoniox('sess-offline-resume', { idleTimeoutMs: 999_999_999 })
    );
    await startAndConnect(result);
    const totalPausedBefore = useTranscriptStore.getState().totalPausedMs;

    // 断网续采
    await act(async () => {
      lastCb().onError(new Error('disconnect'));
      await Promise.resolve();
    });
    // 触发重连定时器 → 建新连接 → 驱动 connected
    await act(async () => {
      await vi.waitFor(
        () => {
          if (capturedCallbacks.length < 2) throw new Error('reconnect not started');
        },
        { timeout: 4000 }
      );
    });
    act(() => {
      lastCb().onConnectionChange('connected');
    });

    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    // 续采未经历「暂停」→ totalPausedMs 不应因断网空档被累加
    expect(useTranscriptStore.getState().totalPausedMs).toBe(totalPausedBefore);
  });

  it('本地采集不可用（hasLiveCapture=false）时：断网回退到完整暂停', async () => {
    const onTranscriptionInterrupted = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-fallback', {
        onTranscriptionInterrupted,
        idleTimeoutMs: 999_999_999,
      })
    );
    await startAndConnect(result);
    archiveSpy.pause.mockClear();
    archiveSpy.hasLiveCapture.mockReturnValue(false);

    await act(async () => {
      lastCb().onError(new Error('disconnect'));
      await Promise.resolve();
    });

    // 回退：归档被暂停、进入 paused、不发续采通知
    expect(archiveSpy.pause).toHaveBeenCalled();
    expect(useTranscriptStore.getState().recordingState).toBe('paused');
    expect(useTranscriptStore.getState().pausedAt).not.toBeNull();
    expect(onTranscriptionInterrupted).not.toHaveBeenCalled();
  });
});
