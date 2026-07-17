'use client';

import { Suspense, useState } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import ChatSidebar from '@/components/chat/ChatSidebar';
import AdminSidebar from '@/components/admin/AdminSidebar';
import AuthGuard from '@/components/layout/AuthGuard';
import UserSettingsModal from '@/components/UserSettingsModal';
import RechargeModal, { RechargeReturnHandler } from '@/components/RechargeModal';
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
  // 任一区域侧栏接管左栏（SlidingSidebar 模式，见该组件注释）
  const sectionSidebarActive = inChatArea || isAdmin;

  return (
    <AuthGuard>
      <div className="min-h-[100dvh] bg-cream-50 dark:bg-charcoal-900">
        {/* 所有侧栏常驻挂载，靠 translate 互斥滑动（卸载就没有离场动画了） */}
        {!isMobile && <Sidebar slideOut={sectionSidebarActive} />}
        {!isMobile && <ChatSidebar visible={inChatArea} />}
        {/* AdminSidebar 内部经 useSearchParams 读 ?tab=，需要 Suspense 边界 */}
        {!isMobile && (
          <Suspense fallback={null}>
            <AdminSidebar visible={isAdmin} />
          </Suspense>
        )}
        {isMobile && <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
        <UserSettingsModal />
        <RechargeModal />
        <Suspense fallback={null}>
          <RechargeReturnHandler />
        </Suspense>
        <main
          className={`transition-all duration-300 ${
            isMobile
              ? 'pb-24'
              : sectionSidebarActive
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
