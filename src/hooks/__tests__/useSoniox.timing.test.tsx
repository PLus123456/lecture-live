/**
 * useSoniox 时序回归测试（v3-R3）。
 *
 * 覆盖：
 *  - U20：暂停态切麦克风/应用设置不得静默恢复录音；重连完成前保持暂停，
 *         完成后 accumulatePausedTime 把暂停时长计入 totalPausedMs（不计费、计时不跳）。
 *  - U21：冷恢复（后端 draft 重建、store 由 idle 拉起、overallStartTimeRef 为空）后
 *         点『继续』续录时，recordingStartTime 不被重置（已录时长不清零），
 *         且续录段号紧接已恢复段（setSegmentCounterOffset）。
 *
 * 通过 mock 掉 Soniox client / 归档 / 音频块存储，用真实 zustand store 断言时序数值。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom 环境下 sessionStorage/localStorage 在此 vitest 配置里不可用（zustand persist
// 会 storage.setItem is not a function）。用内存桩替换，避免持久化中间件抛错。
// 必须在 store 模块求值前安装——用 vi.hoisted 保证在被 hoist 的 import 之前运行。
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

// ---- 捕获 startSonioxRecording 的回调，供测试手动驱动 onConnectionChange('connected') ----
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
    // 模拟真实客户端：先进入 connecting，但 connected 由测试显式触发
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

// ---- 归档管理器：全 no-op 桩 ----
vi.mock('@/lib/audio/recordingArchiveManager', () => ({
  RecordingArchiveManager: class {
    setChunkStoredHandler() {}
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
      return false;
    }
  },
}));

// ---- 音频块存储：空 ----
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

function resetStores() {
  useAuthStore.setState({ token: 'test-token' });
  useSettingsStore.setState({
    audioSource: 'mic',
    preferredMicDeviceId: 'mic-a',
    targetLang: 'zh',
    sourceLang: 'en',
  } as never);
  // 干净的 transcript store
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

function makeSegment(n: number): TranscriptSegment {
  return {
    id: `seg-${n}`,
    sessionIndex: 0,
    speaker: '',
    language: 'en',
    text: `restored ${n}`,
    globalStartMs: (n - 1) * 1000,
    globalEndMs: n * 1000,
    startMs: (n - 1) * 1000,
    endMs: n * 1000,
    isFinal: true,
    confidence: 1,
    timestamp: '00:00:00',
  };
}

beforeEach(() => {
  capturedCallbacks.length = 0;
  startSonioxRecordingMock.mockClear();
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('U20：暂停态切麦克风不静默恢复录音', () => {
  it('暂停中 switchMicrophone 应保持 paused，连接完成后才恢复且暂停时长计入 totalPausedMs', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    // 录音开始于 t=1_000_000
    nowSpy.mockReturnValue(1_000_000);

    const { result } = renderHook(() => useSoniox('sess-1'));

    // 模拟正在录音：设置状态并让 hook 认为有活跃会话
    // 先真正 start 一次以建立 recordingRef + overallStartTimeRef
    await act(async () => {
      await result.current.start();
    });
    // 驱动首次连接完成 → recording
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    expect(useTranscriptStore.getState().recordingStartTime).toBe(1_000_000);

    // t=1_060_000（60s 后）用户暂停
    nowSpy.mockReturnValue(1_060_000);
    act(() => {
      result.current.pause();
    });
    expect(useTranscriptStore.getState().recordingState).toBe('paused');
    expect(useTranscriptStore.getState().pausedAt).toBe(1_060_000);
    const totalPausedBefore = useTranscriptStore.getState().totalPausedMs;

    // t=1_070_000（暂停 10s 后）在抽屉里切麦克风
    nowSpy.mockReturnValue(1_070_000);
    await act(async () => {
      await result.current.switchMicrophone('mic-b');
    });

    // 关键：切麦重建期间必须仍为 paused，绝不能静默变回 recording
    expect(useTranscriptStore.getState().recordingState).toBe('paused');
    expect(useTranscriptStore.getState().pausedAt).toBe(1_060_000);

    // t=1_075_000 新连接建立完成
    nowSpy.mockReturnValue(1_075_000);
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });

    // 现在才恢复 recording，且 [1_060_000, 1_075_000] 的暂停 15s 被计入 totalPausedMs
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    expect(useTranscriptStore.getState().pausedAt).toBeNull();
    expect(useTranscriptStore.getState().totalPausedMs).toBe(
      totalPausedBefore + (1_075_000 - 1_060_000)
    );
    // recordingStartTime 保持不变（preserveStartTime）
    expect(useTranscriptStore.getState().recordingStartTime).toBe(1_000_000);

    nowSpy.mockRestore();
  });
});

describe('U21：冷恢复续录不清零计时、段号连续', () => {
  it('overallStartTimeRef 为空 + preserveStartTime 时应回退读取 store.recordingStartTime 并设段偏移', async () => {
    const nowSpy = vi.spyOn(Date, 'now');

    // 模拟冷恢复：draft 分支已恢复 3 段、40 分钟时长、暂停态
    const durationMs = 40 * 60 * 1000;
    const restoreNow = 5_000_000;
    nowSpy.mockReturnValue(restoreNow);
    useTranscriptStore.setState({
      segments: [makeSegment(1), makeSegment(2), makeSegment(3)],
      recordingState: 'paused',
      recordingStartTime: restoreNow - durationMs,
      pausedAt: restoreNow,
      totalPausedMs: 0,
      connectionState: 'disconnected',
    } as never);

    const { result } = renderHook(() => useSoniox('sess-cold'));

    // 用户点『继续』（稍后 t=5_030_000，静置了 30s）
    const resumeNow = restoreNow + 30_000;
    nowSpy.mockReturnValue(resumeNow);
    await act(async () => {
      await result.current.start();
    });

    // 关键断言 1：recordingStartTime 不得被重置为 now（否则 40 分钟清零）
    expect(useTranscriptStore.getState().recordingStartTime).toBe(
      restoreNow - durationMs
    );

    // 冷恢复且暂停态：连接完成前保持 paused
    expect(useTranscriptStore.getState().recordingState).toBe('paused');

    // 驱动连接完成
    const connectNow = resumeNow + 5_000;
    nowSpy.mockReturnValue(connectNow);
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });

    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    // 已录时长仍在：recordingStartTime 未被推到 now
    expect(useTranscriptStore.getState().recordingStartTime).toBe(
      restoreNow - durationMs
    );

    // 关键断言 2：续录段号必须紧接已恢复段（seg-4 起），不与 seg-1..3 串号。
    // 通过 processor 处理一条 final token 触发一个新段，检查其 id。
    const cb = capturedCallbacks[capturedCallbacks.length - 1];
    act(() => {
      cb.onPartialResult([
        {
          text: 'hello',
          is_final: true,
          start_ms: 0,
          end_ms: 500,
          confidence: 1,
          language: 'en',
        },
      ]);
      // 触发 endpoint 以 flush 段落
      cb.onEndpoint();
    });

    const segs = useTranscriptStore.getState().segments;
    const newSeg = segs[segs.length - 1];
    expect(newSeg.id).toBe('seg-4');

    nowSpy.mockRestore();
  });
});

describe('U57/时间戳：暂停/断网空档不计入续录偏移（computeResumeOffset）', () => {
  it('暂停中切麦重连后，新段 globalStartMs 以 pausedAt 冻结点为准（60s），不含暂停/切麦空档', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    // 录音开始于 t=1_000_000
    nowSpy.mockReturnValue(1_000_000);

    const { result } = renderHook(() => useSoniox('sess-ts'));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    expect(useTranscriptStore.getState().recordingStartTime).toBe(1_000_000);

    // t=1_060_000：录了 60s 后暂停
    nowSpy.mockReturnValue(1_060_000);
    act(() => {
      result.current.pause();
    });
    expect(useTranscriptStore.getState().pausedAt).toBe(1_060_000);

    // t=1_070_000：暂停 10s 后切麦（走 computeResumeOffset —— 以 pausedAt 冻结点算偏移=60_000，
    // 而非旧的 now 基准 70_000）。
    nowSpy.mockReturnValue(1_070_000);
    await act(async () => {
      await result.current.switchMicrophone('mic-b');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('paused');

    // t=1_075_000：新连接建立完成
    nowSpy.mockReturnValue(1_075_000);
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    // 喂一条 final token（start_ms=0）→ 新段 globalStartMs = timeOffsetMs(=60_000) + 0 = 60_000。
    // 关键：不是 now 基准的 70_000/75_000 —— 暂停/切麦这段空档不被当成音频时长算进偏移。
    const cb = capturedCallbacks[capturedCallbacks.length - 1];
    act(() => {
      cb.onPartialResult([
        {
          text: 'resumed',
          is_final: true,
          start_ms: 0,
          end_ms: 500,
          confidence: 1,
          language: 'en',
        },
      ]);
      cb.onEndpoint();
    });

    const segs = useTranscriptStore.getState().segments;
    const newSeg = segs[segs.length - 1];
    expect(newSeg.globalStartMs).toBe(60_000);

    nowSpy.mockRestore();
  });
});

describe('S2：断网抖动不复位重连计数，MAX 封顶生效（重连风暴封顶）', () => {
  it('反复短暂连上又断开 > MAX 次后最终触发 onReconnectFailed（短暂连接不清零计数）', async () => {
    vi.useFakeTimers();
    const onReconnectFailed = vi.fn();
    const lastCb = () => capturedCallbacks[capturedCallbacks.length - 1];

    const { result } = renderHook(() =>
      // idleTimeoutMs 拉大，避免推进假时钟时误触发静音自动暂停干扰计数。
      useSoniox('sess-storm', { onReconnectFailed, idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      lastCb().onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    // 抖动：连上→立即断→重连→连上→立即断……每次连接都远不到 8s 稳定阈值。
    // 旧逻辑(WS open 即清零计数)下 MAX 永远到不了 = 无限重连风暴；
    // 修复后计数持续累计，超过 MAX 后 attemptReconnect 放弃并触发 onReconnectFailed。
    for (let i = 0; i < 8; i++) {
      act(() => {
        lastCb().onError(new Error('flap'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      act(() => {
        lastCb().onConnectionChange('connected');
      });
    }

    expect(onReconnectFailed).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('R686：手动继续取消 pending 自动重连，避免双流双计费', () => {
  it('断网后未等自动重连、手动 start，pending 重连定时器被取消，不再建立第二条连接', async () => {
    vi.useFakeTimers();
    const lastCb = () => capturedCallbacks[capturedCallbacks.length - 1];
    const { result } = renderHook(() =>
      useSoniox('sess-dual', { idleTimeoutMs: 999_999_999 })
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      lastCb().onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    // 断网 → pauseForInterruption('disconnect') + attemptReconnect 排定时器
    await act(async () => {
      lastCb().onError(new Error('disconnect'));
      await Promise.resolve();
    });
    const callsBeforeManual = startSonioxRecordingMock.mock.calls.length;

    // 用户不等自动重连，手动点「继续」并驱动连接完成 → 回到 recording 态
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      lastCb().onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    const callsAfterManual = startSonioxRecordingMock.mock.calls.length;
    // 手动恰好建立一条连接
    expect(callsAfterManual).toBe(callsBeforeManual + 1);

    // 推进假时钟越过重连退避：旧 bug 下 pending 定时器仍在，其 guard 见 recordingState
    // 已是 'recording' 会放行、开出第二条 WS = 双流双计费。修复后不应再建连接。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBe(callsAfterManual);

    vi.useRealTimers();
  });
});

describe('R1491：暂停态刷新恢复不把暂停空档算入续录偏移', () => {
  it('reconnectAfterRefresh 保留原 pausedAt 冻结点，续录段时间基于冻结点而非刷新时刻', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const t0 = 2_000_000;
    const pausedAt = t0 + 60_000; // 录了 60s 后暂停
    const refreshAt = t0 + 60_000 + 300_000; // 暂停挂机 5min 后刷新
    nowSpy.mockReturnValue(refreshAt);

    useTranscriptStore.setState({
      segments: [],
      recordingState: 'paused',
      recordingStartTime: t0,
      pausedAt,
      totalPausedMs: 0,
      connectionState: 'disconnected',
      currentPreviewText: { finalText: '', nonFinalText: '' },
    } as never);

    const { result } = renderHook(() => useSoniox('sess-refresh'));

    await act(async () => {
      await result.current.reconnectAfterRefresh();
    });

    // 直接断言：暂停冻结点必须保留，不被 setPausedAt(now) 覆盖，否则点继续时暂停空档漏扣。
    expect(useTranscriptStore.getState().pausedAt).toBe(pausedAt);

    // 续录并连接完成后喂一个 token（start_ms=0）：段偏移应 ≈ 60s（冻结点），
    // 而非 ≈ 360s（若把 5min 暂停空档算入录音时长）。
    await act(async () => {
      await result.current.start();
    });
    const lastCb = capturedCallbacks[capturedCallbacks.length - 1];
    act(() => {
      lastCb.onConnectionChange('connected');
    });
    act(() => {
      lastCb.onPartialResult([
        { text: 'x', is_final: true, start_ms: 0, end_ms: 200, confidence: 1, language: 'en' },
      ]);
      lastCb.onEndpoint();
    });
    const segs = useTranscriptStore.getState().segments;
    expect(segs.length).toBeGreaterThan(0);
    const seg = segs[segs.length - 1];
    expect(seg.globalStartMs).toBeLessThan(120_000);

    nowSpy.mockRestore();
  });
});

describe('R1278：长暂停后继续应重建连接而非复用可能已死的句柄', () => {
  it('暂停超过句柄存活窗口(15s)后 start 走重建，不静默复用死句柄', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const { result } = renderHook(() =>
      useSoniox('sess-stale', { idleTimeoutMs: 999_999_999 })
    );
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    expect(useTranscriptStore.getState().recordingState).toBe('recording');
    const callsAfterStart = startSonioxRecordingMock.mock.calls.length;

    // 主动暂停（保留 Soniox 句柄）
    act(() => {
      result.current.pause();
    });
    expect(useTranscriptStore.getState().recordingState).toBe('paused');

    // 长暂停 20s（> PAUSE_HANDLE_STALE_MS=15s）后点继续：句柄多半已死，应重建连接
    nowSpy.mockReturnValue(1_020_000);
    await act(async () => {
      await result.current.start();
    });
    // 重建 = startSonioxRecording 再被调用一次；旧 bug 会复用死句柄、不重建（calls 不变）
    expect(startSonioxRecordingMock.mock.calls.length).toBe(callsAfterStart + 1);

    nowSpy.mockRestore();
  });

  it('短暂停(<15s)后继续复用现有句柄，不重建', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_000_000);
    const { result } = renderHook(() =>
      useSoniox('sess-fresh-resume', { idleTimeoutMs: 999_999_999 })
    );
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      capturedCallbacks[capturedCallbacks.length - 1].onConnectionChange('connected');
    });
    const callsAfterStart = startSonioxRecordingMock.mock.calls.length;

    act(() => {
      result.current.pause();
    });
    // 仅暂停 5s 后继续：连接大概率仍活，复用句柄、不重建
    nowSpy.mockReturnValue(2_005_000);
    await act(async () => {
      await result.current.start();
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBe(callsAfterStart);
    expect(useTranscriptStore.getState().recordingState).toBe('recording');

    nowSpy.mockRestore();
  });
});
