'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import ChatSidebar from '@/components/chat/ChatSidebar';
import AuthGuard from '@/components/layout/AuthGuard';
import UserSettingsModal from '@/components/UserSettingsModal';
import BottomTabBar from '@/components/mobile/BottomTabBar';
import MobileDrawer from '@/components/mobile/MobileDrawer';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSettingsStore } from '@/stores/settingsStore';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isAdmin = pathname.startsWith('/admin');
  // 对话区（/chat、/chat/[id]、/conversations）：主侧栏滑出，ChatSidebar 滑入
  const inChatArea =
    pathname === '/chat' ||
    pathname.startsWith('/chat/') ||
    pathname === '/conversations';

  return (
    <AuthGuard>
      <div className="min-h-[100dvh] bg-cream-50 dark:bg-charcoal-900">
        {/* 两个侧栏常驻挂载，靠 translate 互斥滑动（卸载就没有离场动画了） */}
        {!isMobile && !isAdmin && <Sidebar slideOut={inChatArea} />}
        {!isMobile && !isAdmin && <ChatSidebar visible={inChatArea} />}
        {isMobile && <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
        <UserSettingsModal />
        <main
          className={`transition-all duration-300 ${
            isMobile
              ? 'pb-24'
              : isAdmin
                ? 'ml-0'
                : inChatArea
                  ? 'ml-56'
                  : sidebarCollapsed
                    ? 'ml-16'
                    : 'ml-56'
          }`}
        >
          {children}
        </main>
        {isMobile ? <BottomTabBar onProfileTap={() => setDrawerOpen(true)} /> : null}
      </div>
    </AuthGuard>
  );
}
