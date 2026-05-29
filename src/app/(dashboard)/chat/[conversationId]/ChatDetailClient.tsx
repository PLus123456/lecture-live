'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import GlobalChat from '@/components/chat/GlobalChat';

/**
 * Client wrapper for /chat/[conversationId]。
 *
 * 直接渲染 <GlobalChat>，由它内部的 messages 拉取负责归属检查：
 * 返回 404/403（不存在/无权）时通过 onAccessDenied 回调跳回 /chat。
 *
 * 此前这里额外做了一次 GET .../messages 预检，与 GlobalChat 内部拉取重复，
 * 导致每次进入对话都发两次相同请求 —— 现已合并为一次（由 GlobalChat 触发回调）。
 */
export default function ChatDetailClient({
  conversationId,
}: {
  conversationId: string;
}) {
  const router = useRouter();
  const { t } = useI18n();

  return (
    <div className="h-[100dvh] overflow-hidden">
      <GlobalChat
        conversationId={conversationId}
        onAccessDenied={() => {
          toast.error(t('chat.redirectMissing'));
          router.replace('/chat');
        }}
      />
    </div>
  );
}
