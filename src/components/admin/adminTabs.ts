'use client';

// 管理面板 tab 的单一定义源 —— AdminSidebar（桌面侧栏，挂在 dashboard layout）
// 与 admin/page.tsx（面板渲染 + 移动端 tab 条）共用，防止两处漂移。
// tab 状态由 URL `?tab=` 驱动（刷新后保留），读写都走 useAdminTabState。

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  LayoutDashboard,
  Settings,
  Users,
  UserCog,
  ScrollText,
  Scale,
  Layers,
  Share2,
  FolderOpen,
  Paperclip,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export type AdminTab =
  | 'dashboard'
  | 'settings'
  | 'groups'
  | 'users'
  | 'recharge'
  | 'files'
  | 'chatFiles'
  | 'shareLinks'
  | 'logs'
  | 'reconciliation'
  | 'jobs';

export const ADMIN_TABS: AdminTab[] = [
  'dashboard',
  'settings',
  'groups',
  'users',
  'recharge',
  'files',
  'chatFiles',
  'shareLinks',
  'logs',
  'reconciliation',
  'jobs',
];

export const isAdminTab = (v: string | null): v is AdminTab =>
  v !== null && (ADMIN_TABS as string[]).includes(v);

export interface AdminTabItem {
  id: AdminTab;
  label: string;
  icon: LucideIcon;
}

export function useAdminTabs(): AdminTabItem[] {
  const { t } = useI18n();
  return [
    { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
    { id: 'settings', label: t('nav.settings'), icon: Settings },
    { id: 'groups', label: t('nav.userGroups'), icon: UserCog },
    { id: 'users', label: t('nav.users'), icon: Users },
    { id: 'recharge', label: t('nav.recharge'), icon: Wallet },
    { id: 'files', label: t('nav.files'), icon: FolderOpen },
    { id: 'chatFiles', label: t('nav.chatFiles'), icon: Paperclip },
    { id: 'shareLinks', label: t('nav.shareLinks'), icon: Share2 },
    { id: 'logs', label: t('nav.logs'), icon: ScrollText },
    { id: 'reconciliation', label: t('nav.reconciliation'), icon: Scale },
    { id: 'jobs', label: t('nav.jobQueue'), icon: Layers },
  ];
}

/** 管理面板唯一路由。写死而非 usePathname()：AdminSidebar 常驻挂载在
 *  dashboard layout，跨路由导航的瞬间点击可能拿到过期的 pathname 闭包
 *  （曾复现出 replace 到 /home?tab=… 的竞态）；目标路径恒为 /admin，无需动态。 */
const ADMIN_PATH = '/admin';

/**
 * URL `?tab=` ↔ AdminTab 的读写对。写入时清掉 `subtab`（避免无效组合），
 * dashboard 是默认值不写进 URL。
 */
export function useAdminTabState(): [AdminTab, (next: AdminTab) => void] {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tabFromUrl = searchParams.get('tab');
  const activeTab: AdminTab = isAdminTab(tabFromUrl) ? tabFromUrl : 'dashboard';

  const setActiveTab = useCallback(
    (next: AdminTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'dashboard') {
        params.delete('tab');
      } else {
        params.set('tab', next);
      }
      // 切换主 tab 时清掉子 tab，避免无效组合
      params.delete('subtab');
      const qs = params.toString();
      router.replace(qs ? `${ADMIN_PATH}?${qs}` : ADMIN_PATH, {
        scroll: false,
      });
    },
    [router, searchParams]
  );

  return [activeTab, setActiveTab];
}
