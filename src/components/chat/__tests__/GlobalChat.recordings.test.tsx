import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M21 回归锁：GlobalChat 的录音 pill 跨对话串台。
 *
 * 组件按 conversationId 复用、**不卸载**（/chat/[conversationId] 同动态段互跳），所以
 * 任何以 conversationId 为边界的本地 state 都必须显式重置、任何异步回写都必须校验归属：
 *   1) 切换对话时若不清 recordings，新对话在自己的 fetch 返回前会显示**上一个对话**的 pill；
 *   2) handleDetachRecording 的失败回滚若不比对活跃对话，DELETE 期间切走后的回滚会把
 *      旧对话的 pill 列表写进新对话视图。
 */

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, refresh: vi.fn() }),
}));

// t 必须是**稳定引用**：GlobalChat 有多个把 t 放进依赖数组的 useCallback/useMemo。
const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));

// 只 stub 与本用例无关的重组件（各自会自行发请求 / 拉 ESM 大图）；
// RecordingsBar 保持真实渲染 —— 它就是「pill 是否可见」的被测表面。
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../RecordingPicker', () => ({ default: () => null }));
vi.mock('../ComposerModelControls', () => ({ default: () => null }));
vi.mock('../ComposerAttachMenu', () => ({ default: () => null }));
// 渲染计数探针：它随 GlobalChat 一起重渲染（没有 memo），用来观测 L49 的订阅粒度。
const renderProbe = vi.hoisted(() => ({ count: 0 }));
vi.mock('../ChatContextIndicator', () => ({
  default: () => {
    renderProbe.count += 1;
    return null;
  },
}));

// zustand persist 在每次 setState 都会写 localStorage，而 vitest 自带的 localStorage 在
// --localstorage-file 下写入会抛错；createJSONStorage 又在模块加载时就捕获 localStorage
// 引用 —— 故必须在 import store 之前整体换成内存实现，再动态加载（与 chatStore.test.tsx 同）。
const memStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memStorage.set(k, String(v));
    },
    removeItem: (k: string) => {
      memStorage.delete(k);
    },
    clear: () => memStorage.clear(),
    key: () => null,
    length: 0,
  },
});

const { default: GlobalChat } = await import('@/components/chat/GlobalChat');
const { useAuthStore } = await import('@/stores/authStore');
const { useChatStore } = await import('@/stores/chatStore');

type FakeResponse = Pick<Response, 'ok' | 'status'> & { json: () => Promise<unknown> };

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): FakeResponse {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  };
}

const NEVER = new Promise<never>(() => {});

/** 一个可由测试手动兑现的 promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 每个对话的录音列表响应（undefined = 永不返回，用于观察「fetch 未返回」那一帧）。 */
let recordingsByConversation: Record<string, unknown[] | undefined>;
/** DELETE /recordings 的受控响应。 */
let pendingDelete: ReturnType<typeof deferred<FakeResponse>> | null;

