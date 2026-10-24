/**
 * useSoniox 审计 #2 / #3 回归：硬件掉线（麦克风拔出 / 停止共享 → 源 track ended）。
 *
 * #2：P1-10 的掉线处理器只由 startNewRecording 安装，且门控是「安装它那次 start 的 runId 仍为
 *     当前」。断线重连与寿命轮换（每 ~14.5min）都会 bump runId 而从不重装 —— 第一次轮换之后
 *     拔麦，UI 仍显示「录音中 / 已连接」，实际什么都没采。
 * #3：掉线后 recordingRef 仍指向死句柄（音源是同一设备的克隆轨）。15s 内点「继续」会走
 *     startImpl 的短暂停复用分支，把死句柄 resume 成「录音中 / 已连接」（假录音）。
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

type Handle = {
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
};

const capturedCallbacks: SonioxCallbacks[] = [];
const handles: Handle[] = [];

const startSonioxRecordingMock = vi.fn(
  async (_config: unknown, _token: string, callbacks: SonioxCallbacks) => {
    capturedCallbacks.push(callbacks);
    callbacks.onConnectionChange('connecting');
    const handle: Handle = {
      stop: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    handles.push(handle);
    return {
      recording: handle,
      client: {},
      temporaryKey: {
        region: 'test',
        ws_base_url: 'wss://test',
        max_session_duration_seconds: 900,
      },
    };
  }
);

vi.mock('@/lib/soniox/client', () => ({
  buildSonioxConfig: vi.fn(() => ({})),
  startSonioxRecording: (...args: unknown[]) =>
    // @ts-expect-error 测试桩：把 unknown[] 参数透传给 mock（签名不完全匹配无碍）
    startSonioxRecordingMock(...args),
}));

// 归档桩：记录最新安装的掉线处理器，hasLiveCapture 可控（拔麦 = false）。
const archive = vi.hoisted(() => ({
  endedHandler: null as null | (() => void),
  live: true,
  pause: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@/lib/audio/recordingArchiveManager', () => ({
  RecordingArchiveManager: class {
    setChunkStoredHandler() {}
    setCaptureEndedHandler(handler: (() => void) | null) {
      archive.endedHandler = handler;
    }
    async ensureArchive() {}
    async getSenderStream() {
      return {} as MediaStream;
    }
    async resume() {
      archive.resume();
    }
    async pause() {
      archive.pause();
    }
    async stop() {}
    async buildBlob() {
      return null;
    }
    checkpoint() {}
    flushForPageUnload() {}
    hasLiveCapture() {
      return archive.live;
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
const state = () => useTranscriptStore.getState();

async function startAndConnect(result: { current: ReturnType<typeof useSoniox> }) {
  await act(async () => {
    await result.current.start();
  });
  act(() => {
    lastCb().onConnectionChange('connected');
  });
  expect(state().recordingState).toBe('recording');
}

function unplugMicrophone() {
  archive.live = false;
  act(() => {
    archive.endedHandler?.();
  });
}

beforeEach(() => {
  capturedCallbacks.length = 0;
  handles.length = 0;
  archive.endedHandler = null;
  archive.live = true;
  archive.pause.mockClear();
  archive.resume.mockClear();
  startSonioxRecordingMock.mockClear();
  resetStores();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useSoniox 审计 #2：掉线检测必须挺过重连与寿命轮换', () => {
  it('一次断线重连之后拔麦 → 仍落到 paused + disconnected', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSoniox('sess-ended-reconnect', { idleTimeoutMs: 999_999_999 })
    );
    await startAndConnect(result);

    // 断线（本地采集仍活 → 断网续采）→ 退避后重连成功。
    await act(async () => {
      lastCb().onError(new Error('ws down'));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(startSonioxRecordingMock).toHaveBeenCalledTimes(2);
    act(() => {
      lastCb().onConnectionChange('connected');
    });
    expect(state().connectionState).toBe('connected');

    unplugMicrophone();

    // 修复前：处理器的 runId 门控已失效，状态停在 recording / connected。
    expect(state().recordingState).toBe('paused');
    expect(state().connectionState).toBe('disconnected');
    expect(state().pausedAt).not.toBeNull();
  });

  it('寿命轮换（grant 15min 到点前 30s）之后拔麦 → 仍落到 paused + disconnected', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSoniox('sess-ended-rotation', { idleTimeoutMs: 999_999_999 })
    );
    await startAndConnect(result);

    // 900s grant → 870s 时主动轮换 → attemptReconnect 退避 1.5s 后重建连接。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(870_000 + 1_600);
    });
    expect(startSonioxRecordingMock).toHaveBeenCalledTimes(2);
    expect(handles[0].stop).toHaveBeenCalled();
    act(() => {
      lastCb().onConnectionChange('connected');
    });

    unplugMicrophone();

    expect(state().recordingState).toBe('paused');
    expect(state().connectionState).toBe('disconnected');
  });
});

describe('useSoniox 审计 #3：掉线后丢弃死句柄、续录重建连接', () => {
  it('掉线后死句柄被停掉，其迟到回调不再触发自动重连', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSoniox('sess-ended-drop', { idleTimeoutMs: 999_999_999 })
    );
    await startAndConnect(result);
    const deadCallbacks = lastCb();

    unplugMicrophone();
    expect(handles[0].stop).toHaveBeenCalled();
    // 暂停意图下发给归档：续录换上新采集时新 recorder 继承 paused、连上才 resume。
    expect(archive.pause).toHaveBeenCalled();

    // 死连接稍后才报错：不得进入断线重连状态机（否则会悄悄换个麦克风接着录）。
    await act(async () => {
      deadCallbacks.onError(new Error('socket closed'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(startSonioxRecordingMock).toHaveBeenCalledTimes(1);
    expect(state().recordingState).toBe('paused');
    expect(state().connectionState).toBe('disconnected');
  });

  it('掉线后 15s 内点「继续」→ 不复用死句柄，重建连接、连上后才恢复录音', async () => {
    const { result } = renderHook(() =>
      useSoniox('sess-ended-resume', { idleTimeoutMs: 999_999_999 })
    );
    await startAndConnect(result);

    unplugMicrophone();
    expect(state().recordingState).toBe('paused');

    // 用户插回麦克风、立刻点「继续」（远小于 PAUSE_HANDLE_STALE_MS）。
    archive.live = true;
    await act(async () => {
      await result.current.start();
    });

    // 修复前：走短暂停复用分支 —— 死句柄 resume()，直接把 UI 置成 recording / connected。
    expect(handles[0].resume).not.toHaveBeenCalled();
    expect(startSonioxRecordingMock).toHaveBeenCalledTimes(2);
    expect(state().recordingState).toBe('paused');

    act(() => {
      lastCb().onConnectionChange('connected');
    });
    expect(state().recordingState).toBe('recording');
    expect(state().connectionState).toBe('connected');
    expect(archive.resume).toHaveBeenCalled();
  });
});
