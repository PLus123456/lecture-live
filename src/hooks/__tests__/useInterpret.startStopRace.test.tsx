/**
 * useInterpret H3 竞态回归：start 进行中点停止 / 卸载。
 *
 * 漏洞（审计 H3 + 主 agent 验真裁定）：`start()` 有两个 await 窗口 —— 建锚点的
 * `fetch('/api/interpret/start')` 与 `startSonioxRecording`（mint key + WS 握手，数百 ms～数秒）。
 * 窗口里点「停止」或导航离开时，`stop()` / 卸载清理读到的 `recordingRef.current` 还是 null：
 * 句柄相关全部 no-op，却照常结算扣费并把 UI 置成已停止。随后 start 的后半段无条件
 * `recordingRef.current = result` + `scheduleRotation(...)`：
 *   - 麦克风 + Soniox WS 复活，且这一场**永不再计费**；
 *   - 更糟的是轮换定时器在 stop 清空 `rotationTimerRef` **之后**才排上，此后每 ~15 分钟
 *     自动重建一条 Soniox 连接 —— 孤儿自我续命。
 * 次级窗口（stop 落在锚点 fetch 期间）里 `setInterval` 永久泄漏，`setIsRunning(true)` 还会
 * 在 stop 之后把 UI 假复活。
 *
 * 整个文件此前没有 runId/代次机制（对比 useSoniox 的 runIdRef 全链路防护）。
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

const recordingHandles: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
const capturedCallbacks: SonioxCallbacks[] = [];
let pendingSonioxResolvers: Array<() => void> = [];
let hangNextStart = false;

const startSonioxRecordingMock = vi.fn(
  async (_config: unknown, _token: string, callbacks: SonioxCallbacks) => {
    capturedCallbacks.push(callbacks);
    const handle = { stop: vi.fn().mockResolvedValue(undefined) };
    recordingHandles.push(handle);
    const result = {
      recording: handle,
      client: {},
      // 15 分钟 key：轮换会被排在 (900-30)s 后。
      temporaryKey: { max_session_duration_seconds: 900 },
    };
    if (hangNextStart) {
      return new Promise((resolve) => {
        pendingSonioxResolvers.push(() => resolve(result));
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

import { useInterpret } from '@/hooks/useInterpret';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';

// ── fetch 桩：/api/interpret/start 可控挂起；/api/interpret/deduct 记录调用 ──
let pendingAnchorResolvers: Array<() => void> = [];
let hangAnchorFetch = false;
const deductCalls: Array<Record<string, unknown>> = [];

function installFetchMock() {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/interpret/start')) {
      const ok = {
        ok: true,
        json: async () => ({ anchorId: 'anchor-1' }),
      } as unknown as Response;
      if (hangAnchorFetch) {
        return new Promise<Response>((resolve) => {
          pendingAnchorResolvers.push(() => resolve(ok));
        });
      }
      return ok;
    }
    if (url.includes('/api/interpret/deduct')) {
      deductCalls.push(
        init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      );
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  recordingHandles.length = 0;
  capturedCallbacks.length = 0;
  deductCalls.length = 0;
  pendingSonioxResolvers = [];
  pendingAnchorResolvers = [];
  hangNextStart = false;
  hangAnchorFetch = false;
  startSonioxRecordingMock.mockClear();
  useAuthStore.setState({ token: 'test-token' } as never);
  useSettingsStore.setState({ endpointDetectionMs: 800 } as never);
  installFetchMock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useInterpret H3 主窗口：stop 落在 startSonioxRecording 期间', () => {
  it('晚到的连接必须就地拆掉，且绝不排轮换定时器（否则每 15 分钟自我重建一条流）', async () => {
    vi.useFakeTimers();
    hangNextStart = true;
    const { result } = renderHook(() => useInterpret());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start('en', 'zh');
      // 推进到 startSonioxRecording 的挂起点（锚点 fetch 已 resolve）。
      await vi.waitFor(() => {
        if (pendingSonioxResolvers.length === 0) throw new Error('not at soniox yet');
      });
    });
    expect(result.current.isRunning).toBe(true);

    // 建连仍挂起时用户点「停止」。
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.isRunning).toBe(false);
    // 停止照常结算扣费（带上服务端锚点）。
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0].anchorId).toBe('anchor-1');

    // 建连现在才返回。
    await act(async () => {
      pendingSonioxResolvers.forEach((r) => r());
      pendingSonioxResolvers = [];
      await startPromise;
    });

    // 修复前：句柄被无条件发布（麦克风 + WS 复活、永不再计费）。
    expect(recordingHandles[0].stop).toHaveBeenCalled();

    // 修复前更致命的一条：scheduleRotation 在 stop 清空 rotationTimerRef **之后**才排上，
    // 于是 ~15 分钟后自动重建一条 Soniox 连接，孤儿自我续命。
    const sonioxCallsAfterStop = startSonioxRecordingMock.mock.calls.length;
    hangNextStart = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBe(sonioxCallsAfterStop);
  });

  it('正常一场同传仍会排轮换定时器并按时重建连接（防守卫过紧）', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInterpret());

    await act(async () => {
      await result.current.start('en', 'zh');
    });
    expect(startSonioxRecordingMock).toHaveBeenCalledTimes(1);

    // (900 - 30)s 后主动平滑轮换：重新 mint 一条连接接续本场。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(880_000);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('useInterpret H3 次级窗口：stop 落在建锚点 fetch 期间', () => {
  it('不得再启动 Soniox、不得泄漏计时器、不得把 UI 假复活', async () => {
    vi.useFakeTimers();
    hangAnchorFetch = true;
    const { result } = renderHook(() => useInterpret());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start('en', 'zh');
      await vi.waitFor(() => {
        if (pendingAnchorResolvers.length === 0) throw new Error('not at anchor yet');
      });
    });
    // 锚点还没回来：计时器与句柄都还没建立，UI 仍是未运行。
    expect(result.current.isRunning).toBe(false);

    await act(async () => {
      await result.current.stop();
    });

    // 锚点 fetch 现在才返回。
    await act(async () => {
      pendingAnchorResolvers.forEach((r) => r());
      pendingAnchorResolvers = [];
      await startPromise;
    });

    // 修复前：照常建计时器、setIsRunning(true)、开一条 Soniox 流。
    expect(startSonioxRecordingMock).not.toHaveBeenCalled();
    expect(result.current.isRunning).toBe(false);

    // 计时器泄漏检查：推进 10s，elapsedMs 必须纹丝不动（旧代码里 setInterval 永久空转）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.elapsedMs).toBe(0);

    // 抢建出来的服务端锚点被顺手结算掉（durationMs=0 + anchorId），不留给 cron 7h 兜底。
    expect(deductCalls.some((c) => c.anchorId === 'anchor-1')).toBe(true);
  });
});

describe('useInterpret H3 卸载清理', () => {
  it('启动途中卸载 → 晚到的连接被拆掉、不排轮换定时器', async () => {
    vi.useFakeTimers();
    hangNextStart = true;
    const { result, unmount } = renderHook(() => useInterpret());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start('en', 'zh');
      await vi.waitFor(() => {
        if (pendingSonioxResolvers.length === 0) throw new Error('not at soniox yet');
      });
    });

    // SPA 导航离开 /interpret。旧代码 `if (recordingRef.current)` 为 false → 整条清理被跳过。
    act(() => {
      unmount();
    });

    await act(async () => {
      pendingSonioxResolvers.forEach((r) => r());
      pendingSonioxResolvers = [];
      await startPromise;
    });

    expect(recordingHandles[0].stop).toHaveBeenCalled();
    // 卸载路径同样要触发结算（C7 的原意），否则整场同传不计费。
    expect(deductCalls.some((c) => c.anchorId === 'anchor-1')).toBe(true);

    const callsAfterUnmount = startSonioxRecordingMock.mock.calls.length;
    hangNextStart = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
    });
    expect(startSonioxRecordingMock.mock.calls.length).toBe(callsAfterUnmount);
  });
});
