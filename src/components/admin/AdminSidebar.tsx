'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronRight, LogOut, Settings } from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';
import SlidingSidebar from '@/components/layout/SlidingSidebar';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/hooks/useAuth';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAdminTabs, useAdminTabState } from './adminTabs';

/**
 * 管理面板侧栏（桌面）—— 与 ChatSidebar 同一套 SlidingSidebar 滑动模式：
 * 进入 /admin 时主 Sidebar 滑出、本侧栏滑入，离开反向。
 * 由 dashboard layout 常驻挂载（保证离场动画）；内容原样搬自 admin/page.tsx
 * 的内嵌 aside，tab 状态经 URL `?tab=` 与页面共享（useAdminTabState）。
 *
 * 注意：本组件用了 useSearchParams（经 useAdminTabState），挂载处需包 <Suspense>。
 */
export default function AdminSidebar({ visible }: { visible: boolean }) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const setUserSettingsOpen = useSettingsStore((s) => s.setUserSettingsOpen);
  const tabs = useAdminTabs();
  const [activeTab, setActiveTab] = useAdminTabState();

  const isAdminUser = user?.role === 'ADMIN';

  return (
    <SlidingSidebar visible={visible && isAdminUser}>
      {!isAdminUser ? null : (
        <>
          {/* 品牌 + 返回 */}
          <div className="flex items-center justify-between px-3 h-16 border-b border-cream-200 dark:border-charcoal-700 flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <SiteLogo size="w-8 h-8" iconSize="w-4 h-4" />
              <div>
                <h1 className="font-serif font-bold text-charcoal-800 dark:text-cream-100 text-sm leading-tight">
                  {t('admin.title')}
                </h1>
                <p className="text-[10px] text-charcoal-400 tracking-wider uppercase">
                  {t('nav.appName')}
                </p>
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
          <nav className="flex-1 min-h-0 overflow-y-auto py-4 px-2 space-y-0.5">
            {tabs.map((tab, idx) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{ animationDelay: `${idx * 30}ms` }}
                  className={`
                    group relative w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium
                    transition-all duration-200 ease-out animate-fade-in-up
                    ${isActive
                      ? 'bg-rust-50 dark:bg-rust-900/30 text-rust-600 dark:text-rust-400 border border-rust-200 dark:border-rust-800 shadow-sm scale-[1.01]'
                      : 'text-charcoal-500 dark:text-charcoal-400 hover:bg-cream-100 dark:hover:bg-charcoal-700 hover:text-charcoal-700 dark:hover:text-cream-200 hover:translate-x-0.5 border border-transparent'
                    }
                  `}
                >
                  <Icon
                    className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${isActive ? 'scale-110' : 'group-hover:scale-110'}`}
                  />
                  <span>{tab.label}</span>
                  <ChevronRight
                    className={`w-3.5 h-3.5 ml-auto transition-all duration-200 ${
                      isActive
                        ? 'opacity-100 translate-x-0'
                        : 'opacity-0 -translate-x-1 group-hover:opacity-50 group-hover:translate-x-0'
                    }`}
                  />
                </button>
              );
            })}
          </nav>

          {/* 底部用户信息 + 设置 / 退出 */}
          <div className="p-3 border-t border-cream-200 dark:border-charcoal-700 space-y-2 flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rust-400 to-rust-600 flex items-center justify-center flex-shrink-0">
                <span className="text-white text-xs font-bold">
                  {user.displayName
                    .split(' ')
                    .map((w) => w[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-charcoal-800 dark:text-cream-100 truncate">
                  {user.displayName}
                </div>
                <div className="text-[10px] text-charcoal-400 truncate">
                  {user.email}
                </div>
              </div>
              <button
                onClick={() => setUserSettingsOpen(true)}
                className="w-7 h-7 rounded-md flex items-center justify-center
                           text-charcoal-400 hover:bg-cream-100 dark:hover:bg-charcoal-700 hover:text-charcoal-600 transition-colors"
                title={t('nav.settings')}
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={async () => {
                  await logout();
                  router.replace('/login');
                }}
                className="w-7 h-7 rounded-md flex items-center justify-center
                           text-charcoal-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                title={t('auth.signOut')}
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </>
      )}
    </SlidingSidebar>
  );
}
