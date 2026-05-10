'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Filter,
  Trash2,
  Copy,
  ExternalLink,
  Share2,
  Radio,
  Loader2,
  Check,
  AlertCircle,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import ConfirmDialog from '@/components/ConfirmDialog';

interface ShareLinkRow {
  id: string;
  token: string;
  sessionId: string;
  isLive: boolean;
  expiresAt: string | null;
  createdAt: string;
  url: string;
  session: {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    sourceLang: string;
    targetLang: string;
  } | null;
  creator: {
    id: string;
    email: string;
    displayName: string;
    role: string;
  } | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type StatusFilter = '' | 'live' | 'playback' | 'expired';

function formatRelative(target: Date, now: Date, t: (k: string, p?: Record<string, string | number>) => string): string {
  const diffMs = target.getTime() - now.getTime();
  const past = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const minutes = Math.floor(absMs / 60_000);
  const hours = Math.floor(absMs / 3_600_000);
  const days = Math.floor(absMs / 86_400_000);

  let when: string;
  if (days >= 1) when = `${days}d`;
  else if (hours >= 1) when = `${hours}h`;
  else if (minutes >= 1) when = `${minutes}m`;
  else when = '<1m';

  return past ? t('shareLinks.expiredSince', { when }) : t('shareLinks.expiresIn', { when });
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
  if (isYesterday) return `${time}`;
  return `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${time}`;
}

export default function ShareLinksPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  const [links, setLinks] = useState<ShareLinkRow[]>([]);
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 自定义删除确认弹窗的待办状态
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const fetchLinks = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '20' });
        if (keyword) params.set('keyword', keyword);
        if (statusFilter) params.set('status', statusFilter);

        const res = await fetch(`/api/admin/share-links?${params}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setLinks(data.links);
          setPagination(data.pagination);
          setSelected(new Set());
        } else {
          const errData = await res.json().catch(() => null);
          toast.error(t('common.networkError'), errData?.error);
        }
      } catch (err) {
        console.error('Failed to fetch share links:', err);
        toast.error(t('common.networkError'));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, keyword, statusFilter],
  );

  useEffect(() => {
    fetchLinks(1);
  }, [fetchLinks]);

  const handleSearch = () => setKeyword(searchInput);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleCopy = async (link: ShareLinkRow) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedId(link.id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === link.id ? null : prev));
      }, 1500);
    } catch {
      toast.error(t('common.operationFailed'));
    }
  };

  // 触发删除：先把目标 ids 推到 pendingDelete 让 ConfirmDialog 显示
  const handleDelete = (ids: string[]) => {
    if (ids.length === 0) return;
    setPendingDelete(ids);
  };

  // 用户确认删除后实际执行
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
      const res = await fetch('/api/admin/share-links', {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('common.deleteSuccess'), `${data.deleted}`);
        // 乐观更新本地状态
        setLinks((prev) => prev.filter((l) => !ids.includes(l.id)));
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

  const allOnPageSelected = useMemo(
    () => links.length > 0 && links.every((l) => selected.has(l.id)),
    [links, selected],
  );

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        links.forEach((l) => next.delete(l.id));
      } else {
        links.forEach((l) => next.add(l.id));
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

  const StatusBadge = ({ link }: { link: ShareLinkRow }) => {
    const now = new Date();
    const expired = link.expiresAt && new Date(link.expiresAt) <= now;
    if (expired) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-charcoal-100 text-charcoal-500 dark:bg-charcoal-700 dark:text-charcoal-300 transition-colors">
          <AlertCircle className="w-3 h-3" />
          {t('shareLinks.statusExpired')}
        </span>
      );
    }
    if (link.isLive) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 transition-colors">
          <Radio className="w-3 h-3" />
          {t('shareLinks.statusLive')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 transition-colors">
        <Share2 className="w-3 h-3" />
        {t('shareLinks.statusPlayback')}
      </span>
    );
  };

  const now = new Date();
  const selectedCount = selected.size;

  return (
    <div className="animate-fade-in">
      {/* 标题区 */}
      <div className="mb-5 animate-fade-in-up">
        <h2 className="text-xl font-serif font-bold text-charcoal-800 dark:text-cream-100">
          {t('shareLinks.title')}
        </h2>
        <p className="text-sm text-charcoal-500 dark:text-charcoal-400 mt-1">
          {t('shareLinks.description')}
        </p>
      </div>

      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center gap-3 mb-5 animate-fade-in-up stagger-1">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('shareLinks.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                       placeholder:text-charcoal-400 focus:outline-none focus:ring-2 focus:ring-rust-300
                       transition-all duration-150"
          />
        </div>

        {/* 状态筛选 */}
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
            <option value="">{t('shareLinks.allStatuses')}</option>
            <option value="live">{t('shareLinks.statusLive')}</option>
            <option value="playback">{t('shareLinks.statusPlayback')}</option>
            <option value="expired">{t('shareLinks.statusExpired')}</option>
          </select>
        </div>

        {/* 刷新 */}
        <button
          onClick={() => fetchLinks(pagination.page)}
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

        {/* 批量删除 */}
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
            {t('shareLinks.deleteSelected')}
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-rust-700/40 text-[10px] font-mono">
              {selectedCount}
            </span>
          </button>
        )}
      </div>

      {/* 列表 */}
      <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 overflow-x-auto animate-fade-in-up stagger-2">
        {/* 表头 */}
        <div className="grid grid-cols-[40px_minmax(220px,2fr)_minmax(160px,1.2fr)_110px_110px_140px_120px] gap-4 px-5 py-3 border-b border-cream-200 dark:border-charcoal-700 bg-cream-50 dark:bg-charcoal-750 min-w-[920px]">
          <div className="flex items-center">
            <input
              type="checkbox"
              checked={allOnPageSelected}
              onChange={toggleAll}
              disabled={links.length === 0}
              className="w-4 h-4 rounded border-cream-300 text-rust-500 focus:ring-rust-300 cursor-pointer transition-all"
              aria-label={t('shareLinks.selectAll')}
            />
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('shareLinks.colSession')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('shareLinks.colCreator')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('shareLinks.colType')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('shareLinks.colCreated')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('shareLinks.colExpires')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider text-right">
            {t('shareLinks.colActions')}
          </div>
        </div>

        {/* 行 */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 text-charcoal-400 animate-spin mr-2" />
            <span className="text-charcoal-400 text-sm">{t('common.loading')}</span>
          </div>
        ) : links.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
            <Share2 className="w-10 h-10 text-charcoal-300 mb-3 animate-breathe" />
            <p className="text-charcoal-600 dark:text-charcoal-300 font-medium">
              {t('shareLinks.noLinks')}
            </p>
            <p className="text-charcoal-400 text-sm mt-1 max-w-sm">
              {t('shareLinks.noLinksDesc')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
            {links.map((link, idx) => {
              const isSelected = selected.has(link.id);
              const isDeleting = deletingIds.has(link.id);
              const expired = link.expiresAt && new Date(link.expiresAt) <= now;
              const expiresLabel = link.expiresAt
                ? formatRelative(new Date(link.expiresAt), now, t)
                : t('shareLinks.neverExpires');

              return (
                <div
                  key={link.id}
                  className={`grid grid-cols-[40px_minmax(220px,2fr)_minmax(160px,1.2fr)_110px_110px_140px_120px]
                              gap-4 px-5 py-3.5 min-w-[920px] animate-fade-in-up
                              transition-all duration-200
                              ${isSelected
                                ? 'bg-rust-50/40 dark:bg-rust-900/10'
                                : 'hover:bg-cream-50/60 dark:hover:bg-charcoal-750/60'}
                              ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
                >
                  {/* 选择框 */}
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(link.id)}
                      className="w-4 h-4 rounded border-cream-300 text-rust-500 focus:ring-rust-300 cursor-pointer transition-all"
                    />
                  </div>

                  {/* 会话 */}
                  <div className="flex items-center min-w-0">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-charcoal-800 dark:text-cream-100 truncate">
                        {link.session?.title || `Session ${link.sessionId.slice(0, 8)}`}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-charcoal-400 font-mono truncate">
                          {link.token.slice(0, 12)}…
                        </span>
                        {link.session?.sourceLang && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cream-100 text-charcoal-500 dark:bg-charcoal-700 dark:text-charcoal-300 uppercase">
                            {link.session.sourceLang}
                            {link.session.targetLang && link.session.targetLang !== link.session.sourceLang
                              ? `→${link.session.targetLang}`
                              : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 创建者 */}
                  <div className="flex items-center min-w-0">
                    <div className="min-w-0">
                      <div className="text-sm text-charcoal-700 dark:text-charcoal-200 truncate">
                        {link.creator?.displayName || '—'}
                      </div>
                      <div className="text-[11px] text-charcoal-400 truncate">
                        {link.creator?.email}
                      </div>
                    </div>
                  </div>

                  {/* 类型 */}
                  <div className="flex items-center">
                    <StatusBadge link={link} />
                  </div>

                  {/* 创建时间 */}
                  <div className="flex items-center">
                    <span className="text-sm text-charcoal-500 dark:text-charcoal-400 whitespace-nowrap">
                      {formatDateTime(link.createdAt)}
                    </span>
                  </div>

                  {/* 过期时间 */}
                  <div className="flex items-center">
                    <span className={`text-sm whitespace-nowrap ${expired ? 'text-charcoal-400 italic' : 'text-charcoal-600 dark:text-charcoal-300'}`}>
                      {expiresLabel}
                    </span>
                  </div>

                  {/* 操作 */}
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => handleCopy(link)}
                      className="p-1.5 rounded-md text-charcoal-500 hover:text-charcoal-700
                                 hover:bg-cream-100 dark:hover:bg-charcoal-700
                                 transition-all duration-150 hover:scale-110 active:scale-95"
                      title={t('shareLinks.copyUrl')}
                      aria-label={t('shareLinks.copyUrl')}
                    >
                      {copiedId === link.id ? (
                        <Check className="w-4 h-4 text-emerald-500 animate-pop-in" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded-md text-charcoal-500 hover:text-charcoal-700
                                 hover:bg-cream-100 dark:hover:bg-charcoal-700
                                 transition-all duration-150 hover:scale-110 active:scale-95"
                      title={t('shareLinks.openInNewTab')}
                      aria-label={t('shareLinks.openInNewTab')}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                    <button
                      onClick={() => handleDelete([link.id])}
                      disabled={isDeleting}
                      className="p-1.5 rounded-md text-rust-500 hover:text-rust-700
                                 hover:bg-rust-50 dark:hover:bg-rust-900/30
                                 transition-all duration-150 hover:scale-110 active:scale-95
                                 disabled:opacity-50"
                      title={t('shareLinks.deleteLink')}
                      aria-label={t('shareLinks.deleteLink')}
                    >
                      {isDeleting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 删除确认弹窗（自定义，替代浏览器原生 confirm） */}
        <ConfirmDialog
          open={pendingDelete !== null}
          danger
          title={t('shareLinks.deleteLink')}
          message={
            pendingDelete && pendingDelete.length === 1
              ? t('shareLinks.deleteConfirm')
              : t('shareLinks.deleteSelectedConfirm', { n: pendingDelete?.length ?? 0 })
          }
          confirmText={t('common.delete')}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />

        {/* 分页 */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-cream-200 dark:border-charcoal-700 bg-cream-50/50 dark:bg-charcoal-750/50">
            <span className="text-xs text-charcoal-400">
              {t('shareLinks.total', { n: pagination.total })}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fetchLinks(pagination.page - 1)}
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
                onClick={() => fetchLinks(pagination.page + 1)}
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
    </div>
  );
}
