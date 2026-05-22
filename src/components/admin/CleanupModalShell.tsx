'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import ModalPortal from '@/components/ModalPortal';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';

export interface CleanupModalShellProps {
  title: string;
  warning: string;
  /** DELETE / preview 都基于这个 endpoint。 */
  endpoint: string;
  token: string | null;
  /** 子组件构造的 query 参数 — 同时被 preview 和 DELETE 复用。 */
  buildParams: () => URLSearchParams;
  /** 表单字段的稳定指纹 — 任何变化都清空 preview count，避免显示过期数字。 */
  formSignature: string;
  canSubmit: boolean;
  confirmDialogTitle: string;
  confirmDialogMessage: string;
  successTitle: (deletedCount: number) => string;
  failureTitle: string;
  previewErrorTitle: string;
  children: ReactNode;
  onClose: () => void;
  onCleaned: () => void;
}

/**
 * Admin 清理对话框的通用外壳：标题栏、警告条、表单插槽、Preview + Confirm 按钮、
 * 二次确认对话框、统一的 toast / fetch 调用。各面板只需描述字段和参数构造。
 */
export default function CleanupModalShell({
  title,
  warning,
  endpoint,
  token,
  buildParams,
  formSignature,
  canSubmit,
  confirmDialogTitle,
  confirmDialogMessage,
  successTitle,
  failureTitle,
  previewErrorTitle,
  children,
  onClose,
  onCleaned,
}: CleanupModalShellProps) {
  const { t } = useI18n();
  const [previewing, setPreviewing] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // 表单改了就把过期的 preview 清掉。
  useEffect(() => {
    setPreviewCount(null);
  }, [formSignature]);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const handlePreview = async () => {
    if (!canSubmit) return;
    setPreviewing(true);
    setPreviewCount(null);
    try {
      const params = buildParams();
      params.set('cleanup_preview', '1');
      const res = await fetch(`${endpoint}?${params}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setPreviewCount(Number(data.count) || 0);
      } else {
        const data = await res.json().catch(() => null);
        toast.error(previewErrorTitle, data?.error);
      }
    } catch {
      toast.error(previewErrorTitle, t('common.networkError'));
    } finally {
      setPreviewing(false);
    }
  };

  const handleCleanup = async () => {
    if (!canSubmit) return;
    setCleaning(true);
    try {
      const res = await fetch(`${endpoint}?${buildParams()}`, {
        method: 'DELETE',
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(successTitle(data.deletedCount ?? 0));
        onCleaned();
        onClose();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(failureTitle, data?.error);
      }
    } catch {
      toast.error(failureTitle, t('common.networkError'));
    } finally {
      setCleaning(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <ModalPortal>
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-backdrop-enter px-4"
          onClick={() => {
            if (!cleaning) onClose();
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-charcoal-800 rounded-2xl border border-cream-200 dark:border-charcoal-700
                       shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto animate-modal-enter"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 dark:border-charcoal-700">
              <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">{title}</h3>
              <button
                onClick={onClose}
                disabled={cleaning}
                className="w-7 h-7 rounded-md flex items-center justify-center
                           text-charcoal-400 hover:bg-cream-100 dark:hover:bg-charcoal-700
                           transition-colors disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              <div className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/50">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">{warning}</p>
              </div>

              {children}

              {previewCount !== null && (
                <div className="px-3.5 py-2.5 rounded-lg bg-cream-50 dark:bg-charcoal-700/50 border border-cream-200 dark:border-charcoal-600">
                  <p className="text-sm text-charcoal-700 dark:text-cream-200">
                    {t('admin.cleanup.willDelete', { n: previewCount })}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-cream-100 dark:border-charcoal-700 bg-cream-50/50 dark:bg-charcoal-800/50">
              <button
                onClick={handlePreview}
                disabled={!canSubmit || previewing || cleaning}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium rounded-lg
                           border border-cream-200 dark:border-charcoal-600
                           text-charcoal-700 dark:text-cream-200 hover:bg-cream-100 dark:hover:bg-charcoal-700
                           transition-colors disabled:opacity-50"
              >
                {previewing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {previewing ? t('admin.cleanup.previewing') : t('admin.cleanup.preview')}
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={!canSubmit || cleaning}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-white rounded-lg
                           bg-red-500 hover:bg-red-600 transition-colors shadow-sm disabled:opacity-50"
              >
                {cleaning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('admin.cleanup.confirm')}
              </button>
            </div>
          </div>
        </div>
      </ModalPortal>

      <ConfirmDialog
        open={showConfirm}
        danger
        loading={cleaning}
        title={confirmDialogTitle}
        message={
          previewCount !== null
            ? `${confirmDialogMessage}\n\n${t('admin.cleanup.willDelete', { n: previewCount })}`
            : confirmDialogMessage
        }
        confirmText={t('admin.cleanup.confirm')}
        onConfirm={handleCleanup}
        onCancel={() => setShowConfirm(false)}
      />
    </>
  );
}
