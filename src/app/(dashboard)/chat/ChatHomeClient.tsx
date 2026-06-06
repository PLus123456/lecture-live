'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  MessageSquare,
  Plus,
  Clock,
  Loader2,
  AlertCircle,
  Trash2,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/stores/toastStore';
import ConfirmDialog from '@/components/ConfirmDialog';

interface ConversationCard {
  id: string;
  title?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  updatedAt?: string;
  messageCount?: number;
  degradationLevel?: number;
}

/**
 * 「最近对话」时间格式：当天显示 HH:MM；7 天内显示 X 天前；更早显示 YYYY-MM-DD。
 */
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

export default function ChatHomeClient() {
  const router = useRouter();
  const { t } = useI18n();
  const { token } = useAuth();
  const [conversations, setConversations] = useState<ConversationCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  /**
   * 'ok'    — 后端正确返回
   * 'error' — 拉取失败（401/500/网络抖动），显示错误 + 重试，不再误报“端点未上线”
   */
  const [listStatus, setListStatus] = useState<'ok' | 'error'>('ok');
  // 待确认删除的对话（null = 弹窗关闭）
  const [pendingDelete, setPendingDelete] = useState<ConversationCard | null>(
    null
  );
  const [deleting, setDeleting] = useState(false);
  // 重命名：正在编辑的对话 id + 编辑中的标题（null = 未在编辑）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  /* ──────────────────────────────────────────────────────────────
     拉取最近 20 条全局 conversation。失败（401/500/网络）置 'error' → 显示重试，
     不再把任何失败都误报成“端点未上线”。
     ────────────────────────────────────────────────────────────── */
  const loadConversations = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      setLoading(true);
      try {
        const res = await fetch('/api/conversations?scope=global&limit=20', {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();
        let raw: unknown[] = [];
        if (Array.isArray(data)) {
          raw = data;
        } else if (data && typeof data === 'object') {
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

  /* ──────────────────────────────────────────────────────────────
     新建对话：POST /api/conversations {} → 跳转 /chat/<newId>
     U9 之前的端点要求 sessionId，会 400 报错 — toast 后用户至少
     知道是后端尚未就绪，不至于一直 spinner。
     ────────────────────────────────────────────────────────────── */
  const handleCreateConversation = useCallback(async () => {
    if (!token || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        toast.error(
          t('common.operationFailed'),
          `HTTP ${res.status}`
        );
        return;
      }
      const data = (await res.json()) as {
        conversation?: { id: string };
        id?: string;
      };
      const newId = data.conversation?.id ?? data.id;
      if (!newId) {
        toast.error(t('common.operationFailed'));
        return;
      }
      router.push(`/chat/${newId}`);
    } catch (err) {
      toast.error(
        t('common.networkError'),
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setCreating(false);
    }
  }, [token, creating, router, t]);

  /* ──────────────────────────────────────────────────────────────
     删除对话：乐观从列表移除 → DELETE /api/conversations/[id]
     失败回滚并 toast。后端会连带清理附件文件 + 本地图片 + 释放配额。
     ────────────────────────────────────────────────────────────── */
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
      toast.success(t('chat.deleteSuccess'));
    } catch (err) {
      setConversations(prev); // 回滚
      toast.error(
        t('chat.deleteFailed'),
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, token, deleting, conversations, t]);

  /* ──────────────────────────────────────────────────────────────
     重命名对话：乐观更新 → PATCH /api/conversations/[id] { title }，失败回滚。
     ────────────────────────────────────────────────────────────── */
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
    } catch {
      setConversations((list) =>
        list.map((c) => (c.id === id ? { ...c, title: prevTitle } : c))
      );
      toast.error(t('common.operationFailed'));
    }
  }, [editingId, editTitle, token, conversations, t]);

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      {/* 顶部：标题 + 新建按钮 */}
      <div className="flex-shrink-0 px-8 lg:px-12 pt-8 lg:pt-10 pb-4">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="animate-fade-in-up">
            <div className="flex items-center gap-2 mb-1">
              <MessageSquare className="w-5 h-5 text-rust-400" />
              <span className="text-xs font-medium text-rust-400 tracking-wider uppercase">
                {t('chat.title')}
              </span>
            </div>
            <h1 className="font-serif text-2xl font-bold text-charcoal-800 tracking-tight">
              {t('chat.title')}
            </h1>
          </div>

          <button
            type="button"
            onClick={handleCreateConversation}
            disabled={creating || !token}
            className="group/btn relative flex items-center gap-2.5
                       bg-gradient-to-r from-rust-500 to-rust-600 text-white rounded-xl
                       hover:from-rust-600 hover:to-rust-700 active:scale-[0.97]
                       transition-all duration-200
                       shadow-lg shadow-rust-500/20 hover:shadow-xl hover:shadow-rust-500/30
                       animate-fade-in-up stagger-2 px-5 py-3
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold leading-tight">
                {t('chat.newConversation')}
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* 中间：最近对话列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-8 lg:px-12">
        {/* 加载失败提示 + 重试 */}
        {listStatus === 'error' && !loading && (
          <div className="mb-4 flex items-center justify-between gap-2 px-3 py-2 rounded-md
                          bg-red-50 border border-red-200 text-[11px] text-red-700">
            <span className="flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {t('chat.loadFailed')}
            </span>
            <button
              type="button"
              onClick={() => void loadConversations()}
              className="px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700
                         transition-colors flex-shrink-0"
            >
              {t('common.retry')}
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-2 animate-pulse">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-16 rounded-xl bg-cream-100 border border-cream-200"
              />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 animate-fade-in-up">
            <div className="w-16 h-16 rounded-2xl bg-cream-200/50 flex items-center justify-center mb-4 animate-breathe">
              <MessageSquare className="w-7 h-7 text-charcoal-300" />
            </div>
            <p className="text-sm font-medium text-charcoal-500 mb-1">
              {t('chat.noConversations')}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {conversations.map((c, index) => {
              const title =
                c.title && c.title.trim().length > 0
                  ? c.title
                  : t('chat.unnamed');
              const when = formatRelative(c.updatedAt ?? c.startedAt);
              return (
                <div
                  key={c.id}
                  className="group relative animate-list-item-in"
                  style={{
                    animationDelay: `${Math.min(index * 0.04, 0.4)}s`,
                  }}
                >
                {editingId === c.id ? (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-rust-300 bg-white">
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
                      className="w-8 h-8 rounded-lg flex items-center justify-center
                                 text-white bg-rust-500 hover:bg-rust-600 transition-colors flex-shrink-0"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      aria-label={t('common.cancel')}
                      title={t('common.cancel')}
                      className="w-8 h-8 rounded-lg flex items-center justify-center
                                 text-charcoal-400 hover:bg-cream-100 transition-colors flex-shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                <>
                <Link
                  href={`/chat/${c.id}`}
                  className="flex items-center gap-4 px-4 py-3.5 pr-20 rounded-xl
                             border border-cream-200 bg-white
                             hover:border-rust-300 hover:shadow-sm card-hover-lift
                             transition-all duration-200"
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
                <button
                  type="button"
                  onClick={() => startRename(c)}
                  aria-label={t('chat.rename')}
                  title={t('chat.rename')}
                  className="absolute right-11 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg
                             flex items-center justify-center text-charcoal-300
                             hover:text-rust-500 hover:bg-rust-50
                             opacity-0 group-hover:opacity-100 focus:opacity-100
                             transition-all duration-150"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(c)}
                  aria-label={t('chat.delete')}
                  title={t('chat.delete')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg
                             flex items-center justify-center text-charcoal-300
                             hover:text-red-500 hover:bg-red-50
                             opacity-0 group-hover:opacity-100 focus:opacity-100
                             transition-all duration-150"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                </>
                )}
                </div>
              );
            })}
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
    </div>
  );
}
