'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useI18n } from '@/lib/i18n';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { useAdminTabs, useAdminTabState } from '@/components/admin/adminTabs';

import DashboardPanel from '@/components/admin/DashboardPanel';
import SettingsPanel from '@/components/admin/SettingsPanel';
import UserGroupsPanel from '@/components/admin/UserGroupsPanel';
import UserManagementPanel from '@/components/admin/UserManagementPanel';
import RechargePanel from '@/components/admin/RechargePanel';
import AuditLogPanel from '@/components/admin/AuditLogPanel';
import ReconciliationPanel from '@/components/admin/ReconciliationPanel';
import JobQueuePanel from '@/components/admin/JobQueuePanel';
import ShareLinksPanel from '@/components/admin/ShareLinksPanel';
import FilesPanel from '@/components/admin/FilesPanel';
import ChatFilesPanel from '@/components/admin/ChatFilesPanel';

export default function AdminPage() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const router = useRouter();

  // tab 定义与 URL `?tab=` 状态与 AdminSidebar（桌面侧栏，挂在 dashboard layout）
  // 共享同一来源 —— 见 src/components/admin/adminTabs.ts
  const tabs = useAdminTabs();
  const [activeTab, setActiveTab] = useAdminTabState();

  // ─── 左右滑动切换 tab（移动端） ───
  const touchRef = useRef<{ startX: number; startY: number; startTime: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  const switchTab = useCallback(
    (direction: 'prev' | 'next') => {
      const tabIds = tabs.map((t) => t.id);
      const idx = tabIds.indexOf(activeTab);
      if (direction === 'next' && idx < tabIds.length - 1) {
        setActiveTab(tabIds[idx + 1]);
      } else if (direction === 'prev' && idx > 0) {
        setActiveTab(tabIds[idx - 1]);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTab],
  );

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchRef.current = { startX: touch.clientX, startY: touch.clientY, startTime: Date.now() };
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchRef.current.startX;
      const dy = touch.clientY - touchRef.current.startY;
      const dt = Date.now() - touchRef.current.startTime;
      touchRef.current = null;

      // 只识别快速水平滑动：距离 > 60px，水平位移 > 垂直位移的 1.5 倍，时间 < 400ms
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 400) {
        // 检查是否在可横向滚动的容器中（表格等），如果是则不切换 tab
        const target = e.target as HTMLElement;
        const scrollableParent = target.closest('[class*="overflow-x"]');
        if (scrollableParent) {
          const el = scrollableParent as HTMLElement;
          if (el.scrollWidth > el.clientWidth) return;
        }

        if (dx < 0) {
          switchTab('next');
        } else {
          switchTab('prev');
        }
      }
    },
    [switchTab],
  );

  // 切换 tab 时自动滚动 tab 栏使当前 tab 可见
  useEffect(() => {
    if (!tabBarRef.current) return;
    const activeBtn = tabBarRef.current.querySelector('[data-active="true"]') as HTMLElement;
    if (activeBtn) {
      activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [activeTab]);

  // 非管理员用户重定向
  useEffect(() => {
    if (user && user.role !== 'ADMIN') {
      router.replace('/home');
    }
  }, [user, router]);

  if (!user || user.role !== 'ADMIN') {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-rust-400 mx-auto mb-3" />
          <p className="text-charcoal-600 font-medium">{t('auth.accessRestricted')}</p>
          <p className="text-sm text-charcoal-400 mt-1">{t('auth.adminRequired')}</p>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-cream-50 pb-28">
        <header className="sticky top-0 z-20 border-b border-cream-200 bg-white/95 px-4 py-4 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/home')}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-600"
              aria-label={t('nav.backToHome')}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <h1 className="font-serif text-lg font-bold text-charcoal-800">
                {t('admin.title')}
              </h1>
              <p className="text-xs text-charcoal-400">{user.displayName}</p>
            </div>
          </div>
          <div ref={tabBarRef} className="mobile-scroll mt-4 flex gap-2 overflow-x-auto pb-1">
            {tabs.map((tab, idx) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  data-active={active}
                  onClick={() => setActiveTab(tab.id)}
                  style={{ animationDelay: `${idx * 20}ms` }}
                  className={`inline-flex min-w-max items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium
                              transition-all duration-200 ease-out animate-fade-in-up active:scale-95 ${
                    active
                      ? 'border-rust-200 bg-rust-50 text-rust-700 shadow-sm scale-[1.02]'
                      : 'border-cream-200 bg-white text-charcoal-500 hover:border-cream-300 hover:bg-cream-50'
                  }`}
                >
                  <Icon className={`h-4 w-4 transition-transform duration-200 ${active ? 'scale-110' : ''}`} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </header>

        <div
          ref={contentRef}
          className="px-4 py-4"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div key={activeTab} className="animate-fade-in-up">
            {activeTab === 'dashboard' && <DashboardPanel />}
            {activeTab === 'settings' && <SettingsPanel />}
            {activeTab === 'groups' && <UserGroupsPanel />}
            {activeTab === 'users' && <UserManagementPanel />}
            {activeTab === 'recharge' && <RechargePanel />}
            {activeTab === 'files' && <FilesPanel />}
            {activeTab === 'chatFiles' && <ChatFilesPanel />}
            {activeTab === 'shareLinks' && <ShareLinksPanel />}
            {activeTab === 'logs' && <AuditLogPanel />}
            {activeTab === 'reconciliation' && <ReconciliationPanel />}
            {activeTab === 'jobs' && <JobQueuePanel />}
          </div>
        </div>
      </div>
    );
  }

  // 桌面：左侧导航由 dashboard layout 的 <AdminSidebar>（SlidingSidebar 滑动模式，
  // 与对话区同一套进出动画）接管，这里只渲染内容区（layout 已留 ml-56）。
  return (
    <div className="h-screen overflow-y-auto p-8 bg-cream-50 dark:bg-charcoal-900">
      <div key={activeTab} className="animate-fade-in-up">
        {activeTab === 'dashboard' && <DashboardPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
        {activeTab === 'groups' && <UserGroupsPanel />}
        {activeTab === 'users' && <UserManagementPanel />}
        {activeTab === 'recharge' && <RechargePanel />}
        {activeTab === 'files' && <FilesPanel />}
        {activeTab === 'chatFiles' && <ChatFilesPanel />}
        {activeTab === 'shareLinks' && <ShareLinksPanel />}
        {activeTab === 'logs' && <AuditLogPanel />}
        {activeTab === 'reconciliation' && <ReconciliationPanel />}
        {activeTab === 'jobs' && <JobQueuePanel />}
      </div>
    </div>
  );
}
