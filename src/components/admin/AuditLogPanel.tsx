'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Filter,
  LogIn,
  LogOut,
  UserPlus,
  KeyRound,
  Settings,
  Trash2,
  Server,
  Bot,
  Activity,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';

interface AuditLogEntry {
  id: string;
  action: string;
  detail: string | null;
  userId: string | null;
  userName: string | null;
  ip: string | null;
  createdAt: string;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// 操作类型 → 图标 & 颜色映射
function getActionMeta(action: string): {
  icon: typeof LogIn;
  color: string;
  bg: string;
} {
  if (action.startsWith('user.login')) {
    return action.includes('failed')
      ? { icon: LogIn, color: '#d97706', bg: '#fef3c7' }
      : { icon: LogIn, color: '#059669', bg: '#d1fae5' };
  }
  if (action === 'user.logout') return { icon: LogOut, color: '#6b7280', bg: '#f3f4f6' };
  if (action === 'user.register') return { icon: UserPlus, color: '#2563eb', bg: '#dbeafe' };
  if (action === 'user.password.change') return { icon: KeyRound, color: '#7c3aed', bg: '#ede9fe' };
  if (action.startsWith('admin.settings')) return { icon: Settings, color: '#0891b2', bg: '#cffafe' };
  if (action.includes('delete')) return { icon: Trash2, color: '#dc2626', bg: '#fee2e2' };
  if (action.includes('user')) return { icon: UserPlus, color: '#2563eb', bg: '#dbeafe' };
  if (action.includes('llm')) return { icon: Bot, color: '#8b5cf6', bg: '#f3e8ff' };
  if (action.startsWith('system')) return { icon: Server, color: '#475569', bg: '#f1f5f9' };
  return { icon: Activity, color: '#64748b', bg: '#f8fafc' };
}

// 操作类型筛选选项
const ACTION_FILTERS = [
  { value: '', label: 'auditLog.allActions' },
  { value: 'user.login', label: 'auditLog.login' },
  { value: 'user.logout', label: 'auditLog.logout' },
  { value: 'user.register', label: 'auditLog.register' },
  { value: 'user.password', label: 'auditLog.passwordChange' },
  { value: 'admin.settings', label: 'auditLog.settingsChange' },
  { value: 'admin.user', label: 'auditLog.userManage' },
  { value: 'admin.llm', label: 'auditLog.llmManage' },
  { value: 'system', label: 'auditLog.system' },
];

export default function AuditLogPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const fetchLogs = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '50' });
        if (actionFilter) params.set('action', actionFilter);
        if (keyword) params.set('keyword', keyword);

        const res = await fetch(`/api/admin/logs?${params}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          setLogs(data.logs);
          setPagination(data.pagination);
        }
      } catch (err) {
        console.error('Failed to fetch logs:', err);
      } finally {
        setLoading(false);
      }
    },
    [token, actionFilter, keyword]
  );

  useEffect(() => {
    fetchLogs(1);
  }, [fetchLogs]);

  const handleSearch = () => {
    setKeyword(searchInput);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
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

    if (isToday) return `${t('home.today')} ${time}`;
    if (isYesterday) return `${t('home.yesterday')} ${time}`;
    return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`;
  };

  // 获取操作的可读名称
  const getActionLabel = (action: string) => {
    const map: Record<string, string> = {
      'user.login': t('auditLog.login'),
      'user.login.failed': t('auditLog.loginFailed'),
      'user.logout': t('auditLog.logout'),
      'user.register': t('auditLog.register'),
      'user.password.change': t('auditLog.passwordChange'),
      'admin.settings.update': t('auditLog.settingsChange'),
      'admin.user.create': t('auditLog.userCreate'),
      'admin.user.delete': t('auditLog.userDelete'),
      'admin.llm.provider.create': t('auditLog.llmProviderCreate'),
      'admin.llm.provider.update': t('auditLog.llmProviderUpdate'),
      'admin.llm.provider.delete': t('auditLog.llmProviderDelete'),
      'system.start': t('auditLog.systemStart'),
    };
    return map[action] || action;
  };

  return (
    <div>
      {/* 顶部筛选栏 */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('auditLog.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                       placeholder:text-charcoal-400 focus:outline-none focus:ring-2 focus:ring-rust-300"
          />
        </div>

        {/* 操作类型筛选 */}
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-400 pointer-events-none" />
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="pl-9 pr-8 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                       focus:outline-none focus:ring-2 focus:ring-rust-300 appearance-none cursor-pointer"
          >
            {ACTION_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(f.label)}
              </option>
            ))}
          </select>
        </div>

        {/* 刷新按钮 */}
        <button
          onClick={() => fetchLogs(pagination.page)}
          disabled={loading}
          className="p-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-charcoal-500 hover:text-charcoal-700
                     hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-colors disabled:opacity-50"
          title={t('common.refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 日志列表 */}
      <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 overflow-x-auto">
        {/* 表头 */}
        <div className="grid grid-cols-[200px_1fr_160px_120px] gap-4 px-5 py-3 border-b border-cream-200 dark:border-charcoal-700 bg-cream-50 dark:bg-charcoal-750 min-w-[700px]">
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('auditLog.colAction')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('auditLog.colDetail')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('auditLog.colTime')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('auditLog.colIp')}
          </div>
        </div>

        {/* 日志行 */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <p className="text-charcoal-400 text-sm">{t('common.noData')}</p>
          </div>
        ) : (
          <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
            {logs.map((log) => {
              const meta = getActionMeta(log.action);
              const Icon = meta.icon;
              return (
                <div
                  key={log.id}
                  className="grid grid-cols-[200px_1fr_160px_120px] gap-4 px-5 py-3.5 hover:bg-cream-50/50 dark:hover:bg-charcoal-750/50 transition-colors min-w-[700px]"
                >
                  {/* 操作 + 用户 */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: meta.bg }}
                    >
                      <Icon className="w-4 h-4" style={{ color: meta.color }} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-charcoal-800 dark:text-cream-100 truncate">
                        {getActionLabel(log.action)}
                      </div>
                      {log.userName && (
                        <div className="text-xs text-charcoal-400 truncate">{log.userName}</div>
                      )}
                    </div>
                  </div>

                  {/* 详情 */}
                  <div className="flex items-center min-w-0">
                    <span className="text-sm text-charcoal-600 dark:text-charcoal-300 truncate">
                      {log.detail || '—'}
                    </span>
                  </div>

                  {/* 时间 */}
                  <div className="flex items-center">
                    <span className="text-sm text-charcoal-500 dark:text-charcoal-400 whitespace-nowrap">
                      {formatTime(log.createdAt)}
                    </span>
                  </div>

                  {/* IP */}
                  <div className="flex items-center">
                    <span className="text-sm text-charcoal-500 dark:text-charcoal-400 font-mono text-xs">
                      {log.ip || '—'}
                    </span>
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
              {t('auditLog.total', { n: pagination.total })}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fetchLogs(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-charcoal-600 dark:text-charcoal-300 px-2">
                {pagination.page} / {pagination.totalPages}
              </span>
              <button
                onClick={() => fetchLogs(pagination.page + 1)}
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
