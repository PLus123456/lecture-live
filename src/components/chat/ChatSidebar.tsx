'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ArrowLeft, Plus, History, MessageSquare, Mic } from 'lucide-react';
import SlidingSidebar from '@/components/layout/SlidingSidebar';
import ComposerModelControls from '@/components/chat/ComposerModelControls';
import { useI18n } from '@/lib/i18n';
import { useAuthStore } from '@/stores/authStore';
import { useConversationListStore } from '@/stores/conversationListStore';

/**
 * 对话区专属侧栏（Claude 式）：返回主应用 + 新建对话 + 会话列表 + 全部对话入口。
 *
 * 滑动进出走通用 SlidingSidebar 模式（与 AdminSidebar 一致）：由 dashboard
 * layout 常驻挂载并与主 Sidebar 互斥滑动，进入 /chat 区域时滑入、离开反向。
 */
export default function ChatSidebar({ visible }: { visible: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const items = useConversationListStore((s) => s.items);
  const error = useConversationListStore((s) => s.error);
  const refresh = useConversationListStore((s) => s.refresh);

  // 进入对话区 / 区内路由变化时刷新列表。新建、删除、自动标题都伴随路由变化，
  // 天然触发这里；纯本地写操作（重命名等）由各页面直接改 store。
  useEffect(() => {
    if (!visible || !token) return;
    void refresh(token);
  }, [visible, token, pathname, refresh]);

  return (
    <SlidingSidebar visible={visible}>
      {/* 顶部：返回主应用 + 标题（与主侧栏 Logo 行同高） */}
      <div className="flex items-center gap-1.5 h-16 border-b border-cream-200 flex-shrink-0 px-3">
        <button
          type="button"
          onClick={() => router.push('/home')}
          title={t('common.back')}
          aria-label={t('common.back')}
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0
                     text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600 transition-colors"
        >
          <ArrowLeft className="w-[18px] h-[18px]" />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="w-4 h-4 text-rust-500 flex-shrink-0" />
          <span className="font-serif font-bold text-charcoal-800 text-sm whitespace-nowrap truncate">
            {t('chat.title')}
          </span>
        </div>
      </div>

      {/* 新建对话 → 回到 /chat 首页的空 composer（对话在发送首条消息时才真正创建） */}
      <div className="px-3 pt-3 pb-2 flex-shrink-0">
        <button
          type="button"
          onClick={() => router.push('/chat')}
          className="w-full flex items-center justify-center gap-2 h-10 rounded-lg text-sm font-medium
                     bg-gradient-to-r from-rust-500 to-rust-600 text-white
                     hover:from-rust-600 hover:to-rust-700 active:scale-[0.98]
                     shadow-sm shadow-rust-500/20 transition-all duration-150"
        >
          <Plus className="w-4 h-4" />
          {t('chat.newConversation')}
        </button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-1 pb-2">
        {items === null ? (
          error ? (
            <p className="px-[10px] pt-2 text-xs text-charcoal-300">
              {t('chat.loadFailed')}
            </p>
          ) : (
            <div className="space-y-1.5 animate-pulse pt-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-7 rounded-md bg-cream-100" />
              ))}
            </div>
          )
        ) : items.length === 0 ? (
          <p className="px-[10px] pt-2 text-xs text-charcoal-300">
            {t('sidebar.noRecentChats')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {items.map((c) => {
              const href = `/chat/${c.id}`;
              const isActive = pathname === href;
              const label =
                c.title && c.title.trim().length > 0
                  ? c.title
                  : t('chat.unnamed');
              return (
                <li key={c.id}>
                  <Link
                    href={href}
                    title={label}
                    className={`
                      flex items-center gap-1.5 h-8 px-[10px] rounded-md text-xs
                      transition-colors duration-100 overflow-hidden
                      ${
                        isActive
                          ? 'bg-rust-50 text-rust-600 font-medium'
                          : 'text-charcoal-500 hover:bg-cream-50 hover:text-charcoal-700'
                      }
                    `}
                  >
                    {c.sessionBound && (
                      <Mic className="w-3 h-3 flex-shrink-0 text-rust-400" />
                    )}
                    <span className="truncate whitespace-nowrap">{label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 底部：模型选择器（桌面端从 composer 移到此处）+ 全部对话入口 */}
      <div className="flex-shrink-0 border-t border-cream-200 p-3 space-y-2">
        {/* 仅在对话区可见时渲染 —— ChatSidebar 在所有 dashboard 页常驻挂载（滑动动画需要），
            但模型选择器只属于对话区：避免在 /admin、/home 等页面白白拉取 /api/llm/models，
            也避免那些页面渲染这个离屏控件（曾因此在 /api/llm/models 未 mock 时整页崩溃）。 */}
        {visible && (
          <div className="px-[10px] py-2 rounded-lg border border-cream-200 bg-cream-50/60">
            <div className="text-[10px] font-medium text-charcoal-400 tracking-wider uppercase mb-1">
              {t('chat.model')}
            </div>
            <ComposerModelControls layout="block" />
          </div>
        )}
        <Link
          href="/conversations"
          className={`
            flex items-center gap-3 h-10 px-[10px] rounded-lg text-sm font-medium
            transition-colors duration-150 border
            ${
              pathname === '/conversations'
                ? 'bg-rust-50 text-rust-600 border-rust-200 shadow-sm'
                : 'text-charcoal-500 hover:bg-cream-100 hover:text-charcoal-700 border-transparent'
            }
          `}
        >
          <History className="w-[18px] h-[18px] flex-shrink-0" />
          <span className="whitespace-nowrap">{t('chat.viewAll')}</span>
        </Link>
      </div>
    </SlidingSidebar>
  );
}
