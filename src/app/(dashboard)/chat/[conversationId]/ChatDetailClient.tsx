'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import GlobalChat from '@/components/chat/GlobalChat';

/**
 * Client wrapper：
 *   1. 调用 GET /api/conversations/[id]/messages 做归属检查
 *   2. 404/403 → toast + replace('/chat')
 *   3. 其他状态 → 渲染 <GlobalChat conversationId={id} />（即使端点没准备好，
 *      GlobalChat 内部还会自行拉一次并对失败做空态兜底）
 *
 * 不在这里展示 messages 内容 —— 那是 GlobalChat 的职责。
 * 这里只做一次「能访问吗？」预检，提早把无权访问的用户挡掉，
 * 让 GlobalChat 内部 API 调用不必处理重定向逻辑。
 */
export default function ChatDetailClient({
  conversationId,
}: {
  conversationId: string;
}) {
  const router = useRouter();
  const { token } = useAuth();
  const { t } = useI18n();
  const [status, setStatus] = useState<'checking' | 'ok' | 'redirecting'>(
    'checking'
  );

  useEffect(() => {
    if (!token) return; // AuthGuard 会接管未登录情况
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (cancelled) return;

        if (res.status === 404 || res.status === 403) {
          toast.error(t('chat.redirectMissing'));
          setStatus('redirecting');
          router.replace('/chat');
          return;
        }
        // 5xx / 网络错误：仍然渲染 GlobalChat，让用户看到空对话界面
        // 而不是直接 bounce 回 /chat —— 服务端瞬时错误不应当让用户失去当前会话。
        setStatus('ok');
      } catch {
        if (cancelled) return;
        // 网络异常 — 仍允许进入；GlobalChat 内部会显示空状态
        setStatus('ok');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, token, router, t]);

  if (status !== 'ok') {
    return (
      <div className="flex flex-col h-[100dvh] items-center justify-center text-charcoal-400">
        <Loader2 className="w-6 h-6 animate-spin mb-2" />
        <span className="text-xs">{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] overflow-hidden">
      <GlobalChat conversationId={conversationId} />
    </div>
  );
}
