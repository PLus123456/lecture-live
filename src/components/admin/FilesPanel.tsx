'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Filter,
  Trash2,
  PlayCircle,
  FileAudio,
  FileText,
  Loader2,
  HardDrive,
  Folder,
  Mic,
  Archive,
  Radio,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import ConfirmDialog from '@/components/ConfirmDialog';

interface FileOwner {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

interface FileRow {
  id: string;
  title: string;
  titleEn: string | null;
  courseName: string | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  status: string;
  audioSource: string;
  sourceLang: string;
  targetLang: string;
  recordingPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  reportPath: string | null;
  hasRecording: boolean;
  canPlayback: boolean;
  playbackPath: string;
  owner: FileOwner | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type StatusFilter = '' | 'has-recording' | 'no-recording' | 'completed' | 'archived' | 'recording';

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${time}`;
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const map: Record<
    string,
    { label: string; cls: string; icon: typeof CheckCircle2 }
  > = {
    COMPLETED: {
      label: t('adminFiles.statusCompleted'),
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      icon: CheckCircle2,
    },
    ARCHIVED: {
      label: t('adminFiles.statusArchived'),
      cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      icon: Archive,
    },
    RECORDING: {
      label: t('adminFiles.statusRecording'),
      cls: 'bg-rust-100 text-rust-700 dark:bg-rust-900/30 dark:text-rust-400',
      icon: Radio,
    },
    PAUSED: {
      label: t('adminFiles.statusPaused'),
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      icon: AlertCircle,
    },
    FINALIZING: {
      label: t('adminFiles.statusFinalizing'),
      cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
      icon: Loader2,
    },
    CREATED: {
      label: t('adminFiles.statusCreated'),
      cls: 'bg-charcoal-100 text-charcoal-500 dark:bg-charcoal-700 dark:text-charcoal-300',
      icon: AlertCircle,
    },
  };
  const info = map[status] ?? map.CREATED;
  const Icon = info.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${info.cls}`}
    >
      <Icon
        className={`w-3 h-3 ${status === 'FINALIZING' ? 'animate-spin' : ''}`}
      />
      {info.label}
    </span>
  );
}

