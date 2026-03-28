'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Languages, Plus, Share2, User } from 'lucide-react';

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

  const tabClassName = (active: boolean) =>
    `flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
      active ? 'text-rust-500' : 'text-charcoal-400'
    }`;

  return (
    <nav className="bottom-tab-safe fixed inset-x-0 bottom-0 z-50 border-t border-cream-200 bg-white/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-screen-sm items-end px-2">
        <Link href="/home" className={tabClassName(isActivePath(pathname, '/home'))}>
          <Home className="h-5 w-5" />
          <span>Home</span>
        </Link>
        <Link href="/interpret" className={tabClassName(isActivePath(pathname, '/interpret'))}>
          <Languages className="h-5 w-5" />
          <span>Interpret</span>
        </Link>
        <Link
          href="/session/new"
          className="flex flex-1 items-end justify-center pb-1"
          aria-label="New session"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rust-500 text-white shadow-lg shadow-rust-500/25 transition-transform active:scale-95">
            <Plus className="h-5 w-5" />
          </span>
        </Link>
        <Link href="/shared" className={tabClassName(isActivePath(pathname, '/shared'))}>
          <Share2 className="h-5 w-5" />
          <span>Shared</span>
        </Link>
        <button
          onClick={onProfileTap}
          className={tabClassName(false)}
          aria-label="Open profile menu"
        >
          <User className="h-5 w-5" />
          <span>Profile</span>
        </button>
      </div>
    </nav>
  );
}
