// M1：观看页在 /api/share/view/:token 的 .then() 里才 joinAsViewer。
//
// 事故形态：用户在 fetch 返回前离开页面 → React 的 cleanup 先跑 leaveAsViewer()，
// 而此时 viewerInstance 还是 null（是个空操作）；随后迟到的 .then() 照常建 socket
// 并 join。这个 socket 之后再没有任何代码路径断得掉它（viewerInstance 是模块级单例，
// 跟着整个 SPA 生命周期活着），永久计入服务端 viewer_count。
//
// 修法是 effect 内的 cancelled 闸门。本测试同时给出「已卸载不许 join」与
// 「未卸载必须 join」两侧断言 —— 只有前者的话，把 joinAsViewer 整个删掉也能过。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const { joinAsViewer, leaveAsViewer } = vi.hoisted(() => ({
  joinAsViewer: vi.fn(),
  leaveAsViewer: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=abcDEF123'),
}));

// 模块级稳定引用：useLiveShare 每次渲染返回新函数的话，观看页的 effect 依赖数组
// 会每帧变化、effect 反复重跑，测的就不是原来的时序了。
vi.mock('@/hooks/useLiveShare', () => ({
  useLiveShare: () => ({ joinAsViewer, leaveAsViewer }),
}));

vi.mock('@/components/viewer/ViewerSettingsPanel', () => ({
  SettingsToggle: () => null,
  SettingsDrawer: () => null,
}));

vi.mock('@/components/session/LiveShareBadge', () => ({
  default: () => null,
}));

vi.mock('../ViewerTranscriptPanel', () => ({
  ViewerTranscriptPanel: () => null,
}));

// 观看页的所有状态回写都过账号边界闸门（卸载 / 账号切换后一律丢弃）。
// 本用例只测 join 时序，边界恒定「仍是同一主体」。
vi.mock('@/stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { token: string | null }) => unknown) =>
      selector({ token: null }),
    { getState: () => ({ token: null }) }
  ),
  getAuthBoundarySnapshot: () => ({ epoch: 1, userId: null, sessionBinding: null }),
  getAuthBoundaryAbortSignal: () => ({ aborted: false }),
  isAuthBoundaryCurrent: () => true,
  isPersistedAuthBoundaryCurrent: () => true,
}));

vi.mock('@/lib/clientAuthCookieMutation', () => ({
  runAuthBoundaryCommit: async (
    _expected: unknown,
    commit: () => unknown | Promise<unknown>
  ) => ({ committed: true, value: await commit() }),
}));

import ViewerPage from '../page';

const LIVE_SESSION_RESPONSE = {
  sessionId: 'session-1',
  session: {
    title: 'Live lecture',
    status: 'RECORDING',
    sourceLang: 'zh',
    targetLang: 'en',
  },
};

describe('观看页 join 生命周期（M1）', () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    joinAsViewer.mockClear();
    leaveAsViewer.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // fetch → .then(r => r.json()) → .then(data => …) 中间隔着好几层 microtask，
  // 用宏任务把队列彻底排空，避免「其实是没跑到 join」冒充「守卫生效」。
  async function flush() {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it('fetch 返回前卸载：迟到的 .then() 不再建立幽灵观众连接', async () => {
    const { unmount } = render(<ViewerPage />);
    unmount();

    resolveFetch({ json: async () => LIVE_SESSION_RESPONSE });
    await flush();

    expect(joinAsViewer).not.toHaveBeenCalled();
    // cleanup 本身仍要照常跑（对已建连的观众它才是真正的断开路径）
    expect(leaveAsViewer).toHaveBeenCalled();
  });

  it('对照组：未卸载时 fetch 返回后照常 join（证明上一条不是因为压根没走到 join）', async () => {
    render(<ViewerPage />);

    resolveFetch({ json: async () => LIVE_SESSION_RESPONSE });
    await flush();

    expect(joinAsViewer).toHaveBeenCalledTimes(1);
    expect(joinAsViewer.mock.calls[0][0]).toBe('abcDEF123');
  });
});

/**
 * M2：观众端此前对 connect_error / disconnect / SERVER_SHUTDOWN 完全没有处理，
 * WS 不可达、Origin 被拒、每 IP 连接数超限时 loading spinner 永久悬挂。
 * 这里直接驱动 joinAsViewer 收到的那组回调，断言它们真的映射到了 UI。
 */
describe('观看页连接态映射（M2）', () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    joinAsViewer.mockClear();
    leaveAsViewer.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderJoined() {
    const utils = render(<ViewerPage />);
    resolveFetch({ json: async () => LIVE_SESSION_RESPONSE });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const callbacks = joinAsViewer.mock.calls[0][1] as {
      onConnectionChange: (
        state: string,
        info?: { reason?: string; message?: string }
      ) => void;
      onInitialState: (snapshot: Record<string, unknown>) => void;
      onStatusUpdate: (data: { status: string }) => void;
    };
    return { ...utils, callbacks };
  }

  const EMPTY_SNAPSHOT = {
    segments: [],
    translations: {},
    summaryBlocks: [],
  };

  it('终态断连 → 结束 loading 并显示错误（不再永久转圈）', async () => {
    const { callbacks, container } = await renderJoined();

    await act(async () => {
      callbacks.onConnectionChange('closed', {
        message: 'Too many connections from this IP',
      });
    });

    expect(container.textContent).toContain('Too many connections from this IP');
    expect(container.textContent).not.toContain('Connecting to live session');
  });

  it('重连中 → 只挂提示条，已加载的内容与视图保持不变', async () => {
    const { callbacks, container } = await renderJoined();

    await act(async () => {
      callbacks.onInitialState(EMPTY_SNAPSHOT);
    });
    await act(async () => {
      callbacks.onConnectionChange('reconnecting', { reason: 'transport close' });
    });

    expect(container.textContent).toContain('reconnecting');
    // 不是错误页
    expect(container.textContent).not.toContain('Unable to open');
  });

  it('SERVER_SHUTDOWN → 进入重连提示，而不是被当成直播结束', async () => {
    const { callbacks, container } = await renderJoined();

    await act(async () => {
      callbacks.onInitialState(EMPTY_SNAPSHOT);
    });
    await act(async () => {
      callbacks.onStatusUpdate({ status: 'SERVER_SHUTDOWN' });
    });

    expect(container.textContent).toContain('reconnecting');
    // SHARE_OFFLINE 才切静态完成态，SERVER_SHUTDOWN 不该切
    expect(container.textContent).not.toContain('Transcript record');
  });

  it('正常结束（SHARE_OFFLINE）之后的静默断开不被盖成错误页', async () => {
    const { callbacks, container } = await renderJoined();

    await act(async () => {
      callbacks.onInitialState(EMPTY_SNAPSHOT);
    });
    await act(async () => {
      callbacks.onStatusUpdate({ status: 'SHARE_OFFLINE' });
    });
    await act(async () => {
      // SHARE-REVOKE-001 的 transition 驱逐：服务端 disconnect(true)，不发 share_error
      callbacks.onConnectionChange('closed', { reason: 'io server disconnect' });
    });

    expect(container.textContent).not.toContain('Unable to open');
  });

  it('H1：快照带 truncated 标记时告知观众 backlog 不全', async () => {
    const { callbacks, container } = await renderJoined();

    await act(async () => {
      callbacks.onInitialState({ ...EMPTY_SNAPSHOT, truncated: true });
    });

    expect(container.textContent).toContain('Earlier content was omitted');
  });
});
