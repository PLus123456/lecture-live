'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertTriangle,
  ArrowLeft,
  Loader2,
  ArrowUpCircle,
  Pause,
  Layers,
  RotateCcw,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';

interface Job {
  id: string;
  type: string;
  status: string;
  params: string | null;
  result: string | null;
  error: string | null;
  sessionId: string | null;
  userId: string | null;
  triggeredBy: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const JOB_TYPES = [
  'keyword_extraction',
  'report_generation',
  'title_generation',
  'quota_reset',
  'stale_session_reclaim',
  'reconciliation',
  'storage_cleanup',
  'storage_migration',
  'billing_maintenance',
] as const;

const JOB_STATUSES = ['SUBMITTED', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'] as const;

const TYPE_I18N_MAP: Record<string, string> = {
  keyword_extraction: 'jobQueue.typeKeywordExtraction',
  report_generation: 'jobQueue.typeReportGeneration',
  title_generation: 'jobQueue.typeTitleGeneration',
  quota_reset: 'jobQueue.typeQuotaReset',
  stale_session_reclaim: 'jobQueue.typeStaleSessionReclaim',
  reconciliation: 'jobQueue.typeReconciliation',
  storage_cleanup: 'jobQueue.typeStorageCleanup',
  storage_migration: 'jobQueue.typeStorageMigration',
  billing_maintenance: 'jobQueue.typeBillingMaintenance',
};

export default function JobQueuePanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  // ─── 获取任务列表 ───
  const fetchJobs = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '20' });
        if (filterType) params.set('type', filterType);
        if (filterStatus) params.set('status', filterStatus);

        const res = await fetch(`/api/admin/jobs?${params}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setJobs(data.jobs);
          setPagination(data.pagination);
        }
      } catch (err) {
        console.error('获取任务列表失败:', err);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, filterType, filterStatus],
  );

  useEffect(() => {
    fetchJobs(1);
  }, [fetchJobs]);

  // ─── 自动刷新（存在 PROCESSING/SUBMITTED 任务时） ───
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === 'PROCESSING' || j.status === 'SUBMITTED');
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(() => fetchJobs(pagination.page), 15_000);
    } else if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobs, pagination.page, fetchJobs]);

  // ─── 重试失败任务 ───
  const handleRetry = async (jobId: string) => {
    setRetrying(jobId);
    try {
      const res = await fetch('/api/admin/jobs', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      if (res.ok) {
        // 更新本地状态
        const update = (j: Job) =>
          j.id === jobId
            ? { ...j, status: 'SUBMITTED', error: null, result: null, startedAt: null, completedAt: null, attempt: j.attempt + 1 }
            : j;
        setJobs((prev) => prev.map(update));
        if (selectedJob?.id === jobId) {
          setSelectedJob((prev) => (prev ? update(prev) : null));
        }
      } else {
        alert(t('jobQueue.retryFailed'));
      }
    } catch {
      alert(t('jobQueue.retryFailed'));
    } finally {
      setRetrying(null);
    }
  };

  // ─── 格式化时间 ───
  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    const time = d.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    if (isToday) return time;
    if (isYesterday) return `昨天 ${time}`;
    return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`;
  };

  // ─── 计算耗时 ───
  const formatDuration = (job: Job) => {
    if (!job.startedAt) return '—';
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    const ms = end - new Date(job.startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  };

  // ─── 状态徽标 ───
  const StatusBadge = ({ status }: { status: string }) => {
    switch (status) {
      case 'SUCCESS':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
            <Check className="w-3 h-3" />
            {t('jobQueue.statusSuccess')}
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            <AlertTriangle className="w-3 h-3" />
            {t('jobQueue.statusFailed')}
          </span>
        );
      case 'PROCESSING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('jobQueue.statusProcessing')}
          </span>
        );
      case 'PENDING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 dark:bg-slate-800/30 dark:text-slate-400">
            <Pause className="w-3 h-3" />
            {t('jobQueue.statusPending')}
          </span>
        );
      default: // SUBMITTED
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
            <ArrowUpCircle className="w-3 h-3" />
            {t('jobQueue.statusSubmitted')}
          </span>
        );
    }
  };

  // ─── 类型标签 ───
  const TypeBadge = ({ type }: { type: string }) => {
    const key = TYPE_I18N_MAP[type];
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-cream-100 text-charcoal-600 dark:bg-charcoal-700 dark:text-charcoal-300">
        {key ? t(key) : type}
      </span>
    );
  };

  // ─── JSON 格式化 ───
  const prettyJson = (raw: string | null) => {
    if (!raw) return null;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };

  // ────────── 详情页 ──────────
  if (selectedJob) {
    return (
      <div>
        {/* 顶部 */}
        <div className="flex items-center justify-between mb-5">
          <button
            onClick={() => setSelectedJob(null)}
            className="inline-flex items-center gap-2 text-sm text-charcoal-500 hover:text-charcoal-700 dark:text-charcoal-400 dark:hover:text-cream-200 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('jobQueue.backToList')}
          </button>
          {selectedJob.status === 'FAILED' && (
            <button
              onClick={() => handleRetry(selectedJob.id)}
              disabled={retrying === selectedJob.id}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                         bg-rust-500 text-white hover:bg-rust-600 disabled:opacity-50 transition-colors"
            >
              {retrying === selectedJob.id ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RotateCcw className="w-4 h-4" />
              )}
              {t('jobQueue.retry')}
            </button>
          )}
        </div>

        {/* 摘要卡片 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          {[
            { label: t('jobQueue.colType'), value: <TypeBadge type={selectedJob.type} /> },
            { label: t('jobQueue.colStatus'), value: <StatusBadge status={selectedJob.status} /> },
            { label: t('jobQueue.attempt'), value: `${selectedJob.attempt} / ${selectedJob.maxAttempts}` },
            { label: t('jobQueue.colDuration'), value: formatDuration(selectedJob) },
          ].map((card, i) => (
            <div
              key={i}
              className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-4"
            >
              <div className="text-xs text-charcoal-400 mb-1">{card.label}</div>
              <div className="text-sm font-medium text-charcoal-800 dark:text-cream-100">
                {card.value}
              </div>
            </div>
          ))}
        </div>

        {/* 元信息 */}
        <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-5 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-charcoal-400">{t('jobQueue.triggeredBy')}:</span>{' '}
              <span className="text-charcoal-700 dark:text-cream-200">{selectedJob.triggeredBy || '—'}</span>
            </div>
            <div>
              <span className="text-charcoal-400">ID:</span>{' '}
              <span className="text-charcoal-700 dark:text-cream-200 font-mono text-xs">{selectedJob.id}</span>
            </div>
            {selectedJob.sessionId && (
              <div>
                <span className="text-charcoal-400">Session:</span>{' '}
                <span className="text-charcoal-700 dark:text-cream-200 font-mono text-xs">{selectedJob.sessionId}</span>
              </div>
            )}
            {selectedJob.userId && (
              <div>
                <span className="text-charcoal-400">User:</span>{' '}
                <span className="text-charcoal-700 dark:text-cream-200 font-mono text-xs">{selectedJob.userId}</span>
              </div>
            )}
            <div>
              <span className="text-charcoal-400">{t('jobQueue.colTime')}:</span>{' '}
              <span className="text-charcoal-700 dark:text-cream-200">{formatTime(selectedJob.createdAt)}</span>
            </div>
            {selectedJob.startedAt && (
              <div>
                <span className="text-charcoal-400">{t('jobQueue.startedAt')}:</span>{' '}
                <span className="text-charcoal-700 dark:text-cream-200">{formatTime(selectedJob.startedAt)}</span>
              </div>
            )}
            {selectedJob.completedAt && (
              <div>
                <span className="text-charcoal-400">{t('jobQueue.completedAt')}:</span>{' '}
                <span className="text-charcoal-700 dark:text-cream-200">{formatTime(selectedJob.completedAt)}</span>
              </div>
            )}
          </div>
        </div>

        {/* 参数 */}
        <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-5 mb-4">
          <h3 className="text-sm font-semibold text-charcoal-700 dark:text-cream-200 mb-3">{t('jobQueue.params')}</h3>
          {selectedJob.params ? (
            <pre className="text-xs font-mono bg-cream-50 dark:bg-charcoal-900 rounded-lg p-3 overflow-x-auto text-charcoal-600 dark:text-charcoal-300 whitespace-pre-wrap break-all">
              {prettyJson(selectedJob.params)}
            </pre>
          ) : (
            <p className="text-sm text-charcoal-400">{t('jobQueue.noParams')}</p>
          )}
        </div>

        {/* 结果 */}
        {selectedJob.status === 'SUCCESS' && (
          <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-5 mb-4">
            <h3 className="text-sm font-semibold text-charcoal-700 dark:text-cream-200 mb-3">{t('jobQueue.result')}</h3>
            {selectedJob.result ? (
              <pre className="text-xs font-mono bg-emerald-50 dark:bg-emerald-950/20 rounded-lg p-3 overflow-x-auto text-emerald-700 dark:text-emerald-300 whitespace-pre-wrap break-all">
                {prettyJson(selectedJob.result)}
              </pre>
            ) : (
              <p className="text-sm text-charcoal-400">{t('jobQueue.noResult')}</p>
            )}
          </div>
        )}

        {/* 错误 */}
        {selectedJob.status === 'FAILED' && selectedJob.error && (
          <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-red-200 dark:border-red-900/50 p-5">
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-3">{t('jobQueue.error')}</h3>
            <pre className="text-xs font-mono bg-red-50 dark:bg-red-950/20 rounded-lg p-3 overflow-x-auto text-red-600 dark:text-red-300 whitespace-pre-wrap break-all">
              {selectedJob.error}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // ────────── 列表页 ──────────
  return (
    <div>
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-serif font-bold text-charcoal-800 dark:text-cream-100">
          {t('jobQueue.title')}
        </h2>
        <button
          onClick={() => fetchJobs(pagination.page)}
          disabled={loading}
          className="p-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-charcoal-500 hover:text-charcoal-700
                     hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-colors disabled:opacity-50"
          title={t('common.refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600 bg-white dark:bg-charcoal-800 text-sm text-charcoal-700 dark:text-cream-200"
        >
          <option value="">{t('jobQueue.allTypes')}</option>
          {JOB_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(TYPE_I18N_MAP[type])}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600 bg-white dark:bg-charcoal-800 text-sm text-charcoal-700 dark:text-cream-200"
        >
          <option value="">{t('jobQueue.allStatuses')}</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`jobQueue.status${s.charAt(0) + s.slice(1).toLowerCase()}`)}
            </option>
          ))}
        </select>
      </div>

      {/* 任务列表 */}
      <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 overflow-x-auto">
        {/* 表头 */}
        <div className="grid grid-cols-[140px_140px_100px_80px_120px_60px] gap-4 px-5 py-3 border-b border-cream-200 dark:border-charcoal-700 bg-cream-50 dark:bg-charcoal-750 min-w-[700px]">
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('jobQueue.colTime')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('jobQueue.colType')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('jobQueue.colStatus')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('jobQueue.colDuration')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('jobQueue.colRelated')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('jobQueue.colActions')}</div>
        </div>

        {/* 内容 */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Layers className="w-10 h-10 text-charcoal-300 mb-3" />
            <p className="text-charcoal-500 dark:text-charcoal-400 text-sm font-medium">{t('jobQueue.noJobs')}</p>
            <p className="text-charcoal-400 text-xs mt-1">{t('jobQueue.noJobsDesc')}</p>
          </div>
        ) : (
          <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="grid grid-cols-[140px_140px_100px_80px_120px_60px] gap-4 px-5 py-3.5 hover:bg-cream-50/50 dark:hover:bg-charcoal-750/50 transition-colors min-w-[700px]"
              >
                <div className="text-sm text-charcoal-500 dark:text-charcoal-400 whitespace-nowrap">
                  {formatTime(job.createdAt)}
                </div>
                <div>
                  <TypeBadge type={job.type} />
                </div>
                <div>
                  <StatusBadge status={job.status} />
                </div>
                <div className="text-sm text-charcoal-600 dark:text-charcoal-300 font-mono">
                  {formatDuration(job)}
                </div>
                <div className="text-xs text-charcoal-500 dark:text-charcoal-400 font-mono truncate">
                  {job.sessionId ? job.sessionId.slice(0, 12) + '…' : job.userId ? job.userId.slice(0, 12) + '…' : '—'}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedJob(job)}
                    className="text-sm text-rust-500 hover:text-rust-600 dark:text-rust-400 dark:hover:text-rust-300 font-medium transition-colors"
                  >
                    {t('jobQueue.viewDetail')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 分页 */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-cream-200 dark:border-charcoal-700 bg-cream-50/50 dark:bg-charcoal-750/50">
            <span className="text-xs text-charcoal-400">
              {t('jobQueue.total', { n: pagination.total })}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fetchJobs(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-charcoal-600 dark:text-charcoal-300 px-2">
                {pagination.page} / {pagination.totalPages}
              </span>
              <button
                onClick={() => fetchJobs(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
