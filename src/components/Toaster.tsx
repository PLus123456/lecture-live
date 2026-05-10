'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { useToastStore, type Toast } from '@/stores/toastStore';

const ICON_BY_TYPE = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
} as const;

const STYLE_BY_TYPE = {
  success: {
    iconBg: 'bg-emerald-50 dark:bg-emerald-900/30',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    accent: 'before:bg-emerald-500',
  },
  error: {
    iconBg: 'bg-rose-50 dark:bg-rose-900/30',
    iconColor: 'text-rose-600 dark:text-rose-400',
    accent: 'before:bg-rose-500',
  },
  info: {
    iconBg: 'bg-sky-50 dark:bg-sky-900/30',
    iconColor: 'text-sky-600 dark:text-sky-400',
    accent: 'before:bg-sky-500',
  },
} as const;

function ToastItem({ toast }: { toast: Toast }) {
  const Icon = ICON_BY_TYPE[toast.type];
  const style = STYLE_BY_TYPE[toast.type];
  const dismiss = useToastStore((s) => s.dismiss);
  const [leaving, setLeaving] = useState(false);

  const handleClose = () => {
    setLeaving(true);
    setTimeout(() => dismiss(toast.id), 180);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={`
        relative w-[320px] sm:w-[360px] flex items-start gap-3
        rounded-xl border border-cream-200 dark:border-charcoal-700
        bg-white/95 dark:bg-charcoal-800/95 backdrop-blur-md
        shadow-lg shadow-charcoal-900/5
        pl-4 pr-3 py-3
        before:absolute before:left-0 before:top-3 before:bottom-3 before:w-0.5 before:rounded-r ${style.accent}
        ${leaving ? 'animate-toast-out' : 'animate-toast-in'}
      `}
    >
      <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${style.iconBg}`}>
        <Icon className={`w-4 h-4 ${style.iconColor}`} />
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="text-sm font-medium text-charcoal-800 dark:text-cream-100 break-words">
          {toast.message}
        </div>
        {toast.description && (
          <div className="mt-0.5 text-xs text-charcoal-500 dark:text-charcoal-400 break-words">
            {toast.description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleClose}
        aria-label="Close"
        className="flex-shrink-0 -mr-1 -mt-0.5 w-7 h-7 rounded-md flex items-center justify-center text-charcoal-300 hover:text-charcoal-600 hover:bg-cream-100 dark:hover:bg-charcoal-700 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export default function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  // SSR-safe mount guard — fixed/portal-style overlays should only render client-side
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed z-[1000] pointer-events-none
                 bottom-4 right-4 sm:bottom-6 sm:right-6
                 flex flex-col gap-2 items-end"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
