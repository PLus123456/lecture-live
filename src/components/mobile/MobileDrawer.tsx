'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  LogOut,
  Settings,
  ShieldCheck,
  User,
  X,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
}

function getInitials(name?: string | null) {
  if (!name) {
    return 'U';
  }

  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function getQuotaPercent(limit?: number, used?: number) {
  if (!limit || limit <= 0 || used == null) {
    return 0;
  }

  return Math.min(100, Math.round((used / limit) * 100));
}

export default function MobileDrawer({ open, onClose }: MobileDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { logout } = useAuth();
  const user = useAuthStore((state) => state.user);
  const quotas = useAuthStore((state) => state.quotas);
  const setUserSettingsOpen = useSettingsStore((state) => state.setUserSettingsOpen);

  useSwipeGesture(drawerRef, {
    onSwipeRight: onClose,
    threshold: 48,
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const isAdmin = user?.role === 'ADMIN';
  const quotaPercent = getQuotaPercent(
    quotas?.transcriptionMinutesLimit,
    quotas?.transcriptionMinutesUsed
  );
  const quotaLabel = useMemo(() => {
    if (!quotas) {
      return 'No quota data';
    }

    const remaining = Math.max(
      0,
      quotas.transcriptionMinutesLimit - quotas.transcriptionMinutesUsed
    );
    const hours = Math.floor(remaining / 60);
    const minutes = remaining % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m remaining`;
    }

    return `${minutes}m remaining`;
  }, [quotas]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[60]">
      <button
        aria-label="Close profile drawer"
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-backdrop-enter"
        onClick={onClose}
      />
      <div
        ref={drawerRef}
        className="safe-top absolute bottom-0 left-0 top-0 flex w-[280px] max-w-[82vw] flex-col border-r border-cream-200 bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-cream-200 px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-rust-400 to-rust-600 text-sm font-bold text-white shadow-sm">
              {getInitials(user?.displayName)}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-charcoal-800">
                {user?.displayName || 'Guest'}
              </div>
              <div className="truncate text-xs text-charcoal-400">
                {user?.email || 'Not signed in'}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-charcoal-400 transition-colors hover:bg-cream-100 hover:text-charcoal-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <section className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-charcoal-400">
              <User className="h-3.5 w-3.5" />
              Usage
            </div>
            <div className="mb-2 flex items-center justify-between text-sm font-medium text-charcoal-700">
              <span>Transcription quota</span>
              <span>{quotaPercent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-cream-200">
              <div
                className="h-full rounded-full bg-gradient-to-r from-rust-400 to-rust-500 transition-all duration-300"
                style={{ width: `${quotaPercent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-charcoal-400">{quotaLabel}</p>
          </section>

          <div className="mt-5 space-y-2">
            <button
              onClick={() => {
                onClose();
                setUserSettingsOpen(true);
              }}
              className="flex w-full items-center gap-3 rounded-2xl border border-cream-200 bg-white px-4 py-3 text-left text-sm font-medium text-charcoal-700 transition-colors hover:bg-cream-50"
            >
              <Settings className="h-4 w-4 text-rust-500" />
              Account settings
            </button>

            {isAdmin ? (
              <Link
                href="/admin"
                onClick={onClose}
                className="flex items-center gap-3 rounded-2xl border border-cream-200 bg-white px-4 py-3 text-sm font-medium text-charcoal-700 transition-colors hover:bg-cream-50"
              >
                <ShieldCheck className="h-4 w-4 text-rust-500" />
                Admin panel
              </Link>
            ) : null}
          </div>
        </div>

        <div className="border-t border-cream-200 px-5 py-4 safe-bottom">
          <button
            onClick={async () => {
              onClose();
              await logout();
              router.replace('/login');
            }}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
