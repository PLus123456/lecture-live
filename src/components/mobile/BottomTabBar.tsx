'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Languages, MessageSquare, Plus, Share2, User } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

interface BottomTabBarProps {
  onProfileTap: () => void;
}

function isActivePath(pathname: string, href: string) {
  if (href === '/home') {
    return pathname === '/home';
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function BottomTabBar({ onProfileTap }: BottomTabBarProps) {
  const pathname = usePathname();
  const { t } = useI18n();

  const tabClassName = (active: boolean) =>
    `flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
      active ? 'text-rust-500' : 'text-charcoal-400'
    }`;

  return (
    <nav className="bottom-tab-safe fixed inset-x-0 bottom-0 z-50 border-t border-cream-200 bg-white/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-screen-sm items-end px-2">
        <Link href="/home" className={tabClassName(isActivePath(pathname, '/home'))}>
          <Home className="h-5 w-5" />
          <span>{t('nav.home')}</span>
        </Link>
        <Link href="/interpret" className={tabClassName(isActivePath(pathname, '/interpret'))}>
          <Languages className="h-5 w-5" />
          <span>{t('nav.interpret')}</span>
        </Link>
        <Link
          href="/session/new"
          className="flex flex-1 items-end justify-center pb-1"
          aria-label={t('mobile.newSession')}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rust-500 text-white shadow-lg shadow-rust-500/25 transition-transform active:scale-95">
            <Plus className="h-5 w-5" />
          </span>
        </Link>
        <Link
          href="/chat"
          className={tabClassName(
            isActivePath(pathname, '/chat') || pathname === '/conversations'
          )}
        >
          <MessageSquare className="h-5 w-5" />
          <span>{t('nav.chat')}</span>
        </Link>
        <Link href="/shared" className={tabClassName(isActivePath(pathname, '/shared'))}>
          <Share2 className="h-5 w-5" />
          <span>{t('nav.shared')}</span>
        </Link>
        <button
          onClick={onProfileTap}
          className={tabClassName(false)}
          aria-label={t('mobile.openProfileMenu')}
        >
          <User className="h-5 w-5" />
          <span>{t('mobile.profile')}</span>
        </button>
      </div>
    </nav>
  );
}
