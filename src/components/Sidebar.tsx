'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Home,
  FolderOpen,
  Share2,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Settings,
  User,
  Languages,
} from 'lucide-react';
import Image from 'next/image';
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
    await logout();
    router.replace('/login');
  };

  return (
    <aside
      className={`
        fixed left-0 top-0 h-full z-40
        bg-white border-r border-cream-200
        flex flex-col transition-all duration-300 ease-in-out overflow-hidden
        ${sidebarCollapsed ? 'w-16' : 'w-56'}
      `}
    >
      {/* Logo */}
      <div className="flex items-center h-16 border-b border-cream-200 flex-shrink-0 px-3 overflow-hidden">
        <div className="flex items-center gap-2.5">
          <Image src="/icon.svg" alt="Logo" width={40} height={40} className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-lg flex-shrink-0" />
          <div className={`min-w-0 transition-opacity duration-300 ${sidebarCollapsed ? 'opacity-0' : 'opacity-100'}`}>
            <h1 className="font-serif font-bold text-charcoal-800 text-sm leading-tight whitespace-nowrap">
              {t('nav.appName')}
            </h1>
            <p className="text-[10px] text-charcoal-400 tracking-wider uppercase whitespace-nowrap">
              {t('nav.appTagline')}
            </p>
          </div>
        </div>
      </div>

      {/* 导航项 */}
      <nav className="flex-1 py-4 px-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center px-[10px] gap-3 h-10 rounded-lg text-sm font-medium
                transition-colors duration-150 overflow-hidden border
                ${
                  isActive
                    ? 'bg-rust-50 text-rust-600 border-rust-200 shadow-sm'
                    : 'text-charcoal-500 hover:bg-cream-100 hover:text-charcoal-700 border-transparent'
                }
              `}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <Icon className="w-[18px] h-[18px] flex-shrink-0" />
              <span className={`whitespace-nowrap transition-[opacity] duration-300 ${sidebarCollapsed ? 'opacity-0' : 'opacity-100'}`}>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* 底部用户信息区域 */}
      <div className="flex-shrink-0 border-t border-cream-200">
        {/* 配额进度条（展开时显示） */}
        {quotas && (
          <div className={`px-3 pt-3 pb-1 transition-all duration-300 overflow-hidden ${sidebarCollapsed ? 'max-h-0 opacity-0 py-0 pt-0 pb-0' : 'max-h-20 opacity-100'}`}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-medium text-charcoal-400 tracking-wider uppercase whitespace-nowrap">
                {t('settings.quota')}
              </span>
              <span className="text-[10px] text-charcoal-400 whitespace-nowrap">
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

        {/* 用户信息 */}
        <div className="pt-2 pb-1 px-2 overflow-hidden">
          <div className="flex items-center gap-2.5 py-2 px-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rust-400 to-rust-600 flex items-center justify-center flex-shrink-0 shadow-sm">
              <span className="text-white text-xs font-bold">
                {user ? getInitials(user.displayName) : <User className="w-4 h-4" />}
              </span>
            </div>
            <div className={`flex-1 text-left min-w-0 transition-opacity duration-300 ${sidebarCollapsed ? 'opacity-0' : 'opacity-100'}`}>
              <div className="text-sm font-medium text-charcoal-800 truncate leading-tight whitespace-nowrap">
                {user?.displayName || t('sidebar.user')}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                {user?.role && (
                  <span className={`inline-block text-[9px] px-1.5 py-0 rounded border font-medium whitespace-nowrap ${getRoleBadge(user.role).className}`}>
                    {getRoleBadge(user.role).text}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 折叠 | 设置 | 登出 — 纯图标 */}
        <div className="px-3 pb-1 pt-1 border-t border-cream-200 flex items-center justify-between overflow-hidden">
          {/* 折叠按钮 */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="h-10 flex-shrink-0 flex items-center px-[10px] border border-transparent rounded-lg
                       text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600 transition-colors"
            title={sidebarCollapsed ? t('nav.expand') : t('nav.collapse')}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-[18px] h-[18px]" />
            ) : (
              <ChevronLeft className="w-[18px] h-[18px]" />
            )}
          </button>
          {/* 设置 & 登出靠右，收起后隐藏 */}
          <div className={`flex items-center gap-1 transition-opacity duration-300 ${sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
            <button
              onClick={() => useSettingsStore.getState().setUserSettingsOpen(true)}
              className="w-9 h-9 rounded-lg flex items-center justify-center
                         text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600 transition-colors"
              title={t('nav.settings')}
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={() => void handleLogout()}
              className="w-9 h-9 rounded-lg flex items-center justify-center
                         text-charcoal-400 hover:bg-red-50 hover:text-red-500 transition-colors"
              title={t('auth.signOut')}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
