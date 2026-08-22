/**
 * useSoniox H2 竞态回归：断线重连**建连途中**用户手动暂停。
 *
 * 漏洞窗口（审计 H2 + 主 agent 验真裁定）：
 *   退避定时器已经触发 → 代码正走在 `ensureArchive` / `getSenderStream` / mint key / 建 WS
 *   这一串 await 里（实测 0.5–3s）。此时点「暂停」：
 *     - `pause()` 会清 reconnectTimer、置 shouldReconnectRef=false、置 recordingState='paused'，
 *       但**刻意不 bump runId**（短暂停复用句柄依赖旧回调代次仍有效），代次守卫接不住它；
 *     - 建连成功后的 `onConnectionChange('connected')` 分支无条件 archiveManager.resume() +
 *       setRecordingState('recording') + onAutoResume。
 *   结果：用户以为已暂停，麦克风仍在采集、Soniox 仍在串流计费（幽灵录音）。
 *
 * 本文件用「可控挂起的 startSonioxRecording + 假定时器」精确制造该窗口。
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

let pendingResolvers: Array<() => void> = [];
const recordingHandles: Array<{
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}> = [];
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
      temporaryKey: {
        region: 'test',
        ws_base_url: 'wss://test',
        max_session_duration_seconds: 900,
      },
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

// 归档管理器桩：resume/pause 可观测（H2 的核心断言之一是「暂停期间归档绝不被 resume」）。
const archiveResume = vi.fn(async () => {});
const archivePause = vi.fn(async () => {});
// L47：模拟「麦克风授权被拒 / 取流失败」——ensureArchive 在 getUserMedia 那一步抛出。
let ensureArchiveError: Error | null = null;
let hasLiveCaptureValue = true;

vi.mock('@/lib/audio/recordingArchiveManager', () => ({
  RecordingArchiveManager: class {
    setChunkStoredHandler() {}
    setCaptureEndedHandler() {}
    async ensureArchive() {
      if (ensureArchiveError) throw ensureArchiveError;
    }
    async getSenderStream() {
      return {} as MediaStream;
    }
    async resume() {
      await archiveResume();
    }
    async pause() {
      await archivePause();
    }
    async stop() {}
    async buildBlob() {
      return null;
    }
    checkpoint() {}
    flushForPageUnload() {}
    hasLiveCapture() {
      return hasLiveCaptureValue;
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
  archiveResume.mockClear();
  archivePause.mockClear();
  ensureArchiveError = null;
  hasLiveCaptureValue = true;
  resetStores();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useSoniox H2 重连建连途中手动暂停', () => {
  it('退避定时器已触发、建连 await 中点暂停 → 连上后不得强制恢复录音', async () => {
    vi.useFakeTimers();
    const onAutoResume = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-h2', { idleTimeoutMs: 999_999_999, onAutoResume })
    );

    // 1) 正常开始并连上。
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    // 2) 断网：onError → pauseForInterruption('disconnect')（hasLiveCapture=true 故保持
    //    recording、shouldReconnect=true）+ attemptReconnect() 排退避定时器。
    hangNextStart = true;
    await act(async () => {
      capturedCallbacks[capturedCallbacks.length - 1].onError(new Error('ws down'));
      await Promise.resolve();
    });

    // 3) 推进退避：定时器触发 → 走完 ensureArchive/getSenderStream → 卡在 startSonioxRecording。
    const startsBeforeReconnect = startSonioxRecordingMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBe(
      startsBeforeReconnect + 1
    );
    expect(pendingResolvers.length).toBe(1);
    // 这一刻仍在 recording（断网续采语义），重连正等着建连返回 —— 正是漏洞窗口。
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    // 4) 用户在这个窗口里点「暂停」。
    act(() => {
      result.current.pause();
    });
    expect(useTranscriptStore.getState().recordingState).toBe('paused');
    archiveResume.mockClear();
    const resumeCallsAtPause = onAutoResume.mock.calls.length;

    // 5) WS 现在才连上（回调在 await 期间触发），随后 startSonioxRecording 才 resolve。
    await act(async () => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
      pendingResolvers.forEach((r) => r());
      pendingResolvers = [];
      await vi.advanceTimersByTimeAsync(0);
    });

    // 修复前：'connected' 分支无条件 archiveManager.resume() + setRecordingState('recording')
    //         + onAutoResume('disconnect') —— 用户点的暂停被抹掉，幽灵录音继续计费。
    expect(useTranscriptStore.getState().recordingState).toBe('paused');
    expect(archiveResume).not.toHaveBeenCalled();
    expect(onAutoResume.mock.calls.length).toBe(resumeCallsAtPause);

    // 新建的句柄必须被就地暂停（与 startNewRecording 的「晚到 start 对齐暂停意图」同款），
    // 否则句柄虽未被标成 recording，麦克风仍在往 Soniox 推流。
    const latestHandle = recordingHandles[recordingHandles.length - 1];
    expect(latestHandle.pause).toHaveBeenCalled();
  });

  it('未手动暂停时重连成功仍必须自动恢复录音（防守卫过紧）', async () => {
    vi.useFakeTimers();
    const onAutoResume = vi.fn();
    const { result } = renderHook(() =>
      useSoniox('sess-h2-ok', { idleTimeoutMs: 999_999_999, onAutoResume })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });

    await act(async () => {
      capturedCallbacks[capturedCallbacks.length - 1].onError(new Error('ws down'));
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // 重连里新建的连接连上（本例不暂停）。
    await act(async () => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    expect(onAutoResume).toHaveBeenCalledWith('disconnect');
  });
});

describe('useSoniox L47 录制态不得早于本地采集就绪', () => {
  /**
   * 订阅 store 记录 recordingState 的**每一次**取值变化（含一闪而过的中间态）。
   * 刻意不看 React 渲染结果、也不用 waitFor：那两种写法只能看到「尘埃落定后」的值，
   * 而本条 bug 的危害恰恰来自一闪而过的 'recording'（页面订阅 recordingState 的 effect
   * 只要看到一次就会 PATCH RECORDING）。本项目历史上出过 4 次「waitFor 吞掉首帧闪烁」
   * 的假测试，这里用 store 订阅把整条轨迹钉死。
   */
  function trackRecordingState(): { seen: string[]; stop: () => void } {
    const seen: string[] = [useTranscriptStore.getState().recordingState];
    const unsub = useTranscriptStore.subscribe((s) => {
      if (s.recordingState !== seen[seen.length - 1]) {
        seen.push(s.recordingState);
      }
    });
    return { seen, stop: unsub };
  }

  it('麦克风授权被拒 → recordingState 全程不得出现 recording（否则后端被 PATCH 成 RECORDING）', async () => {
    ensureArchiveError = new Error('NotAllowedError: Permission denied');
    hasLiveCaptureValue = false;
    const tracker = trackRecordingState();

    const { result } = renderHook(() =>
      useSoniox('sess-l47-denied', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    tracker.stop();

    // 旧行为：setRecordingState('recording') 跑在 getUserMedia **之前** —— 状态会先翻成
    // recording（页面订阅 recordingState 的 effect 立刻 PATCH RECORDING），随后才因授权被拒
    // 落回 idle。后端从此停在 RECORDING：下次进会话命中 resume-cold = 幽灵录制中。
    // 这里断言的是「整条轨迹里一次都没出现过 recording」，而不是「结束时不是 recording」——
    // 后者会被一闪而过的中间态骗过去。
    expect(tracker.seen).not.toContain('recording');
    expect(useTranscriptStore.getState().recordingState).toBe('idle');
    // 连 Soniox 都不该去连（取流就没成功）。
    expect(startSonioxRecordingMock).not.toHaveBeenCalled();
  });

  it('取流成功后仍必须翻成 recording（且早于 Soniox 连上——断网续采的前提）', async () => {
    const tracker = trackRecordingState();
    const { result } = renderHook(() =>
      useSoniox('sess-l47-ok', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    tracker.stop();

    expect(tracker.seen).toContain('recording');
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    // 注意：此刻 onConnectionChange('connected') 还没触发过（桩只发了 'connecting'）。
    // 「没连上也算 recording」正是断网续采/离线归档赖以成立的设计前提，不能一起推迟。
    expect(useTranscriptStore.getState().connectionState).not.toBe('connected');
  });
});

describe('useSoniox L24 短暂停复用句柄：寿命轮换与剩余额度', () => {
  it('暂停 → 恢复（复用句柄）必须按**剩余**寿命重排轮换，而不是等硬断', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSoniox('sess-l24-rearm', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    // key 寿命 900s → 轮换排在 870s 后。

    // 录 60s 后短暂停 5s 再恢复（<15s，走复用句柄分支）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    act(() => {
      result.current.pause();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const callsBeforeResume = startSonioxRecordingMock.mock.calls.length;
    await act(async () => {
      await result.current.start();
    });
    // 复用了同一个句柄（没有重新 mint）。
    expect(startSonioxRecordingMock.mock.calls.length).toBe(callsBeforeResume);
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    // 旧行为：pause() 撤销了轮换，而这条复用分支不经过 onConnectionChange('connected')，
    // 没有任何人把它排回来 → 只能等 Soniox 在 900s 处硬断（丢最后 ~5s 未 final 的字）。
    // 修复后：按剩余寿命（900-65≈835s，提前 30s）重排 → 推进到硬断前应当已经主动轮换过。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(840_000);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBeGreaterThan(
      callsBeforeResume
    );
  });

  it('剩余寿命不足 60s 时不复用句柄 —— 重建拿一份完整额度（否则一恢复就被硬断）', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSoniox('sess-l24-exhausted', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });

    // 录到 860s（轮换排在 870s，还没到），此时 key 只剩 40s 寿命。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(860_000);
    });
    // **短**暂停 5s —— 刻意远小于 PAUSE_HANDLE_STALE_MS(15s)，好让「句柄陈旧」那条既有判据
    // 判不出来：这一条只能靠「剩余寿命不足」拦下，测试才真正咬住 L24。
    act(() => {
      result.current.pause();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const callsBeforeResume = startSonioxRecordingMock.mock.calls.length;

    await act(async () => {
      await result.current.start();
    });

    // 剩余 <60s：必须重建（新 mint、新预扣、新的完整寿命），而不是复用一个马上要被硬断的连接。
    expect(startSonioxRecordingMock.mock.calls.length).toBeGreaterThan(
      callsBeforeResume
    );
  });
});
