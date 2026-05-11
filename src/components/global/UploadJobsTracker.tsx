'use client';

/**
 * 上传转录任务的全局后台 widget。
 *
 * UploadTranscribeModal 关闭后，job 仍在 uploadJobsStore 里继续跑（promise + sonioxClient
 * 持有引用），但 modal 卸载后用户就失去了进度可见性和取消能力。此 widget 订阅 store，
 * 给运行中的 job 提供：
 *  - 屏幕右下悬浮卡片，显示文件名 + 进度 + 状态
 *  - 取消按钮（通过 uploadJobs.cancel 触发已注册的 cancel handle）
 *  - 失败/完成后自动消失（toast 仍然负责告知结果）
 */

import { useCallback, useState } from 'react';
import { X, FileAudio, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useUploadJobsStore, uploadJobs, type UploadJob } from '@/stores/uploadJobsStore';
import { useI18n } from '@/lib/i18n';

const ACTIVE_STATUSES: UploadJob['status'][] = [
  'pending',
  'creating',
  'uploading',
  'transcribing',
  'finalizing',
];

export default function UploadJobsTracker() {
  const { t } = useI18n();
  const jobs = useUploadJobsStore((s) => s.jobs);
  const [collapsed, setCollapsed] = useState(false);

  const activeJobs = Object.values(jobs).filter((j) =>
    ACTIVE_STATUSES.includes(j.status),
  );

  const handleCancel = useCallback((id: string) => {
    uploadJobs.cancel(id);
  }, []);

  if (activeJobs.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[1100] w-[300px] max-w-[calc(100vw-2rem)]">
      <div className="bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 rounded-2xl shadow-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 bg-cream-50 dark:bg-charcoal-900/50 border-b border-cream-200 dark:border-charcoal-700 hover:bg-cream-100 dark:hover:bg-charcoal-900 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Loader2 className="w-3.5 h-3.5 text-rust-500 animate-spin shrink-0" />
            <span className="text-xs font-semibold text-charcoal-700 dark:text-cream-200 truncate">
              {t('upload.bgPanelTitle', { count: activeJobs.length })}
            </span>
          </div>
          {collapsed ? (
            <ChevronUp className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
          )}
        </button>

        {!collapsed && (
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-cream-100 dark:divide-charcoal-700">
            {activeJobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                onCancel={() => handleCancel(job.id)}
                statusLabel={statusLabel(job.status, t)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface JobRowProps {
  job: UploadJob;
  onCancel: () => void;
  statusLabel: string;
}

function JobRow({ job, onCancel, statusLabel }: JobRowProps) {
  const percent = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rust-50 dark:bg-rust-900/30 flex-shrink-0">
          <FileAudio className="h-4 w-4 text-rust-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-charcoal-800 dark:text-cream-100 truncate">
            {job.fileName}
          </div>
          <div className="mt-0.5 text-[10px] text-charcoal-400 dark:text-charcoal-300">
            {statusLabel} · {percent}%
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="w-6 h-6 flex items-center justify-center rounded-md text-charcoal-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
          aria-label="cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-cream-100 dark:bg-charcoal-700 overflow-hidden">
        <div
          className="h-full bg-rust-500 transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function statusLabel(
  status: UploadJob['status'],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case 'pending':
    case 'creating':
      return t('upload.creatingSession');
    case 'uploading':
      return t('upload.uploadingAudio');
    case 'transcribing':
      return t('upload.transcribing');
    case 'finalizing':
      return t('upload.finalizing');
    default:
      return '';
  }
}
