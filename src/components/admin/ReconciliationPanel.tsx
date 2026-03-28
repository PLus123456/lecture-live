'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Play,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertTriangle,
  ArrowLeft,
  Scale,
  Loader2,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';

interface Mismatch {
  id: string;
  userId: string;
  userEmail: string;
  recordedMinutes: number;
  storedMinutes: number;
  driftMinutes: number;
  fixed: boolean;
  fixedAt: string | null;
  fixedBy: string | null;
}

interface Run {
  id: string;
  triggeredBy: string;
  triggeredByName: string | null;
  status: string;
  totalUsers: number;
  mismatchCount: number;
  fixedCount: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  mismatches?: Mismatch[];
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export default function ReconciliationPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  const [runs, setRuns] = useState<Run[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null); // mismatchId 或 'all'

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  // 获取对账历史
  const fetchRuns = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/reconciliation?page=${page}&pageSize=20`, {
          headers,
        });
        if (res.ok) {
          const data = await res.json();
          setRuns(data.runs);
          setPagination(data.pagination);
        }
      } catch (err) {
        console.error('获取对账记录失败:', err);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token]
  );

  useEffect(() => {
    fetchRuns(1);
  }, [fetchRuns]);

  // 触发对账
  const handleRunReconciliation = async () => {
    if (!confirm(t('reconciliation.triggerConfirm'))) return;
    setRunning(true);
    try {
      const res = await fetch('/api/admin/reconciliation', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const newRun = await res.json();
        // 如果当前在列表页，刷新；如果有差异直接展示详情
        if (newRun.mismatchCount > 0) {
          setSelectedRun(newRun);
        }
        fetchRuns(1);
      }
    } catch (err) {
      console.error('对账运行失败:', err);
    } finally {
      setRunning(false);
    }
  };

  // 查看详情
  const handleViewDetail = async (runId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/reconciliation/${runId}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setSelectedRun(data);
      }
    } catch (err) {
      console.error('获取对账详情失败:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  // 单条修复
  const handleFix = async (mismatchId: string) => {
    if (!confirm(t('reconciliation.fixConfirm'))) return;
    setFixing(mismatchId);
    try {
      const res = await fetch('/api/admin/reconciliation/fix', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mismatchId }),
      });
      if (res.ok && selectedRun) {
        // 更新本地状态
        setSelectedRun({
          ...selectedRun,
          fixedCount: selectedRun.fixedCount + 1,
          mismatches: selectedRun.mismatches?.map((m) =>
            m.id === mismatchId ? { ...m, fixed: true, fixedAt: new Date().toISOString() } : m
          ),
        });
        fetchRuns(pagination.page);
      }
    } catch (err) {
      console.error('修复失败:', err);
    } finally {
      setFixing(null);
    }
  };

  // 批量修复
  const handleFixAll = async () => {
    if (!selectedRun || !confirm(t('reconciliation.fixAllConfirm'))) return;
    setFixing('all');
    try {
      const res = await fetch('/api/admin/reconciliation/fix', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: selectedRun.id, fixAll: true }),
      });
      if (res.ok) {
        // 刷新详情
        handleViewDetail(selectedRun.id);
        fetchRuns(pagination.page);
      }
    } catch (err) {
      console.error('批量修复失败:', err);
    } finally {
      setFixing(null);
    }
  };

  // 格式化时间
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

    if (isToday) return `今天 ${time}`;
    if (isYesterday) return `昨天 ${time}`;
    return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`;
  };

  // 状态徽标
  const StatusBadge = ({ status }: { status: string }) => {
    if (status === 'running') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          {t('reconciliation.statusRunning')}
        </span>
      );
    }
    if (status === 'completed') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
          <Check className="w-3 h-3" />
          {t('reconciliation.statusCompleted')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <AlertTriangle className="w-3 h-3" />
        {t('reconciliation.statusFailed')}
      </span>
    );
  };

  // ────────── 详情页 ──────────
  if (selectedRun) {
    const unfixedCount = selectedRun.mismatches?.filter((m) => !m.fixed).length ?? 0;

    return (
      <div>
        {/* 顶部操作栏 */}
        <div className="flex items-center justify-between mb-5">
          <button
            onClick={() => setSelectedRun(null)}
            className="inline-flex items-center gap-2 text-sm text-charcoal-500 hover:text-charcoal-700 dark:text-charcoal-400 dark:hover:text-cream-200 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('reconciliation.backToList')}
          </button>
          {unfixedCount > 0 && (
            <button
              onClick={handleFixAll}
              disabled={fixing === 'all'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                         bg-rust-500 text-white hover:bg-rust-600 disabled:opacity-50 transition-colors"
            >
              {fixing === 'all' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              {t('reconciliation.fixAll')} ({unfixedCount})
            </button>
          )}
        </div>

        {/* 运行摘要 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          {[
            { label: t('reconciliation.totalUsers'), value: selectedRun.totalUsers },
            { label: t('reconciliation.mismatches'), value: selectedRun.mismatchCount, warn: selectedRun.mismatchCount > 0 },
            { label: t('reconciliation.fixed'), value: selectedRun.fixedCount },
            { label: t('reconciliation.status'), value: <StatusBadge status={selectedRun.status} /> },
          ].map((card, i) => (
            <div
              key={i}
              className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-4"
            >
              <div className="text-xs text-charcoal-400 mb-1">{card.label}</div>
              <div className={`text-xl font-bold ${
                card.warn ? 'text-amber-600 dark:text-amber-400' : 'text-charcoal-800 dark:text-cream-100'
              }`}>
                {typeof card.value === 'number' ? card.value : card.value}
              </div>
            </div>
          ))}
        </div>

        {/* 差异明细表 */}
        <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 overflow-x-auto">
          {/* 表头 */}
          <div className="grid grid-cols-[1fr_100px_100px_100px_80px_80px] gap-4 px-5 py-3 border-b border-cream-200 dark:border-charcoal-700 bg-cream-50 dark:bg-charcoal-750 min-w-[620px]">
            <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.email')}</div>
            <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.actualMinutes')}</div>
            <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.storedMinutes')}</div>
            <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.drift')}</div>
            <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.status')}</div>
            <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.actions')}</div>
          </div>

          {/* 内容 */}
          {!selectedRun.mismatches || selectedRun.mismatches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Scale className="w-10 h-10 text-emerald-400 mb-3" />
              <p className="text-charcoal-400 text-sm">{t('reconciliation.noMismatches')}</p>
            </div>
          ) : (
            <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
              {selectedRun.mismatches.map((m) => (
                <div
                  key={m.id}
                  className="grid grid-cols-[1fr_100px_100px_100px_80px_80px] gap-4 px-5 py-3.5 hover:bg-cream-50/50 dark:hover:bg-charcoal-750/50 transition-colors min-w-[620px]"
                >
                  <div className="text-sm text-charcoal-800 dark:text-cream-100 truncate">{m.userEmail}</div>
                  <div className="text-sm text-charcoal-600 dark:text-charcoal-300 font-mono">{m.recordedMinutes}</div>
                  <div className="text-sm text-charcoal-600 dark:text-charcoal-300 font-mono">{m.storedMinutes}</div>
                  <div className={`text-sm font-mono font-medium ${
                    m.driftMinutes > 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}>
                    {m.driftMinutes > 0 ? '+' : ''}{m.driftMinutes}
                    <span className="text-xs ml-1 font-normal">
                      {m.driftMinutes > 0 ? t('reconciliation.underCharged') : t('reconciliation.overCharged')}
                    </span>
                  </div>
                  <div>
                    {m.fixed ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <Check className="w-3 h-3" />
                        {t('reconciliation.fixed')}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        {t('reconciliation.mismatches')}
                      </span>
                    )}
                  </div>
                  <div>
                    {!m.fixed && (
                      <button
                        onClick={() => handleFix(m.id)}
                        disabled={fixing === m.id}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium
                                   bg-rust-50 text-rust-600 hover:bg-rust-100 dark:bg-rust-900/30 dark:text-rust-400 dark:hover:bg-rust-900/50
                                   disabled:opacity-50 transition-colors"
                      >
                        {fixing === m.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Check className="w-3 h-3" />
                        )}
                        {t('reconciliation.fix')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ────────── 列表页 ──────────
  return (
    <div>
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-serif font-bold text-charcoal-800 dark:text-cream-100">
          {t('reconciliation.title')}
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchRuns(pagination.page)}
            disabled={loading}
            className="p-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                       bg-white dark:bg-charcoal-800 text-charcoal-500 hover:text-charcoal-700
                       hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-colors disabled:opacity-50"
            title={t('common.refresh')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleRunReconciliation}
            disabled={running}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                       bg-rust-500 text-white hover:bg-rust-600 disabled:opacity-50 transition-colors"
          >
            {running ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {running ? t('reconciliation.running') : t('reconciliation.runButton')}
          </button>
        </div>
      </div>

      {/* 运行历史 */}
      <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 overflow-x-auto">
        {/* 表头 */}
        <div className="grid grid-cols-[180px_140px_80px_80px_80px_80px_1fr] gap-4 px-5 py-3 border-b border-cream-200 dark:border-charcoal-700 bg-cream-50 dark:bg-charcoal-750 min-w-[780px]">
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.time')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.triggeredBy')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.totalUsers')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.mismatches')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.fixed')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.status')}</div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">{t('reconciliation.actions')}</div>
        </div>

        {/* 内容 */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Scale className="w-10 h-10 text-charcoal-300 mb-3" />
            <p className="text-charcoal-500 dark:text-charcoal-400 text-sm font-medium">{t('reconciliation.noRuns')}</p>
            <p className="text-charcoal-400 text-xs mt-1">{t('reconciliation.noRunsDesc')}</p>
          </div>
        ) : (
          <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
            {runs.map((run) => (
              <div
                key={run.id}
                className="grid grid-cols-[180px_140px_80px_80px_80px_80px_1fr] gap-4 px-5 py-3.5 hover:bg-cream-50/50 dark:hover:bg-charcoal-750/50 transition-colors min-w-[780px]"
              >
                <div className="text-sm text-charcoal-500 dark:text-charcoal-400 whitespace-nowrap">
                  {formatTime(run.createdAt)}
                </div>
                <div className="text-sm text-charcoal-600 dark:text-charcoal-300 truncate">
                  {run.triggeredByName || '—'}
                </div>
                <div className="text-sm text-charcoal-800 dark:text-cream-100 font-mono">
                  {run.totalUsers}
                </div>
                <div className={`text-sm font-mono font-medium ${
                  run.mismatchCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-charcoal-600 dark:text-charcoal-300'
                }`}>
                  {run.mismatchCount}
                </div>
                <div className="text-sm text-emerald-600 dark:text-emerald-400 font-mono">
                  {run.fixedCount}
                </div>
                <div>
                  <StatusBadge status={run.status} />
                </div>
                <div>
                  <button
                    onClick={() => handleViewDetail(run.id)}
                    disabled={detailLoading}
                    className="text-sm text-rust-500 hover:text-rust-600 dark:text-rust-400 dark:hover:text-rust-300 font-medium transition-colors"
                  >
                    {t('reconciliation.viewDetail')}
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
              {t('reconciliation.total', { n: pagination.total })}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fetchRuns(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-charcoal-600 dark:text-charcoal-300 px-2">
                {pagination.page} / {pagination.totalPages}
              </span>
              <button
                onClick={() => fetchRuns(pagination.page + 1)}
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
