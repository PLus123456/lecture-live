'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  MessageSquare,
  Clock,
  AlertCircle,
  Trash2,
  Pencil,
  Check,
  X,
  Archive,
  ArchiveRestore,
  Search,
  ArrowLeft,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/stores/toastStore';
import { useConversationListStore } from '@/stores/conversationListStore';
import ConfirmDialog from '@/components/ConfirmDialog';

interface ConversationCard {
  id: string;
  title?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  messageCount?: number;
  archived?: boolean;
}

function formatRelative(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (diffMs < oneDayMs && d.toDateString() === now.toDateString()) {
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      return `${hh}:${mm}`;
    }
    const diffDays = Math.round(diffMs / oneDayMs);
    if (diffDays < 7 && diffDays >= 1) return `${diffDays}d`;
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export default function ConversationsClient() {
  const { t } = useI18n();
  const { token } = useAuth();
  const [conversations, setConversations] = useState<ConversationCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [listStatus, setListStatus] = useState<'ok' | 'error'>('ok');
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ConversationCard | null>(
    null
  );
  const [deleting, setDeleting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const loadConversations = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      setLoading(true);
      try {
        // scope=global：与 /chat 首页、ChatSidebar 同一套过滤（只列全局对话），
        // 录音会话里自动创建的对话不再混进来 —— 此前用 recent=50 导致
        // 「全部对话里有、外面没有」的不一致。
        const res = await fetch(
          '/api/conversations?scope=global&includeArchived=true',
          { headers: { Authorization: `Bearer ${token}` }, signal }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();
        let raw: unknown[] = [];
        if (Array.isArray(data)) raw = data;
        else if (data && typeof data === 'object') {
          const obj = data as Record<string, unknown>;
          if (Array.isArray(obj.conversations)) raw = obj.conversations;
          else if (Array.isArray(obj.items)) raw = obj.items;
        }
        const list = raw.filter(
          (c): c is ConversationCard =>
            !!c &&
            typeof c === 'object' &&
            typeof (c as ConversationCard).id === 'string'
        );
        setConversations(list);
        setListStatus('ok');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setListStatus('error');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [token]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadConversations(controller.signal);
    return () => controller.abort();
  }, [loadConversations]);

  const handleConfirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target || !token || deleting) return;
    setDeleting(true);
    const prev = conversations;
    setConversations((list) => list.filter((c) => c.id !== target.id));
    try {
      const res = await fetch(`/api/conversations/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPendingDelete(null);
      // 同步侧栏/首页共享列表
      useConversationListStore.getState().remove(target.id);
      toast.success(t('chat.deleteSuccess'));
    } catch (err) {
      setConversations(prev);
      toast.error(
        t('chat.deleteFailed'),
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, token, deleting, conversations, t]);

  const startRename = useCallback((c: ConversationCard) => {
    setEditingId(c.id);
    setEditTitle(c.title?.trim() ?? '');
  }, []);

  const commitRename = useCallback(async () => {
    const id = editingId;
    if (!id) return;
    const title = editTitle.trim();
    const target = conversations.find((c) => c.id === id);
    setEditingId(null);
    if (!token || !title || title === (target?.title ?? '')) return;
    const prevTitle = target?.title ?? null;
    setConversations((list) =>
      list.map((c) => (c.id === id ? { ...c, title } : c))
    );
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 同步侧栏/首页共享列表
      useConversationListStore.getState().rename(id, title);
    } catch {
      setConversations((list) =>
        list.map((c) => (c.id === id ? { ...c, title: prevTitle } : c))
      );
      toast.error(t('common.operationFailed'));
    }
  }, [editingId, editTitle, token, conversations, t]);

  const handleArchiveToggle = useCallback(
    async (c: ConversationCard) => {
      if (!token) return;
      const next = !c.archived;
      setConversations((list) =>
        list.map((x) => (x.id === c.id ? { ...x, archived: next } : x))
      );
      try {
        const res = await fetch(`/api/conversations/${c.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ archived: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 归档状态影响侧栏可见性（侧栏只显示非归档）→ 强刷共享列表
        void useConversationListStore.getState().refresh(token, { force: true });
      } catch {
        setConversations((list) =>
          list.map((x) => (x.id === c.id ? { ...x, archived: c.archived } : x))
        );
        toast.error(t('common.operationFailed'));
      }
    },
    [token, t]
  );

  const handleClearAll = useCallback(async () => {
    if (!token || clearing) return;
    setClearing(true);
    const prev = conversations;
    try {
      const res = await fetch('/api/conversations', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        // globalOnly：本页只展示全局对话，清空也只清全局 —— 不能把录音会话
        // 里的对话（本页看不见）连带删掉。
        body: JSON.stringify({ all: true, globalOnly: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConversations([]);
      setClearOpen(false);
      void useConversationListStore.getState().refresh(token, { force: true });
      toast.success(t('chat.clearAllSuccess'));
    } catch (err) {
      setConversations(prev);
      toast.error(
        t('chat.deleteFailed'),
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setClearing(false);
    }
  }, [token, clearing, conversations, t]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      (c.title ?? '').toLowerCase().includes(q)
    );
  }, [conversations, search]);
  const active = filtered.filter((c) => !c.archived);
  const archived = filtered.filter((c) => c.archived);

  const renderCard = (c: ConversationCard, index: number) => {
    const title =
      c.title && c.title.trim().length > 0 ? c.title : t('chat.unnamed');
    const when = formatRelative(c.startedAt);
    // 入场动画统一由此控制：列表逐项 stagger，上限 0.4s
    const animStyle = {
      animationDelay: `${Math.min(index * 0.04, 0.4)}s`,
    };
    if (editingId === c.id) {
      return (
        <div
          key={c.id}
          className="flex items-center gap-2 px-4 py-3 rounded-xl border border-rust-300 bg-white"
        >
          <input
            autoFocus
            value={editTitle}
            maxLength={100}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              else if (e.key === 'Escape') setEditingId(null);
            }}
            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-cream-300 text-sm
                       focus:outline-none focus:ring-1 focus:ring-rust-400 focus:border-rust-400
                       bg-white text-charcoal-800"
          />
          <button
            type="button"
            onClick={() => void commitRename()}
            aria-label={t('common.save')}
            title={t('common.save')}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white bg-rust-500 hover:bg-rust-600 transition-colors flex-shrink-0"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setEditingId(null)}
            aria-label={t('common.cancel')}
            title={t('common.cancel')}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-charcoal-400 hover:bg-cream-100 transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      );
    }
    return (
      <div
        key={c.id}
        style={animStyle}
        className="group flex items-center gap-3 px-4 py-3 rounded-xl border border-cream-200 bg-white
                   hover:border-rust-300 hover:shadow-sm transition-all duration-200 animate-list-item-in"
      >
        <Link
          href={`/chat/${c.id}`}
          className="flex items-center gap-3 flex-1 min-w-0"
        >
          <div className="w-9 h-9 rounded-lg bg-cream-100 flex items-center justify-center flex-shrink-0">
            <MessageSquare className="w-4 h-4 text-rust-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-sm font-semibold text-charcoal-800 truncate group-hover:text-rust-600 transition-colors">
                {title}
              </span>
              {c.endedAt && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-charcoal-100 text-charcoal-500">
                  closed
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-charcoal-400">
              {when && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {when}
                </span>
              )}
              {typeof c.messageCount === 'number' && (
                <span>{c.messageCount} msgs</span>
              )}
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
          <button
            type="button"
            onClick={() => startRename(c)}
            aria-label={t('chat.rename')}
            title={t('chat.rename')}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-charcoal-300 hover:text-rust-500 hover:bg-rust-50 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleArchiveToggle(c)}
            aria-label={c.archived ? t('chat.unarchive') : t('chat.archive')}
            title={c.archived ? t('chat.unarchive') : t('chat.archive')}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-charcoal-300 hover:text-charcoal-600 hover:bg-cream-100 transition-colors"
          >
            {c.archived ? (
              <ArchiveRestore className="w-3.5 h-3.5" />
            ) : (
              <Archive className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(c)}
            aria-label={t('chat.delete')}
            title={t('chat.delete')}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-charcoal-300 hover:text-red-500 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      {/* 顶部：返回 + 标题 + 清空全部 */}
      <div className="flex-shrink-0 px-8 lg:px-12 pt-8 lg:pt-10 pb-4">
        <div className="flex items-center justify-between gap-4 mb-4 animate-fade-in-up">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/chat"
              aria-label={t('common.back')}
              className="w-9 h-9 rounded-lg border border-cream-200 bg-white flex items-center justify-center text-charcoal-500 hover:border-rust-300 hover:text-rust-600 transition-colors flex-shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <h1 className="font-serif text-2xl font-bold text-charcoal-800 tracking-tight truncate">
              {t('chat.history')}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setClearOpen(true)}
            disabled={conversations.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
                       text-red-600 border border-red-200 bg-white hover:bg-red-50
                       transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('chat.clearAll')}
          </button>
        </div>

        {/* 搜索 */}
        <div className="relative animate-fade-in-up stagger-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-300" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('chat.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-cream-200 text-sm bg-white
                       text-charcoal-700 placeholder:text-charcoal-300
                       focus:outline-none focus:ring-1 focus:ring-rust-400 focus:border-rust-400"
          />
        </div>
      </div>

      {/* 列表（max-md:pb-28 给移动端 fixed BottomTabBar 让位） */}
      <div className="flex-1 min-h-0 overflow-y-auto px-8 lg:px-12 pb-8 max-md:pb-28">
        {listStatus === 'error' && !loading && (
          <div className="mb-4 flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-[11px] text-red-700">
            <span className="flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {t('chat.loadFailed')}
            </span>
            <button
              type="button"
              onClick={() => void loadConversations()}
              className="px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 transition-colors flex-shrink-0"
            >
              {t('common.retry')}
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-2 animate-pulse">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-16 rounded-xl bg-cream-100 border border-cream-200"
              />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-cream-200/50 flex items-center justify-center mb-4">
              <MessageSquare className="w-7 h-7 text-charcoal-300" />
            </div>
            <p className="text-sm font-medium text-charcoal-500">
              {t('chat.noConversations')}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-charcoal-400">
            {t('chat.noResults')}
          </div>
        ) : (
          <div className="space-y-4">
            {active.length > 0 && (
              <div className="space-y-1.5">
                {active.map((c, i) => renderCard(c, i))}
              </div>
            )}
            {archived.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 px-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-charcoal-400 animate-fade-in-up">
                  <Archive className="w-3 h-3" />
                  {t('chat.archivedSection')}（{archived.length}）
                </div>
                {archived.map((c, i) => renderCard(c, active.length + i))}
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        loading={deleting}
        title={t('chat.confirmDeleteTitle')}
        message={t('chat.confirmDeleteMessage')}
        confirmText={t('common.delete')}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
      />
      <ConfirmDialog
        open={clearOpen}
        danger
        loading={clearing}
        title={t('chat.confirmClearAllTitle')}
        message={t('chat.confirmClearAllMessage')}
        confirmText={t('chat.clearAll')}
        onConfirm={handleClearAll}
        onCancel={() => {
          if (!clearing) setClearOpen(false);
        }}
      />
    </div>
  );
}
