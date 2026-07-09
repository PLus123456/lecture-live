'use client';

import { create } from 'zustand';

/**
 * 全局对话列表（scope=global）的共享 store。
 *
 * ChatSidebar / ChatHome / 全部对话页共用同一份非归档列表，保证
 * 「侧栏、首页最近对话、全部对话」三处永远一致（此前首页 scope=global、
 * 历史页 recent=N 两套过滤器，录音会话里自动建的对话只在历史页出现）。
 *
 * 归档对话不进这份列表（只在 /conversations 页单独拉 includeArchived=true）。
 */
export interface ConversationListItem {
  id: string;
  title?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  archived?: boolean;
  messageCount?: number;
}

interface ConversationListStore {
  /** null = 尚未加载过 */
  items: ConversationListItem[] | null;
  loading: boolean;
  error: boolean;
  /**
   * 拉取最新列表。默认 1.5s 内的重复调用会被去抖（侧栏与页面同时挂载时
   * 只发一次请求）；写操作后要立刻反映真相时传 { force: true }。
   */
  refresh: (token: string, opts?: { force?: boolean }) => Promise<void>;
  /** 本地乐观移除（删除对话后调用） */
  remove: (id: string) => void;
  /** 本地乐观改标题（重命名后调用） */
  rename: (id: string, title: string) => void;
  /** 清空（登出时调用，防止换账号后残留上一个用户的列表） */
  clear: () => void;
}

function parseList(data: unknown): ConversationListItem[] {
  let raw: unknown[] = [];
  if (Array.isArray(data)) {
    raw = data;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.conversations)) raw = obj.conversations;
    else if (Array.isArray(obj.items)) raw = obj.items;
  }
  return raw.filter(
    (c): c is ConversationListItem =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as ConversationListItem).id === 'string'
  );
}

// 并发守卫：只有最新一次 refresh 的结果允许落盘（防旧响应覆盖新数据）
let refreshSeq = 0;
let lastFetchedAt = 0;

export const useConversationListStore = create<ConversationListStore>()(
  (set, get) => ({
    items: null,
    loading: false,
    error: false,

    refresh: async (token, opts) => {
      const now = Date.now();
      if (!opts?.force && get().items !== null && now - lastFetchedAt < 1500) {
        return;
      }
      lastFetchedAt = now;
      const seq = ++refreshSeq;
      set({ loading: true });
      try {
        const res = await fetch('/api/conversations?scope=global', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();
        if (seq !== refreshSeq) return;
        set({ items: parseList(data), loading: false, error: false });
      } catch {
        if (seq !== refreshSeq) return;
        // 失败回滚去抖时间戳：下一次非 force 刷新（如用户切页/重试）立即可发，
        // 不被失败请求占用的 1.5s 窗口吞掉。
        lastFetchedAt = 0;
        set({ loading: false, error: true });
      }
    },

    // remove/rename 都推进 refreshSeq：使写操作之前已在途的 refresh 响应作废，
    // 防止旧快照落地把刚删除的会话"复活"/把新标题打回旧值。

    remove: (id) => {
      refreshSeq++;
      set((s) => ({
        items: s.items ? s.items.filter((c) => c.id !== id) : s.items,
      }));
    },

    rename: (id, title) => {
      refreshSeq++;
      set((s) => ({
        items: s.items
          ? s.items.map((c) => (c.id === id ? { ...c, title } : c))
          : s.items,
      }));
    },

    clear: () => {
      lastFetchedAt = 0;
      refreshSeq++; // 使在途 refresh 的结果作废，不会把旧用户数据写回来
      set({ items: null, loading: false, error: false });
    },
  })
);
