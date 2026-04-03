'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
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

  return (
    <AuthGuard>
      <div className="min-h-[100dvh] bg-cream-50 dark:bg-charcoal-900">
        {!isMobile && !isAdmin && <Sidebar />}
        {isMobile && <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
        <UserSettingsModal />
        <main
          className={`transition-all duration-300 ${
            isMobile
              ? 'pb-24'
              : isAdmin
                ? 'ml-0'
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
