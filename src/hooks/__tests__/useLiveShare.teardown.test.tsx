// L1 + L2 + M2 的主播端收尾语义。
//
// L1：share_error（JWT 过期后重连鉴权失败等）此前只重置本地 UI，DB 里 ShareLink.isLive
//     仍为 true —— 分享列表和公开链接都显示「直播中」，实际早已没人推流（僵尸链接）。
// L2：stopSharing 原来是「先 DELETE、再 broadcast SHARE_OFFLINE、再 disconnect」。
//     DELETE 会触发 SHARE-REVOKE-001 的内部通知把观众全部断开，晚发的状态更新根本
//     没人收得到；而未连接时 emit 会进 sendBuffer，紧随的 disconnect() 走 destroy()
//     把缓冲整个丢掉（socket.io-client 4.8.3 源码核实）。
// M2：连接终态（服务端踢人 / 握手被拒 / 超过重连期限）此前完全没有出口，主播 UI
//     会一直显示「直播中」。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type Callbacks = {
  onViewerCount?: (count: number) => void;
  onError?: (error: { message: string }) => void;
  onConnectionChange?: (
    state: 'connected' | 'reconnecting' | 'closed',
    info?: { reason?: string; message?: string }
  ) => void;
};

const { trace, instances, FakeBroadcaster } = vi.hoisted(() => {
  const trace: string[] = [];
  const instances: Array<{ callbacks?: Callbacks }> = [];

  class FakeBroadcaster {
    callbacks?: Callbacks;
    constructor(_url: string, options: { callbacks?: Callbacks }) {
      this.callbacks = options.callbacks;
      instances.push(this);
    }
    broadcastStatusUpdate(status: string) {
      trace.push(`broadcast:${status}`);
      return true;
    }
    disconnect() {
      trace.push('disconnect');
    }
    get isConnected() {
      return true;
    }
  }

  return { trace, instances, FakeBroadcaster };
});

vi.mock('@/lib/liveShare/broadcaster', () => ({
  LiveBroadcaster: FakeBroadcaster,
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { token: string }) => unknown) => selector({ token: 'jwt' }),
    { getState: () => ({ token: 'jwt' }) }
  ),
}));

import { useLiveShare } from '@/hooks/useLiveShare';

describe('useLiveShare 主播端收尾（L1 / L2 / M2）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    trace.length = 0;
    instances.length = 0;
    fetchMock = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      trace.push(`fetch:${method}:${init?.body ?? ''}`);
      return {
        ok: true,
        json: async () => ({ token: 'share-token' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function startSharing() {
    const { result } = renderHook(() => useLiveShare());
    await act(async () => {
      await result.current.startSharing('session-1');
    });
    trace.length = 0; // 只关心开播之后的行为
    return result;
  }

  it('L2：SHARE_OFFLINE 在 DELETE 之前发出，disconnect 排在最后', async () => {
    const result = await startSharing();

    await act(async () => {
      await result.current.stopSharing('session-1', { keepForPlayback: true });
    });

    const broadcastIndex = trace.findIndex((entry) =>
      entry.startsWith('broadcast:SHARE_OFFLINE')
    );
    const deleteIndex = trace.findIndex((entry) => entry.startsWith('fetch:DELETE'));
    const disconnectIndex = trace.indexOf('disconnect');

    expect(broadcastIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(broadcastIndex);
    expect(disconnectIndex).toBeGreaterThan(deleteIndex);
    // keepForPlayback 必须原样透传（否则回放链接会被连带撤销）
    expect(trace[deleteIndex]).toContain('"keepForPlayback":true');
  });

  it('L1：share_error 时撤销 ShareLink，而不是只重置本地 UI 留下僵尸链接', async () => {
    await startSharing();

    await act(async () => {
      instances[0].callbacks?.onError?.({ message: 'Broadcaster auth failed' });
      await Promise.resolve();
    });

    const deleteCall = trace.find((entry) => entry.startsWith('fetch:DELETE'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall).toContain('"sessionId":"session-1"');
    // 故障收尾是完全撤销，不保留回放
    expect(deleteCall).not.toContain('keepForPlayback');
    expect(trace).toContain('disconnect');
  });

  it('M2：连接进入终态时同样收尾并撤销链接', async () => {
    await startSharing();

    await act(async () => {
      instances[0].callbacks?.onConnectionChange?.('closed', {
        reason: 'io server disconnect',
      });
      await Promise.resolve();
    });

    expect(trace.some((entry) => entry.startsWith('fetch:DELETE'))).toBe(true);
  });

  it('M2：仅仅是 reconnecting 不得收尾（服务端还有 15s 主播宽限期）', async () => {
    await startSharing();

    await act(async () => {
      instances[0].callbacks?.onConnectionChange?.('reconnecting', {
        reason: 'transport close',
      });
      await Promise.resolve();
    });

    expect(trace.some((entry) => entry.startsWith('fetch:DELETE'))).toBe(false);
    expect(trace).not.toContain('disconnect');
  });

  it('迟到的旧实例回调不得撤销新一轮开播的链接', async () => {
    const result = await startSharing();
    const stale = instances[0];

    // 重新开播：模块级单例已经换成新实例
    await act(async () => {
      await result.current.startSharing('session-2');
    });
    trace.length = 0;

    await act(async () => {
      stale.callbacks?.onError?.({ message: 'stale failure' });
      await Promise.resolve();
    });

    expect(trace.some((entry) => entry.startsWith('fetch:DELETE'))).toBe(false);
  });
});
