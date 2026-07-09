'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationListStore } from '@/stores/conversationListStore';
import GlobalChat from '@/components/chat/GlobalChat';
import ConfirmDialog from '@/components/ConfirmDialog';

/**
 * Client wrapper for /chat/[conversationId]。
 *
 * 渲染 <GlobalChat>（由它内部 messages 拉取负责归属检查：404/403 时经 onAccessDenied 跳回 /chat），
 * 并叠加一个右上角「删除对话」浮动按钮 → 二次确认 → DELETE /api/conversations/[id]
 * （后端连带清理附件文件 + 本地图片 + 释放配额）→ 清前端导航态 + 跳回 /chat。
 */
export default function ChatDetailClient({
  conversationId,
}: {
  conversationId: string;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const removeConversation = useChatStore((s) => s.removeConversation);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!token || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      removeConversation(conversationId);
      // 同步侧栏/首页共享列表
      useConversationListStore.getState().remove(conversationId);
      toast.success(t('chat.deleteSuccess'));
      router.replace('/chat');
    } catch (err) {
      setDeleting(false);
      toast.error(
        t('chat.deleteFailed'),
        err instanceof Error ? err.message : undefined
      );
    }
  }, [token, deleting, conversationId, removeConversation, router, t]);

  return (
    // 移动端把 fixed BottomTabBar 的高度（h-16 + 0.5rem + safe-inset）从可用高度里扣掉，
    // 否则 composer 的发送/模型行会被 z-50 的 TabBar 盖住。
    <div
      className="relative h-[100dvh] overflow-hidden
                 max-md:h-[calc(100dvh-4.5rem-env(safe-area-inset-bottom))]"
    >
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        aria-label={t('chat.delete')}
        title={t('chat.delete')}
        className="absolute top-2.5 right-3 z-20 w-8 h-8 rounded-lg flex items-center justify-center
                   text-charcoal-400 hover:text-red-500 hover:bg-red-50
                   bg-white/70 backdrop-blur transition-colors"
      >
        <Trash2 className="w-4 h-4" />
      </button>

      <GlobalChat
        conversationId={conversationId}
        onAccessDenied={() => {
          toast.error(t('chat.redirectMissing'));
          router.replace('/chat');
        }}
      />

      <ConfirmDialog
        open={confirmOpen}
        danger
        loading={deleting}
        title={t('chat.confirmDeleteTitle')}
        message={t('chat.confirmDeleteMessage')}
        confirmText={t('common.delete')}
        onConfirm={handleDelete}
        onCancel={() => {
          if (!deleting) setConfirmOpen(false);
        }}
      />
    </div>
  );
}
