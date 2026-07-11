/**
 * useSoniox 状态机负向测试（审计 P0-2）。
 *
 * - 并发/双击 start 只建立一次 Soniox 会话（单飞）；旧代码会并发开两条 WS / 两把 key。
 * - start 建连等待期间 pause：晚到的句柄必须被暂停，不得在 paused 下继续出字（写 segment）。
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

// startSonioxRecording 桩：可控挂起，便于制造「建连中」窗口。
let pendingResolvers: Array<(v: unknown) => void> = [];
const recordingHandles: Array<{
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}> = [];
type SonioxCallbacks = {
  onPartialResult: (tokens: unknown[]) => void;
  onEndpoint: () => void;
  onError: (error: Error) => void;
  onConnectionChange: (state: string) => void;
};
const capturedCallbacks: SonioxCallbacks[] = [];
let hangNextStart = false;

const startSonioxRecordingMock = vi.fn(
  async (_config: unknown, _token: string, callbacks: SonioxCallbacks) => {
    capturedCallbacks.push(callbacks);
    callbacks.onConnectionChange('connecting');
    const handle = {
      stop: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    recordingHandles.push(handle);
    const result = {
      recording: handle,
      client: {},
      temporaryKey: { region: 'test', ws_base_url: 'wss://test' },
    };
    if (hangNextStart) {
      return new Promise((resolve) => {
        pendingResolvers.push(() => resolve(result));
      });
    }
    return result;
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

beforeEach(() => {
  capturedCallbacks.length = 0;
  recordingHandles.length = 0;
  pendingResolvers = [];
  hangNextStart = false;
  startSonioxRecordingMock.mockClear();
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSoniox P0-2 单飞 start', () => {
  it('并发双击 start 只建立一次 Soniox 会话', async () => {
    hangNextStart = true;
    const { result } = renderHook(() =>
      useSoniox('sess-double', { idleTimeoutMs: 999_999_999 })
    );

    // 两次并发 start，第一条挂起在 startSonioxRecording
    await act(async () => {
      const p1 = result.current.start();
      const p2 = result.current.start();
      // 等第一条真正推进到 startSonioxRecording 的挂起点
      await vi.waitFor(() => {
        if (pendingResolvers.length === 0) throw new Error('not yet at soniox');
      });
      // 放行挂起的连接
      pendingResolvers.forEach((r) => r(undefined));
      await Promise.all([p1, p2]);
    });

    // 旧行为：两条 start 各自 startSonioxRecording → 2 次。修复后单飞 → 1 次。
    expect(startSonioxRecordingMock).toHaveBeenCalledTimes(1);
  });
});

describe('useSoniox P0-2 晚到 start 对齐 pause', () => {
  it('建连等待期间 pause → 授权返回后立即暂停晚到句柄', async () => {
    hangNextStart = true;
    const { result } = renderHook(() =>
      useSoniox('sess-latepause', { idleTimeoutMs: 999_999_999 })
    );

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start();
      await vi.waitFor(() => {
        if (pendingResolvers.length === 0) throw new Error('not yet at soniox');
      });
    });

    // 建连仍挂起时用户点暂停
    act(() => {
      result.current.pause();
    });
    expect(useTranscriptStore.getState().recordingState).toBe('paused');

    // 授权/连接现在才返回
    await act(async () => {
      pendingResolvers.forEach((r) => r(undefined));
      await startPromise;
    });

    // 旧行为：晚到句柄发布后仍处于 recording，会继续写 segment。
    // 修复后：句柄被 pause()。
    const handle = recordingHandles[recordingHandles.length - 1];
    expect(handle.pause).toHaveBeenCalled();
  });
});

describe('useSoniox P1-5 初始建连失败进入自动重连', () => {
  it('temporary-key/WS 初始建连失败但归档在采集 → 进入重连状态机重试建连（不静默停在 error）', async () => {
    vi.useFakeTimers();
    // 首次 startSonioxRecording 抛错（初始 temp-key/WS 建连失败）。
    startSonioxRecordingMock.mockRejectedValueOnce(new Error('temp-key failed'));

    const { result } = renderHook(() =>
      useSoniox('sess-init-fail', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });

    // hasLiveCapture=true（归档在采集）→ 保持 recording，且进入自动重连（而非旧的静默 error 死态）。
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    const callsAfterInitial = startSonioxRecordingMock.mock.calls.length;

    // 推进重连退避：修复后应重新尝试建连（第二次 startSonioxRecording）。
    // 旧行为：初始失败不调用 attemptReconnect → 永不再建连，实时转录永久停摆。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBeGreaterThan(
      callsAfterInitial
    );

    vi.useRealTimers();
  });
});

describe('useSoniox P1-4 录音中连接错误的独立重新连接', () => {
  it('reconnect() 在 recording+error 下重新进入重连并建立新连接（不中断归档）', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSoniox('sess-manual-reconnect', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    // 模拟自动重连已达上限：connectionState='error'，recordingState 仍 recording（归档 live）。
    act(() => {
      useTranscriptStore.getState().setConnectionState('error');
    });
    const callsBefore = startSonioxRecordingMock.mock.calls.length;

    // 用户点独立「重新连接」。
    act(() => {
      result.current.reconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // 修复后：重新建立一条连接。旧代码无此 API（reconnect 不存在），用户只能猜测先暂停再继续。
    expect(startSonioxRecordingMock.mock.calls.length).toBeGreaterThan(callsBefore);

    vi.useRealTimers();
  });
});

describe('useSoniox P0-2 residual 停止竞态（切麦/重建的 stop await 期间点停止不复活录音）', () => {
  it('switchMicrophone 的 stop() await 期间用户点停止 → 中止续录，不再 startSoniox', async () => {
    const { result } = renderHook(() =>
      useSoniox('sess-switch-stop', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    const startCallsBefore = startSonioxRecordingMock.mock.calls.length;

    // 让当前录音句柄的 stop() 挂起，制造 switchMicrophone 内 `await activeRecording.stop()` 窗口。
    const handle = recordingHandles[recordingHandles.length - 1];
    let releaseStop!: () => void;
    handle.stop.mockImplementation(
      () =>
        new Promise<void>((res) => {
          releaseStop = () => res();
        })
    );

    // 发起切麦克风：同步执行到 `await activeRecording.stop()` 处挂起。
    let switchPromise!: Promise<void>;
    await act(async () => {
      switchPromise = result.current.switchMicrophone('mic-b');
    });

    // 在 stop await 窗口内，用户点『停止』。
    await act(async () => {
      await result.current.stop();
    });
    expect(useTranscriptStore.getState().recordingState).toBe('stopped');

    // 放行挂起的 stop，switchMicrophone 继续到守卫处。
    await act(async () => {
      releaseStop();
      await switchPromise;
    });

    // 修复后：守卫命中（stopped / runId 越代）→ 不再 startNewRecording。旧行为：无条件续录 +1 次。
    expect(startSonioxRecordingMock.mock.calls.length).toBe(startCallsBefore);
    expect(useTranscriptStore.getState().recordingState).toBe('stopped');
  });

  it('rebuildSession 的 stop() await 期间用户点停止 → 中止重建，不再 startSoniox', async () => {
    const { result } = renderHook(() =>
      useSoniox('sess-rebuild-stop', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    const startCallsBefore = startSonioxRecordingMock.mock.calls.length;

    const handle = recordingHandles[recordingHandles.length - 1];
    let releaseStop!: () => void;
    handle.stop.mockImplementation(
      () =>
        new Promise<void>((res) => {
          releaseStop = () => res();
        })
    );

    let rebuildPromise!: Promise<void>;
    await act(async () => {
      rebuildPromise = result.current.rebuildSession();
    });

    await act(async () => {
      await result.current.stop();
    });
    expect(useTranscriptStore.getState().recordingState).toBe('stopped');

    await act(async () => {
      releaseStop();
      await rebuildPromise;
    });

    expect(startSonioxRecordingMock.mock.calls.length).toBe(startCallsBefore);
    expect(useTranscriptStore.getState().recordingState).toBe('stopped');
  });
});

describe('useSoniox P1-3 卸载冻结 pausedAt（离页空档不计时）', () => {
  it('SPA 导航卸载停硬件的同刻冻结 pausedAt，离页无音频空档不进偏移/时长', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    const { result, unmount } = renderHook(() =>
      useSoniox('sess-unmount-freeze', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    expect(useTranscriptStore.getState().pausedAt).toBeNull();

    // 录了 60s 后离页（卸载）。
    nowSpy.mockReturnValue(1_060_000);
    act(() => {
      unmount();
    });

    // 修复后：卸载冻结 pausedAt=卸载时刻，返回后 reconnectAfterRefresh/computeResumeOffset 以此为
    // 冻结点，离页空档被排除。旧行为：卸载不写 pausedAt → 仍为 null → 返回时以 now 冻结、
    // 把整段离页空档算进偏移与时长。
    expect(useTranscriptStore.getState().pausedAt).toBe(1_060_000);
    // 刻意保留 recording 供返回页面按刷新恢复逻辑续录。
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    nowSpy.mockRestore();
  });
});
