'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useExitAnimation } from '@/hooks/useExitAnimation';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * 通用确认弹窗 — 用 Portal 挂到 document.body，
 * 这样不会被祖先元素的 transform 困在 containing block 内部。
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const [portalReady, setPortalReady] = useState(false);
  const { mounted, leaving } = useExitAnimation(open);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, onCancel]);

  if (!portalReady || !mounted) return null;

  const confirmBtnClass = danger
    ? 'bg-red-500 hover:bg-red-600 active:bg-red-700'
    : 'bg-rust-500 hover:bg-rust-600 active:bg-rust-700';

  return createPortal(
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm ${leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'}`}
      onClick={() => {
        if (!loading) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 rounded-2xl shadow-xl w-full max-w-sm overflow-hidden ${leaving ? 'animate-modal-leave' : 'animate-modal-enter'}`}
      >
        <div className="flex items-start gap-3 p-5">
          {danger && (
            <div className="w-10 h-10 rounded-full bg-rust-50 dark:bg-rust-900/30 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-rust-500" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">{title}</h3>
            {message && (
              <p className="text-sm text-charcoal-500 dark:text-charcoal-300 mt-1.5 leading-relaxed whitespace-pre-line">
                {message}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-cream-100 dark:border-charcoal-700 bg-cream-50/50 dark:bg-charcoal-800/50">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-3.5 py-1.5 text-sm text-charcoal-600 dark:text-cream-200 rounded-lg hover:bg-cream-100 dark:hover:bg-charcoal-700 transition-colors disabled:opacity-50"
          >
            {cancelText ?? t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-white rounded-lg transition-colors shadow-sm disabled:opacity-50 ${confirmBtnClass}`}
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {confirmText ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
