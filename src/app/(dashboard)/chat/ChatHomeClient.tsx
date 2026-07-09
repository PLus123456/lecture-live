'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  MessageSquare,
  Clock,
  Loader2,
  AlertCircle,
  Trash2,
  Pencil,
  Check,
  X,
  ArrowUp,
  ChevronRight,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/stores/toastStore';
import { useChatStore } from '@/stores/chatStore';
import {
  useConversationListStore,
  type ConversationListItem,
} from '@/stores/conversationListStore';
import ConfirmDialog from '@/components/ConfirmDialog';

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

/**
 * /chat 首页 —— Claude 式起聊页。
 *
 * 居中问候语 + composer：输入首条消息回车 → POST 创建对话 → 把文本存进
 * chatStore.pendingFirstMessage → 跳 /chat/<id>，GlobalChat 加载完自动发送。
 * 下方是最近对话列表（与 ChatSidebar 共享 conversationListStore，天然一致）。
 */
export default function ChatHomeClient() {
  const router = useRouter();
  const { t } = useI18n();
  const { token } = useAuth();

  const items = useConversationListStore((s) => s.items);
  const listLoading = useConversationListStore((s) => s.loading);
  const listError = useConversationListStore((s) => s.error);
  const refresh = useConversationListStore((s) => s.refresh);
  const removeFromList = useConversationListStore((s) => s.remove);
  const renameInList = useConversationListStore((s) => s.rename);

  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  // IME 合成守卫（与 GlobalChat 同步，含 Safari compositionend→keydown 时间窗）
  const [composing, setComposing] = useState(false);
  const lastCompositionEndRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // 待确认删除的对话（null = 弹窗关闭）
  const [pendingDelete, setPendingDelete] =
    useState<ConversationListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 重命名：正在编辑的对话 id + 编辑中的标题（null = 未在编辑）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  useEffect(() => {
    if (!token) return;
    void refresh(token);
  }, [token, refresh]);

  /* ──────────────────────────────────────────────────────────────
     发送首条消息：创建对话 → 暂存文本 → 跳详情页自动发送
     ────────────────────────────────────────────────────────────── */
  const handleStart = useCallback(async () => {
    const text = draft.trim();
    if (!text || creating || !token) return;
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
        toast.error(t('common.operationFailed'), `HTTP ${res.status}`);
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
      useChatStore
        .getState()
        .setPendingFirstMessage({ conversationId: newId, text });
      // 强刷共享列表：路由变化触发的侧栏刷新不带 force，1.5s 去抖窗口内
      // （进页面即刷过一次）新会话会缺席侧栏，这里显式补上。
      void useConversationListStore.getState().refresh(token, { force: true });
      router.push(`/chat/${newId}`);
    } catch (err) {
      toast.error(
        t('common.networkError'),
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setCreating(false);
    }
  }, [draft, creating, token, router, t]);

  /* ──────────────────────────────────────────────────────────────
     删除对话：二次确认 → DELETE → 同步共享列表
     ────────────────────────────────────────────────────────────── */
  const handleConfirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target || !token || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/conversations/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      removeFromList(target.id);
      setPendingDelete(null);
      toast.success(t('chat.deleteSuccess'));
    } catch (err) {
      toast.error(
        t('chat.deleteFailed'),
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, token, deleting, removeFromList, t]);

  /* ──────────────────────────────────────────────────────────────
     重命名对话：乐观更新共享列表 → PATCH，失败回滚
     ────────────────────────────────────────────────────────────── */
  const startRename = useCallback((c: ConversationListItem) => {
    setEditingId(c.id);
    setEditTitle(c.title?.trim() ?? '');
  }, []);

  const commitRename = useCallback(async () => {
    const id = editingId;
    if (!id) return;
    const title = editTitle.trim();
    const target = items?.find((c) => c.id === id);
    setEditingId(null);
    if (!token || !title || title === (target?.title ?? '')) return;
    const prevTitle = target?.title ?? '';
    renameInList(id, title);
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
      renameInList(id, prevTitle);
      toast.error(t('common.operationFailed'));
    }
  }, [editingId, editTitle, token, items, renameInList, t]);

  const conversations = items ?? [];
  const showSkeleton = items === null && listLoading;

  return (
    <div className="h-[100dvh] overflow-y-auto">
      {/* max-md:pb-28 给移动端 fixed BottomTabBar（~72px+safe-inset）让位 */}
      <div className="max-w-2xl mx-auto px-6 pt-[14vh] pb-16 max-md:pb-28">
        {/* 问候语 */}
        <div className="text-center mb-8 animate-fade-in-up">
          <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-rust-50 border border-rust-100 flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-rust-500" />
          </div>
          <h1 className="font-serif text-2xl lg:text-3xl font-bold text-charcoal-800 tracking-tight">
            {t('chat.greeting')}
          </h1>
        </div>

        {/* Composer：输入首条消息即开聊 */}
        <div
          className="rounded-2xl border border-cream-300 bg-white shadow-sm
                     focus-within:border-rust-400 focus-within:ring-1 focus-within:ring-rust-400
                     px-4 pt-3 pb-2.5 mb-10 animate-fade-in-up stagger-2 transition-colors"
        >
          <textarea
            ref={composerRef}
            rows={2}
            value={draft}
            disabled={creating}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !composing &&
                !e.nativeEvent.isComposing &&
                e.nativeEvent.keyCode !== 229 &&
                Date.now() - lastCompositionEndRef.current > 50
              ) {
                e.preventDefault();
                void handleStart();
              }
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => {
              setComposing(false);
              lastCompositionEndRef.current = Date.now();
            }}
            placeholder={t('chat.composerPlaceholder')}
            className="w-full bg-transparent text-sm resize-none max-h-40 overflow-y-auto
                       focus:outline-none text-charcoal-700 placeholder:text-charcoal-300
                       disabled:cursor-not-allowed"
          />
          <div className="flex items-center justify-end pt-1">
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={creating || !token || !draft.trim()}
              aria-label={t('chat.send')}
              title={t('chat.send')}
              className="w-8 h-8 rounded-lg bg-rust-500 text-white hover:bg-rust-600
                         flex items-center justify-center
                         disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowUp className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* 最近对话 */}
        <div className="animate-fade-in-up stagger-3">
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-[11px] font-medium text-charcoal-400 tracking-wider uppercase">
              {t('sidebar.recentChats')}
            </span>
            <Link
              href="/conversations"
              className="flex items-center gap-0.5 text-xs text-charcoal-400
                         hover:text-rust-600 transition-colors"
            >
              {t('chat.viewAll')}
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {listError && !listLoading && (
            <div className="mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-md
                            bg-red-50 border border-red-200 text-[11px] text-red-700">
              <span className="flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {t('chat.loadFailed')}
              </span>
              <button
                type="button"
                onClick={() => token && void refresh(token, { force: true })}
                className="px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700
                           transition-colors flex-shrink-0"
              >
                {t('common.retry')}
              </button>
            </div>
          )}

          {showSkeleton ? (
            <div className="space-y-2 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 rounded-xl bg-cream-100 border border-cream-200"
                />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="py-8 text-center text-xs text-charcoal-300">
              {t('chat.noConversations')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {conversations.slice(0, 10).map((c, index) => {
                const title =
                  c.title && c.title.trim().length > 0
                    ? c.title
                    : t('chat.unnamed');
                const when = formatRelative(c.startedAt);
                return (
                  <div
                    key={c.id}
                    className="group relative animate-list-item-in"
                    style={{
                      animationDelay: `${Math.min(index * 0.04, 0.4)}s`,
                    }}
                  >
                    {editingId === c.id ? (
                      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-rust-300 bg-white">
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
                          className="flex items-center gap-3 px-4 py-2.5 pr-20 rounded-xl
                                     border border-cream-200 bg-white
                                     hover:border-rust-300 hover:shadow-sm
                                     transition-all duration-200"
                        >
                          <div className="w-8 h-8 rounded-lg bg-cream-100 flex items-center justify-center flex-shrink-0">
                            <MessageSquare className="w-3.5 h-3.5 text-rust-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-charcoal-800 truncate group-hover:text-rust-600 transition-colors">
                                {title}
                              </span>
                              {c.endedAt && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-charcoal-100 text-charcoal-500 flex-shrink-0">
                                  closed
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-[11px] text-charcoal-400 mt-0.5">
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