export default function FilesPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const router = useRouter();

  const [files, setFiles] = useState<FileRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const fetchFiles = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '20' });
        if (keyword) params.set('keyword', keyword);
        if (statusFilter) params.set('status', statusFilter);

        const res = await fetch(`/api/admin/files?${params}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setFiles(data.files);
          setPagination(data.pagination);
          setSelected(new Set());
        } else {
          const errData = await res.json().catch(() => null);
          toast.error(t('common.networkError'), errData?.error);
        }
      } catch (err) {
        console.error('Failed to fetch files:', err);
        toast.error(t('common.networkError'));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, keyword, statusFilter],
  );

  useEffect(() => {
    fetchFiles(1);
  }, [fetchFiles]);

  const handleSearch = () => setKeyword(searchInput);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      window.setTimeout(() => {
        setCopiedPath((prev) => (prev === path ? null : prev));
      }, 1500);
    } catch {
      toast.error(t('common.operationFailed'));
    }
  };

  // 真正的删除（用户点弹窗确认按钮后触发）
  const confirmDelete = async () => {
    const ids = pendingDelete;
    if (!ids || ids.length === 0) {
      setPendingDelete(null);
      return;
    }
    setPendingDelete(null);

    setDeletingIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });

    try {
      const res = await fetch('/api/admin/files', {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('common.deleteSuccess'), `${data.deleted}`);
        setFiles((prev) => prev.filter((f) => !ids.includes(f.id)));
        setSelected((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - data.deleted),
        }));
      } else {
        const errData = await res.json().catch(() => null);
        toast.error(t('common.deleteFailed'), errData?.error);
      }
    } catch {
      toast.error(t('common.deleteFailed'), t('common.networkError'));
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const handleDelete = (ids: string[]) => {
    if (ids.length === 0) return;
    setPendingDelete(ids);
  };

  const allOnPageSelected = useMemo(
    () => files.length > 0 && files.every((f) => selected.has(f.id)),
    [files, selected],
  );

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        files.forEach((f) => next.delete(f.id));
      } else {
        files.forEach((f) => next.add(f.id));
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handlePlayback = (file: FileRow) => {
    router.push(file.playbackPath);
  };

  const selectedCount = selected.size;

  return (
    <div className="animate-fade-in">
      {/* 标题区 */}
      <div className="mb-5 animate-fade-in-up">
        <h2 className="text-xl md:text-2xl font-serif font-bold text-charcoal-800 dark:text-cream-100">
          {t('adminFiles.title')}
        </h2>
        <p className="text-sm text-charcoal-500 dark:text-charcoal-400 mt-1">
          {t('adminFiles.description')}
        </p>
      </div>

      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center gap-3 mb-5 animate-fade-in-up stagger-1">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('adminFiles.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                       placeholder:text-charcoal-400 focus:outline-none focus:ring-2 focus:ring-rust-300
                       transition-all duration-150"
          />
        </div>

        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-400 pointer-events-none" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="pl-9 pr-8 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                       focus:outline-none focus:ring-2 focus:ring-rust-300 appearance-none cursor-pointer
                       transition-all duration-150"
          >
            <option value="">{t('adminFiles.allStatuses')}</option>
            <option value="has-recording">{t('adminFiles.filterHasRecording')}</option>
            <option value="no-recording">{t('adminFiles.filterNoRecording')}</option>
            <option value="completed">{t('adminFiles.statusCompleted')}</option>
            <option value="archived">{t('adminFiles.statusArchived')}</option>
            <option value="recording">{t('adminFiles.statusRecording')}</option>
          </select>
        </div>

        <button
          onClick={() => fetchFiles(pagination.page)}
          disabled={loading}
          className="p-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-charcoal-500 hover:text-charcoal-700
                     hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-all duration-150
                     disabled:opacity-50 hover:scale-105 active:scale-95"
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
        >
          <RefreshCw className={`w-4 h-4 transition-transform duration-300 ${loading ? 'animate-spin' : ''}`} />
        </button>

        {selectedCount > 0 && (
          <button
            onClick={() => handleDelete([...selected])}
            disabled={deletingIds.size > 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium
                       bg-rust-500 text-white hover:bg-rust-600 active:bg-rust-700
                       transition-all duration-150 ml-auto animate-fade-in-scale
                       disabled:opacity-50 hover:scale-[1.02] active:scale-95"
          >
            {deletingIds.size > 0 ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            {t('adminFiles.deleteSelected')}
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-rust-700/40 text-[10px] font-mono">
              {selectedCount}
            </span>
          </button>
        )}
      </div>

      {/* 列表 */}
      <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 overflow-x-auto animate-fade-in-up stagger-2">
        <div className="grid grid-cols-[36px_minmax(220px,2fr)_minmax(160px,1.2fr)_110px_90px_130px_140px] gap-4 px-5 py-3 border-b border-cream-200 dark:border-charcoal-700 bg-cream-50 dark:bg-charcoal-750 min-w-[940px]">
          <div className="flex items-center">
            <input
              type="checkbox"
              checked={allOnPageSelected}
              onChange={toggleAll}
              disabled={files.length === 0}
              className="w-4 h-4 rounded border-cream-300 text-rust-500 focus:ring-rust-300 cursor-pointer transition-all"
              aria-label={t('shareLinks.selectAll')}
            />
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminFiles.colRecording')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminFiles.colOwner')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminFiles.colStatus')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminFiles.colDuration')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminFiles.colCreated')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider text-right">
            {t('shareLinks.colActions')}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 text-charcoal-400 animate-spin mr-2" />
            <span className="text-charcoal-400 text-sm">{t('common.loading')}</span>
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
            <FileAudio className="w-10 h-10 text-charcoal-300 mb-3 animate-breathe" />
            <p className="text-charcoal-600 dark:text-charcoal-300 font-medium">
              {t('adminFiles.noFiles')}
            </p>
            <p className="text-charcoal-400 text-sm mt-1 max-w-sm">
              {t('adminFiles.noFilesDesc')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
            {files.map((file, idx) => {
              const isSelected = selected.has(file.id);
              const isDeleting = deletingIds.has(file.id);
              const isExpanded = expandedId === file.id;

              return (
                <div key={file.id} className="animate-fade-in-up" style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}>
                  <div
                    className={`grid grid-cols-[36px_minmax(220px,2fr)_minmax(160px,1.2fr)_110px_90px_130px_140px]
                                gap-4 px-5 py-3.5 min-w-[940px]
                                transition-all duration-200
                                ${isSelected
                                  ? 'bg-rust-50/40 dark:bg-rust-900/10'
                                  : 'hover:bg-cream-50/60 dark:hover:bg-charcoal-750/60'}
                                ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(file.id)}
                        className="w-4 h-4 rounded border-cream-300 text-rust-500 focus:ring-rust-300 cursor-pointer transition-all"
                      />
                    </div>

                    {/* 录音名 + 元信息 */}
                    <div className="flex items-center min-w-0 gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-rust-50 dark:bg-rust-900/30 flex items-center justify-center flex-shrink-0">
                        {file.hasRecording ? (
                          <Mic className="w-4 h-4 text-rust-500" />
                        ) : (
                          <FileText className="w-4 h-4 text-charcoal-400" />
                        )}
                      </div>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : file.id)}
                        className="min-w-0 text-left flex-1"
                      >
                        <div className="text-sm font-medium text-charcoal-800 dark:text-cream-100 truncate hover:text-rust-600 transition-colors">
                          {file.title || `Session ${file.id.slice(0, 8)}`}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-charcoal-400 font-mono truncate">
                            {file.id.slice(0, 12)}…
                          </span>
                          {file.sourceLang && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-cream-100 text-charcoal-500 dark:bg-charcoal-700 dark:text-charcoal-300 uppercase">
                              {file.sourceLang}
                              {file.targetLang && file.targetLang !== file.sourceLang
                                ? `→${file.targetLang}`
                                : ''}
                            </span>
                          )}
                        </div>
                      </button>
                    </div>

                    {/* 拥有者 */}
                    <div className="flex items-center min-w-0">
                      <div className="min-w-0">
                        <div className="text-sm text-charcoal-700 dark:text-charcoal-200 truncate">
                          {file.owner?.displayName || '—'}
                        </div>
                        <div className="text-[11px] text-charcoal-400 truncate">
                          {file.owner?.email}
                        </div>
                      </div>
                    </div>

                    {/* 状态 */}
                    <div className="flex items-center">
                      <StatusBadge status={file.status} />
                    </div>

                    {/* 时长 */}
                    <div className="flex items-center">
                      <span className="text-sm text-charcoal-500 dark:text-charcoal-400 font-mono tabular-nums">
                        {formatDuration(file.durationMs)}
                      </span>
                    </div>

                    {/* 创建时间 */}
                    <div className="flex items-center">
                      <span className="text-sm text-charcoal-500 dark:text-charcoal-400 whitespace-nowrap">
                        {formatDateTime(file.createdAt)}
                      </span>
                    </div>

                    {/* 操作 */}
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handlePlayback(file)}
                        disabled={!file.canPlayback}
                        className="p-1.5 rounded-md text-charcoal-500 hover:text-rust-600
                                   hover:bg-rust-50 dark:hover:bg-rust-900/30
                                   transition-all duration-150 hover:scale-110 active:scale-95
                                   disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                        title={t('adminFiles.openPlayback')}
                        aria-label={t('adminFiles.openPlayback')}
                      >
                        <PlayCircle className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : file.id)}
                        className="p-1.5 rounded-md text-charcoal-500 hover:text-charcoal-700
                                   hover:bg-cream-100 dark:hover:bg-charcoal-700
                                   transition-all duration-150 hover:scale-110 active:scale-95"
                        title={t('adminFiles.showPaths')}
                        aria-label={t('adminFiles.showPaths')}
                      >
                        <HardDrive className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete([file.id])}
                        disabled={isDeleting}
                        className="p-1.5 rounded-md text-rust-500 hover:text-rust-700
                                   hover:bg-rust-50 dark:hover:bg-rust-900/30
                                   transition-all duration-150 hover:scale-110 active:scale-95
                                   disabled:opacity-50"
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                      >
                        {isDeleting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* 展开行：存储路径详情 */}
                  <div
                    className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out min-w-[940px]
                                ${isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
                    aria-hidden={!isExpanded}
                  >
                    <div className="overflow-hidden">
                      <div className="px-5 py-4 bg-cream-50/60 dark:bg-charcoal-750/60 border-t border-cream-100 dark:border-charcoal-700 space-y-2">
                        <PathRow
                          icon={<Mic className="w-3.5 h-3.5" />}
                          label={t('adminFiles.pathRecording')}
                          path={file.recordingPath}
                          onCopy={handleCopyPath}
                          copied={copiedPath === file.recordingPath}
                        />
                        <PathRow
                          icon={<FileText className="w-3.5 h-3.5" />}
                          label={t('adminFiles.pathTranscript')}
                          path={file.transcriptPath}
                          onCopy={handleCopyPath}
                          copied={copiedPath === file.transcriptPath}
                        />
                        <PathRow
                          icon={<FileText className="w-3.5 h-3.5" />}
                          label={t('adminFiles.pathSummary')}
                          path={file.summaryPath}
                          onCopy={handleCopyPath}
                          copied={copiedPath === file.summaryPath}
                        />
                        <PathRow
                          icon={<FileText className="w-3.5 h-3.5" />}
                          label={t('adminFiles.pathReport')}
                          path={file.reportPath}
                          onCopy={handleCopyPath}
                          copied={copiedPath === file.reportPath}
                        />
                        {file.courseName && (
                          <div className="flex items-center gap-2 text-xs text-charcoal-500 dark:text-charcoal-400 pt-1">
                            <Folder className="w-3.5 h-3.5" />
                            <span>{t('adminFiles.courseName')}: {file.courseName}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-3 pt-1 text-xs text-charcoal-400">
                          <span>{t('adminFiles.audioSource')}: {file.audioSource}</span>
                          <a
                            href={file.playbackPath}
                            className="inline-flex items-center gap-1 text-rust-600 hover:text-rust-700 hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" />
                            {t('adminFiles.openInNewTab')}
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 分页 */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-cream-200 dark:border-charcoal-700 bg-cream-50/50 dark:bg-charcoal-750/50">
            <span className="text-xs text-charcoal-400">
              {t('adminFiles.total', { n: pagination.total })}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fetchFiles(pagination.page - 1)}
                disabled={pagination.page <= 1 || loading}
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700
                           disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150
                           hover:scale-110 active:scale-95"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-charcoal-600 dark:text-charcoal-300 px-2 tabular-nums">
                {pagination.page} / {pagination.totalPages}
              </span>
              <button
                onClick={() => fetchFiles(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages || loading}
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700
                           disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150
                           hover:scale-110 active:scale-95"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={t('adminFiles.deleteTitle')}
        message={
          pendingDelete && pendingDelete.length === 1
            ? t('adminFiles.deleteConfirm')
            : t('adminFiles.deleteSelectedConfirm', { n: pendingDelete?.length ?? 0 })
        }
        confirmText={t('common.delete')}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function PathRow({
  icon,
  label,
  path,
  onCopy,
  copied,
}: {
  icon: React.ReactNode;
  label: string;
  path: string | null;
  onCopy: (p: string) => void;
  copied: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span className="flex-shrink-0 w-20 text-charcoal-500 dark:text-charcoal-400 inline-flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      {path ? (
        <>
          <code className="flex-1 px-2 py-1 rounded bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 text-charcoal-700 dark:text-charcoal-200 font-mono text-[11px] truncate min-w-0">
            {path}
          </code>
          <button
            onClick={() => onCopy(path)}
            className="flex-shrink-0 p-1 rounded text-charcoal-400 hover:text-charcoal-700 hover:bg-cream-100 dark:hover:bg-charcoal-700 transition-colors"
            title="复制路径"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </>
      ) : (
        <span className="text-charcoal-300 dark:text-charcoal-500 italic">—</span>
      )}
    </div>
  );
}
