import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * L49 回归锁：useChat 只订阅**活跃对话**那一片运行时态。
 *
 * 旧写法是无 selector 的 `useChatStore()`（订阅整个 store）——任一对话的 SSE 每来一个
 * delta 就让所有使用方全量重渲染。这里同时锁住两侧：
 *   - 别的对话的写入不再触发重渲染（性能）；
 *   - 活跃对话的写入仍然触发重渲染且读到新值（语义没被改坏）。
 */

// zustand persist 写 localStorage 在 vitest 里会抛错：先换内存实现再动态加载 store。
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

const { useChat } = await import('@/hooks/useChat');
const { useChatStore } = await import('@/stores/chatStore');
const { useAuthStore } = await import('@/stores/authStore');

const msg = (id: string, content: string) => ({
  id,
  role: 'assistant' as const,
  content,
  timestamp: 0,
});

describe('useChat 的 store 订阅粒度（L49）', () => {
  beforeEach(() => {
    memStorage.clear();
    // token 留空：models / conversations 两条 effect 都会早退，本用例只看订阅粒度。
    useAuthStore.setState({ token: null, user: null });
    useChatStore.getState().resetSession();
    useChatStore.getState().setActiveConversation('conv-active');
  });

  it('别的对话的流式写入不会让 useChat 重渲染', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useChat(null);
    });

    const before = renders;
    act(() => {
      useChatStore.getState().addMessage('conv-other', msg('m-1', 'hi'));
      useChatStore.getState().updateMessage('conv-other', 'm-1', { content: 'hi there' });
    });

    expect(renders).toBe(before);
  });

  it('活跃对话的流式写入仍然触发重渲染并读到新值', () => {
    const { result } = renderHook(() => useChat(null));

    expect(result.current.messages).toHaveLength(0);

    act(() => {
      useChatStore.getState().addMessage('conv-active', msg('m-1', '你好'));
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe('你好');

    act(() => {
      useChatStore.getState().updateMessage('conv-active', 'm-1', { content: '你好，世界' });
    });

    expect(result.current.messages[0].content).toBe('你好，世界');
  });

  it('切换活跃对话后读到的是新对话的切片', () => {
    const { result } = renderHook(() => useChat(null));

    act(() => {
      useChatStore.getState().addMessage('conv-active', msg('m-1', '甲'));
      useChatStore.getState().addMessage('conv-other', msg('m-2', '乙'));
    });
    expect(result.current.messages.map((m) => m.content)).toEqual(['甲']);

    act(() => {
      useChatStore.getState().setActiveConversation('conv-other');
    });
    expect(result.current.messages.map((m) => m.content)).toEqual(['乙']);
  });
});