function installFetch() {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<unknown> => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/recordings')) {
        if (method === 'DELETE') {
          if (!pendingDelete) return jsonResponse({}, { ok: true });
          return pendingDelete.promise;
        }
        const convId = url.split('/api/conversations/')[1]?.split('/')[0] ?? '';
        const list = recordingsByConversation[decodeURIComponent(convId)];
        if (list === undefined) return NEVER;
        return jsonResponse({ recordings: list });
      }
      if (url.includes('/messages')) {
        return jsonResponse({ conversation: { endedAt: null }, messages: [] });
      }
      if (url.includes('/api/chat-uploads')) {
        return jsonResponse({ attachments: [] });
      }
      return jsonResponse({});
    }
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GlobalChat — 录音 pill 的对话归属（M21）', () => {
  beforeEach(() => {
    replaceMock.mockClear();
    recordingsByConversation = {};
    pendingDelete = null;
    useAuthStore.setState({ token: 'test-token' });
    useChatStore.getState().resetSession();
    useChatStore.getState().setActiveConversation(null);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('切到新对话的瞬间就不再显示上一个对话的录音 pill（新对话的 fetch 尚未返回）', async () => {
    recordingsByConversation = {
      'conv-a': [{ sessionId: 's-a', title: '甲课录音' }],
      // conv-b 的录音请求永不返回 —— 复现「新对话数据还没到」的那一帧。
      'conv-b': undefined,
    };

    const { rerender } = render(<GlobalChat conversationId="conv-a" />);

    await waitFor(() => {
      expect(screen.getByText('甲课录音')).toBeInTheDocument();
    });

    // 切换对话：组件实例复用，只有 conversationId prop 变化。
    // 断言必须是「rerender 提交完就看不到」，不能用 waitFor —— waitFor 会一直重试到
    // 条件成立，从而把「短暂串台」这一帧吞掉（本项目历史上出过 4 次这种假测试）。
    await act(async () => {
      rerender(<GlobalChat conversationId="conv-b" />);
    });

    expect(screen.queryByText('甲课录音')).not.toBeInTheDocument();
  });

  it('DELETE 期间切走：失败回滚不把旧对话的 pill 写进新对话视图', async () => {
    recordingsByConversation = {
      'conv-a': [{ sessionId: 's-a', title: '甲课录音' }],
      'conv-b': [],
    };
    pendingDelete = deferred<FakeResponse>();

    const user = userEvent.setup();
    const { rerender } = render(<GlobalChat conversationId="conv-a" />);

    await waitFor(() => {
      expect(screen.getByText('甲课录音')).toBeInTheDocument();
    });

    // 点 pill 上的 ×：乐观移除 + 发出 DELETE（响应被我们扣住）
    await user.click(screen.getByTitle('chat.removeRecording'));
    expect(screen.queryByText('甲课录音')).not.toBeInTheDocument();

    // DELETE 在途时切到另一个对话
    await act(async () => {
      rerender(<GlobalChat conversationId="conv-b" />);
    });
    await waitFor(() => {
      expect(useChatStore.getState().activeConversationId).toBe('conv-b');
    });

    // 迟到的 DELETE 失败 → 触发回滚
    await act(async () => {
      pendingDelete!.resolve(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
      await Promise.resolve();
    });

    expect(screen.queryByText('甲课录音')).not.toBeInTheDocument();
  });

  it('留在原对话时 DELETE 失败仍然正常回滚（守卫没有把正常回滚也挡掉）', async () => {
    recordingsByConversation = {
      'conv-a': [{ sessionId: 's-a', title: '甲课录音' }],
    };
    pendingDelete = deferred<FakeResponse>();

    const user = userEvent.setup();
    render(<GlobalChat conversationId="conv-a" />);

    await waitFor(() => {
      expect(screen.getByText('甲课录音')).toBeInTheDocument();
    });

    await user.click(screen.getByTitle('chat.removeRecording'));
    expect(screen.queryByText('甲课录音')).not.toBeInTheDocument();

    await act(async () => {
      pendingDelete!.resolve(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('甲课录音')).toBeInTheDocument();
    });
  });
});

describe('GlobalChat — chatStore 订阅粒度（L49）', () => {
  beforeEach(() => {
    recordingsByConversation = { 'conv-a': [] };
    pendingDelete = null;
    renderProbe.count = 0;
    useAuthStore.setState({ token: 'test-token' });
    useChatStore.getState().resetSession();
    useChatStore.getState().setActiveConversation(null);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const message = (id: string, content: string) => ({
    id,
    role: 'assistant' as const,
    content,
    timestamp: 0,
  });

  it('别的对话的流式 delta 不再让本实例重渲染', async () => {
    render(<GlobalChat conversationId="conv-a" />);
    await waitFor(() => {
      expect(useChatStore.getState().activeConversationId).toBe('conv-a');
    });
    await act(async () => {
      await Promise.resolve();
    });

    const before = renderProbe.count;
    expect(before).toBeGreaterThan(0);

    await act(async () => {
      useChatStore.getState().addMessage('conv-other', message('m-1', 'x'));
      useChatStore.getState().updateMessage('conv-other', 'm-1', { content: 'xy' });
    });

    expect(renderProbe.count).toBe(before);
  });

  it('本对话的流式 delta 照常重渲染并显示新内容', async () => {
    render(<GlobalChat conversationId="conv-a" />);
    await waitFor(() => {
      expect(useChatStore.getState().activeConversationId).toBe('conv-a');
    });

    await act(async () => {
      useChatStore.getState().addMessage('conv-a', message('m-1', '流式内容'));
    });

    await waitFor(() => {
      expect(screen.getByText('流式内容')).toBeInTheDocument();
    });
  });
});
