'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useI18n } from '@/lib/i18n';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  Settings,
  Users,
  UserCog,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  ScrollText,
  Scale,
} from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';

import DashboardPanel from '@/components/admin/DashboardPanel';
import SettingsPanel from '@/components/admin/SettingsPanel';
import UserGroupsPanel from '@/components/admin/UserGroupsPanel';
import UserManagementPanel from '@/components/admin/UserManagementPanel';
import AuditLogPanel from '@/components/admin/AuditLogPanel';
import ReconciliationPanel from '@/components/admin/ReconciliationPanel';

type AdminTab = 'dashboard' | 'settings' | 'groups' | 'users' | 'logs' | 'reconciliation';

export default function AdminPage() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const router = useRouter();

  const tabs: { id: AdminTab; label: string; icon: typeof Users }[] = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
    { id: 'settings', label: t('nav.settings'), icon: Settings },
    { id: 'groups', label: t('nav.userGroups'), icon: UserCog },
    { id: 'users', label: t('nav.users'), icon: Users },
    { id: 'logs', label: t('nav.logs'), icon: ScrollText },
    { id: 'reconciliation', label: t('nav.reconciliation'), icon: Scale },
  ];
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');

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
      <div className="min-h-screen bg-cream-50 pb-28">
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
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  data-active={active}
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex min-w-max items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'border-rust-200 bg-rust-50 text-rust-700'
                      : 'border-cream-200 bg-white text-charcoal-500'
                  }`}
                >
                  <Icon className="h-4 w-4" />
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
          {activeTab === 'dashboard' && <DashboardPanel />}
          {activeTab === 'settings' && <SettingsPanel />}
          {activeTab === 'groups' && <UserGroupsPanel />}
          {activeTab === 'users' && <UserManagementPanel />}
          {activeTab === 'logs' && <AuditLogPanel />}
          {activeTab === 'reconciliation' && <ReconciliationPanel />}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden">
      {/* 管理面板左侧导航 */}
      <aside className="w-56 bg-white dark:bg-charcoal-800 border-r border-cream-200 dark:border-charcoal-700 flex flex-col flex-shrink-0">
        {/* 品牌 + 返回 */}
        <div className="flex items-center justify-between px-3 h-16 border-b border-cream-200 dark:border-charcoal-700">
          <div className="flex items-center gap-2.5">
            <SiteLogo size="w-8 h-8" iconSize="w-4 h-4" />
            <div>
              <h1 className="font-serif font-bold text-charcoal-800 dark:text-cream-100 text-sm leading-tight">{t('admin.title')}</h1>
              <p className="text-[10px] text-charcoal-400 tracking-wider uppercase">{t('nav.appName')}</p>
            </div>
          </div>
          <Link
            href="/home"
            className="w-7 h-7 rounded-md flex items-center justify-center
                       text-charcoal-400 hover:bg-cream-100 dark:hover:bg-charcoal-700 hover:text-charcoal-600 transition-colors"
            title={t('nav.backToHome')}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
        </div>

        {/* 导航项 */}
        <nav className="flex-1 py-4 px-2 space-y-0.5">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium
                  transition-all duration-150
                  ${isActive
                    ? 'bg-rust-50 dark:bg-rust-900/30 text-rust-600 dark:text-rust-400 border border-rust-200 dark:border-rust-800 shadow-sm'
                    : 'text-charcoal-500 dark:text-charcoal-400 hover:bg-cream-100 dark:hover:bg-charcoal-700 hover:text-charcoal-700 dark:hover:text-cream-200'
                  }
                `}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span>{tab.label}</span>
                {isActive && <ChevronRight className="w-3.5 h-3.5 ml-auto" />}
              </button>
            );
          })}
        </nav>

        {/* 底部用户信息 */}
        <div className="p-3 border-t border-cream-200 dark:border-charcoal-700">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rust-400 to-rust-600 flex items-center justify-center flex-shrink-0">
              <span className="text-white text-xs font-bold">
                {user.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
              </span>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-charcoal-800 dark:text-cream-100 truncate">{user.displayName}</div>
              <div className="text-[10px] text-charcoal-400 truncate">{user.email}</div>
            </div>
          </div>
        </div>
      </aside>

      {/* 右侧内容 */}
      <div className="flex-1 overflow-y-auto p-8 bg-cream-50 dark:bg-charcoal-900">
        {activeTab === 'dashboard' && <DashboardPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
        {activeTab === 'groups' && <UserGroupsPanel />}
        {activeTab === 'users' && <UserManagementPanel />}
        {activeTab === 'logs' && <AuditLogPanel />}
        {activeTab === 'reconciliation' && <ReconciliationPanel />}
      </div>
    </div>
  );
}
