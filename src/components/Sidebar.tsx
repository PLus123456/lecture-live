'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Home,
  FolderOpen,
  Share2,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  LogOut,
  Settings,
  ChevronDown,
  User,
  Languages,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/hooks/useAuth';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
  const user = useAuthStore((s) => s.user);
  const quotas = useAuthStore((s) => s.quotas);
  const { logout } = useAuth();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const { t } = useI18n();

  const isAdmin = user?.role === 'ADMIN';

  // 导航项：Settings 替换为管理面板（仅 ADMIN）
  const navItems = [
    { href: '/home', label: t('nav.home'), icon: Home },
    { href: '/interpret', label: t('nav.interpret'), icon: Languages },
    { href: '/folders', label: t('nav.folders'), icon: FolderOpen },
    { href: '/shared', label: t('nav.shared'), icon: Share2 },
    ...(isAdmin
      ? [{ href: '/admin', label: t('nav.adminPanel'), icon: ShieldCheck }]
      : []),
  ];

  // 用户名首字母生成头像
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  // 角色显示
  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'ADMIN':
        return { text: t('roles.admin'), className: 'bg-rust-100 text-rust-600 border-rust-200' };
      case 'PRO':
        return { text: t('roles.pro'), className: 'bg-amber-50 text-amber-600 border-amber-200' };
      default:
        return { text: t('roles.free'), className: 'bg-cream-200 text-charcoal-500 border-cream-300' };
    }
  };

  // 配额进度
  const getQuotaPercent = () => {
    if (!quotas) return 0;
    if (quotas.transcriptionMinutesLimit <= 0) return 0;
    return Math.min(100, Math.round(
      (quotas.transcriptionMinutesUsed / quotas.transcriptionMinutesLimit) * 100
    ));
  };

  const getQuotaRemaining = () => {
    if (!quotas) return '';
    const remaining = Math.max(0, quotas.transcriptionMinutesLimit - quotas.transcriptionMinutesUsed);
    const h = Math.floor(remaining / 60);
    const m = remaining % 60;
    if (h > 0) return t('sidebar.hoursMinutesLeft', { hours: h, minutes: m });
    return t('sidebar.minutesLeft', { minutes: m });
  };

  const handleLogout = async () => {
    setAccountMenuOpen(false);
    await logout();
    router.replace('/login');
  };

  return (
    <aside
      className={`
        fixed left-0 top-0 h-full z-40
        bg-white border-r border-cream-200
        flex flex-col transition-all duration-300 ease-in-out
        ${sidebarCollapsed ? 'w-16' : 'w-56'}
      `}
    >
      {/* Logo + 折叠按钮 */}
      <div className="flex items-center justify-between px-3 h-16 border-b border-cream-200 flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 bg-gradient-to-br from-rust-500 to-rust-600 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm">
            <BookOpen className="w-4 h-4 text-white" />
          </div>
          {!sidebarCollapsed && (
            <div className="overflow-hidden">
              <h1 className="font-serif font-bold text-charcoal-800 text-sm leading-tight">
                {t('nav.appName')}
              </h1>
              <p className="text-[10px] text-charcoal-400 tracking-wider uppercase">
                {t('nav.appTagline')}
              </p>
            </div>
          )}
        </div>
        {/* 折叠按钮 — 合并到 Logo 行 */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="w-6 h-6 rounded-md flex items-center justify-center
                     text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600
                     transition-colors flex-shrink-0"
        >
          {sidebarCollapsed ? (
            <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronLeft className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {/* 导航项 */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                transition-all duration-150
                ${
                  isActive
                    ? 'bg-rust-50 text-rust-600 border border-rust-200 shadow-sm'
                    : 'text-charcoal-500 hover:bg-cream-100 hover:text-charcoal-700'
                }
                ${sidebarCollapsed ? 'justify-center' : ''}
              `}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <Icon className="w-[18px] h-[18px] flex-shrink-0" />
              {!sidebarCollapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* 底部用户信息区域 */}
      <div className="flex-shrink-0 border-t border-cream-200">
        {/* 配额进度条（展开时显示） */}
        {!sidebarCollapsed && quotas && (
          <div className="px-3 pt-3 pb-1">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-medium text-charcoal-400 tracking-wider uppercase">
                {t('settings.quota')}
              </span>
              <span className="text-[10px] text-charcoal-400">
                {getQuotaRemaining()}
              </span>
            </div>
            <div className="w-full h-1.5 bg-cream-200 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-rust-400 to-rust-500"
                style={{ width: `${getQuotaPercent()}%` }}
              />
            </div>
          </div>
        )}

        {/* 用户账户区域 */}
        <div className="p-2 relative">
          <button
            onClick={() => !sidebarCollapsed && setAccountMenuOpen(!accountMenuOpen)}
            className={`
              w-full flex items-center gap-2.5 px-2 py-2 rounded-lg
              hover:bg-cream-100 transition-colors
              ${sidebarCollapsed ? 'justify-center' : ''}
            `}
            title={sidebarCollapsed ? user?.displayName : undefined}
          >
            {/* 头像 */}
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rust-400 to-rust-600 flex items-center justify-center flex-shrink-0 shadow-sm">
              <span className="text-white text-xs font-bold">
                {user ? getInitials(user.displayName) : <User className="w-4 h-4" />}
              </span>
            </div>

            {!sidebarCollapsed && (
              <>
                <div className="flex-1 text-left min-w-0">
                  <div className="text-sm font-medium text-charcoal-800 truncate leading-tight">
                    {user?.displayName || t('sidebar.user')}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {user?.role && (
                      <span className={`inline-block text-[9px] px-1.5 py-0 rounded border font-medium ${getRoleBadge(user.role).className}`}>
                        {getRoleBadge(user.role).text}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-charcoal-400 transition-transform duration-200 flex-shrink-0 ${accountMenuOpen ? 'rotate-180' : ''}`} />
              </>
            )}
          </button>

          {/* 展开的下拉菜单 */}
          {accountMenuOpen && !sidebarCollapsed && (
            <div className="absolute bottom-full left-2 right-2 mb-1 bg-white rounded-lg border border-cream-200 shadow-lg overflow-hidden z-50">
              {/* 用户邮箱 */}
              <div className="px-3 py-2 border-b border-cream-100">
                <div className="text-[11px] text-charcoal-400 truncate">
                  {user?.email}
                </div>
              </div>

              {/* 设置 */}
              <button
                onClick={() => {
                  setAccountMenuOpen(false);
                  useSettingsStore.getState().setUserSettingsOpen(true);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-charcoal-600
                           hover:bg-cream-50 transition-colors"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>{t('nav.settings')}</span>
              </button>

              {/* 登出 */}
              <button
                onClick={() => {
                  void handleLogout();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-charcoal-600
                           hover:bg-red-50 hover:text-red-500 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{t('auth.signOut')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
