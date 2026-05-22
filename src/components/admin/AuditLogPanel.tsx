'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Filter,
  LogIn,
  LogOut,
  UserPlus,
  UserMinus,
  UserCog,
  Users,
  KeyRound,
  Settings,
  Trash2,
  Server,
  Bot,
  Activity,
  Mic,
  MicOff,
  Share2,
  Eye,
  Headphones,
  FileText,
  ClipboardList,
  FileX2,
  Cloud,
  HardDrive,
  ArrowRightLeft,
  Coins,
  RotateCw,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import CleanupModalShell from '@/components/admin/CleanupModalShell';
import { AUDIT_LOG_CATEGORIES, type AuditLogCategory } from '@/lib/adminCleanup';

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

// 颜色板：使用统一的 token 简化映射
const PALETTE = {
  green:  { color: '#059669', bg: '#d1fae5' },
  amber:  { color: '#d97706', bg: '#fef3c7' },
  blue:   { color: '#2563eb', bg: '#dbeafe' },
  violet: { color: '#7c3aed', bg: '#ede9fe' },
  purple: { color: '#8b5cf6', bg: '#f3e8ff' },
  red:    { color: '#dc2626', bg: '#fee2e2' },
  gray:   { color: '#6b7280', bg: '#f3f4f6' },
  cyan:   { color: '#0891b2', bg: '#cffafe' },
  indigo: { color: '#4f46e5', bg: '#e0e7ff' },
  teal:   { color: '#0d9488', bg: '#ccfbf1' },
  orange: { color: '#ea580c', bg: '#ffedd5' },
  slate:  { color: '#475569', bg: '#f1f5f9' },
} as const;

type Tone = keyof typeof PALETTE;

interface ActionDef {
  icon: typeof LogIn;
  tone: Tone;
  labelKey: string;
}

// 单一数据源：每种 action → icon / 颜色 / i18n key
const ACTION_DEFS: Record<string, ActionDef> = {
  // 会话生命周期（保留即使尚未写入，作为历史/未来兼容）
  'session.create':                  { icon: Mic,            tone: 'green',  labelKey: 'auditLog.sessionCreate' },
  'session.finalize':                { icon: MicOff,         tone: 'amber',  labelKey: 'auditLog.sessionFinalize' },

  // 分享
  'share.create':                    { icon: Share2,         tone: 'blue',   labelKey: 'auditLog.shareCreate' },
  'share.revoke':                    { icon: Share2,         tone: 'red',    labelKey: 'auditLog.shareRevoke' },
  'share.view':                      { icon: Eye,            tone: 'purple', labelKey: 'auditLog.shareView' },
  'share.transition_playback':       { icon: Share2,         tone: 'cyan',   labelKey: 'auditLog.shareTransitionPlayback' },

  // 用户账号
  'user.login':                      { icon: LogIn,          tone: 'green',  labelKey: 'auditLog.login' },
  'user.login.failed':               { icon: LogIn,          tone: 'amber',  labelKey: 'auditLog.loginFailed' },
  'user.logout':                     { icon: LogOut,         tone: 'gray',   labelKey: 'auditLog.logout' },
  'user.register':                   { icon: UserPlus,       tone: 'blue',   labelKey: 'auditLog.register' },
  'user.password.change':            { icon: KeyRound,       tone: 'violet', labelKey: 'auditLog.passwordChange' },

  // Admin 跨用户读取（敏感操作 — 全部用 amber 警示色）
  'admin.session.read':              { icon: Eye,            tone: 'amber',  labelKey: 'auditLog.adminSessionRead' },
  'admin.session.audio.read':        { icon: Headphones,     tone: 'amber',  labelKey: 'auditLog.adminSessionAudioRead' },
  'admin.session.transcript.read':   { icon: FileText,       tone: 'amber',  labelKey: 'auditLog.adminSessionTranscriptRead' },
  'admin.session.report.read':       { icon: ClipboardList,  tone: 'amber',  labelKey: 'auditLog.adminSessionReportRead' },

  // 用户管理
  'admin.user.create':               { icon: UserPlus,       tone: 'blue',   labelKey: 'auditLog.userCreate' },
  'admin.user.update':               { icon: UserCog,        tone: 'blue',   labelKey: 'auditLog.userUpdate' },
  'admin.user.delete':               { icon: UserMinus,      tone: 'red',    labelKey: 'auditLog.userDelete' },

  // 用户组管理
  'admin.group.create':              { icon: Users,          tone: 'indigo', labelKey: 'auditLog.groupCreate' },
  'admin.group.update':              { icon: Users,          tone: 'indigo', labelKey: 'auditLog.groupUpdate' },
  'admin.group.delete':              { icon: Users,          tone: 'red',    labelKey: 'auditLog.groupDelete' },

  // 设置
  'admin.settings.update':           { icon: Settings,       tone: 'cyan',   labelKey: 'auditLog.settingsChange' },

  // LLM 供应商
  'admin.llm.provider.create':       { icon: Bot,            tone: 'violet', labelKey: 'auditLog.llmProviderCreate' },
  'admin.llm.provider.update':       { icon: Bot,            tone: 'violet', labelKey: 'auditLog.llmProviderUpdate' },
  'admin.llm.provider.delete':       { icon: Bot,            tone: 'red',    labelKey: 'auditLog.llmProviderDelete' },

  // 文件 / 分享 / 存储
  'admin.files.delete':              { icon: FileX2,         tone: 'red',    labelKey: 'auditLog.filesDelete' },
  'admin.share.delete':              { icon: Share2,         tone: 'red',    labelKey: 'auditLog.shareDelete' },
  'admin.cloudreve.revoke':          { icon: Cloud,          tone: 'red',    labelKey: 'auditLog.cloudreveRevoke' },
  'admin.cloudreve.refresh.success': { icon: Cloud,          tone: 'green',  labelKey: 'auditLog.cloudreveRefreshSuccess' },
  'admin.cloudreve.refresh.failed':  { icon: Cloud,          tone: 'red',    labelKey: 'auditLog.cloudreveRefreshFailed' },
  'admin.cloudreve.token.decrypt_failed': { icon: KeyRound,  tone: 'red',    labelKey: 'auditLog.cloudreveTokenDecryptFailed' },
  'admin.storage.cleanup':           { icon: HardDrive,      tone: 'gray',   labelKey: 'auditLog.storageCleanup' },
  'admin.storage.migrate':           { icon: ArrowRightLeft, tone: 'cyan',   labelKey: 'auditLog.storageMigrate' },

  // 对账
  'admin.reconciliation.run':        { icon: Coins,          tone: 'teal',   labelKey: 'auditLog.reconciliationRun' },
  'admin.reconciliation.fix':        { icon: Coins,          tone: 'teal',   labelKey: 'auditLog.reconciliationFix' },
  'admin.reconciliation.fixAll':     { icon: Coins,          tone: 'teal',   labelKey: 'auditLog.reconciliationFixAll' },

  // 任务队列
  'admin.job.retry':                 { icon: RotateCw,       tone: 'orange', labelKey: 'auditLog.jobRetry' },
  'admin.job.cleanup':               { icon: Trash2,         tone: 'gray',   labelKey: 'auditLog.jobCleanup' },

  // 审计日志清理
  'admin.auditlog.cleanup':          { icon: Trash2,         tone: 'gray',   labelKey: 'auditLog.auditLogCleanup' },

  // 系统
  'system.start':                    { icon: Server,         tone: 'slate',  labelKey: 'auditLog.systemStart' },
};

const FALLBACK_DEF: ActionDef = {
  icon: Activity,
  tone: 'slate',
  labelKey: '',
};

function getActionDef(action: string): ActionDef {
  return ACTION_DEFS[action] ?? FALLBACK_DEF;
}

// 操作类型筛选选项（按前缀分组，便于一次过滤同类操作）
const ACTION_FILTERS = [
  { value: '', label: 'auditLog.allActions' },
  { value: 'user.login', label: 'auditLog.login' },
  { value: 'user.logout', label: 'auditLog.logout' },
  { value: 'user.register', label: 'auditLog.register' },
  { value: 'user.password', label: 'auditLog.passwordChange' },
  { value: 'share', label: 'auditLog.share' },
  { value: 'admin.session', label: 'auditLog.adminSessionAccess' },
  { value: 'admin.user', label: 'auditLog.userManage' },
  { value: 'admin.group', label: 'auditLog.groupManage' },
  { value: 'admin.settings', label: 'auditLog.settingsChange' },
  { value: 'admin.llm', label: 'auditLog.llmManage' },
  { value: 'admin.files', label: 'auditLog.filesDelete' },
  { value: 'admin.share', label: 'auditLog.shareDelete' },
  { value: 'admin.cloudreve', label: 'auditLog.cloudreveRevoke' },
  { value: 'admin.storage', label: 'auditLog.storageManage' },
  { value: 'admin.reconciliation', label: 'auditLog.reconciliationManage' },
  { value: 'admin.job', label: 'auditLog.jobRetry' },
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
  const [showCleanup, setShowCleanup] = useState(false);

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
    const def = ACTION_DEFS[action];
    return def ? t(def.labelKey) : action;
  };

  return (
    <div>
      <h2 className="text-xl md:text-2xl font-serif font-bold text-charcoal-800 dark:text-cream-100 mb-5">
        {t('nav.logs')}
      </h2>

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
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-charcoal-400 pointer-events-none" />
        </div>

        {/* 刷新按钮 */}
        <button
          onClick={() => fetchLogs(pagination.page)}
          disabled={loading}
          className="p-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-charcoal-500 hover:text-charcoal-700
                     hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-all duration-150
                     disabled:opacity-50 hover:scale-105 active:scale-95"
          title={t('common.refresh')}
        >
          <RefreshCw className={`w-4 h-4 transition-transform duration-300 ${loading ? 'animate-spin' : ''}`} />
        </button>

        {/* 清理按钮 */}
        <button
          onClick={() => setShowCleanup(true)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-charcoal-600 dark:text-cream-200 hover:text-charcoal-800
                     hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-all duration-150 text-sm font-medium
                     hover:scale-[1.02] active:scale-95"
          title={t('auditLog.cleanup')}
        >
          <Trash2 className="w-4 h-4" />
          {t('auditLog.cleanup')}
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
            {logs.map((log, idx) => {
              const def = getActionDef(log.action);
              const meta = PALETTE[def.tone];
              const Icon = def.icon;
              return (
                <div
                  key={log.id}
                  style={{ animationDelay: `${Math.min(idx * 25, 250)}ms` }}
                  className="grid grid-cols-[200px_1fr_160px_120px] gap-4 px-5 py-3.5
                             hover:bg-cream-50/60 dark:hover:bg-charcoal-750/60
                             transition-all duration-200 min-w-[700px]
                             animate-fade-in-up"
                >
                  {/* 操作 + 用户 */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0
                                 transition-transform duration-200 group-hover:scale-110"
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
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 hover:scale-110 active:scale-95"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-charcoal-600 dark:text-charcoal-300 px-2">
                {pagination.page} / {pagination.totalPages}
              </span>
              <button
                onClick={() => fetchLogs(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
                className="p-1.5 rounded-md text-charcoal-500 hover:bg-cream-100 dark:hover:bg-charcoal-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 hover:scale-110 active:scale-95"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {showCleanup && (
        <AuditLogCleanupModal
          token={token}
          onClose={() => setShowCleanup(false)}
          onCleaned={() => fetchLogs(1)}
        />
      )}
    </div>
  );
}

// ────────── 清理弹窗 ──────────

const DAY_OPTIONS = [30, 60, 90, 180] as const;

const CATEGORY_LABEL_KEYS: Record<AuditLogCategory, string> = {
  session: 'auditLog.cleanupCategorySession',
  share: 'auditLog.cleanupCategoryShare',
  login: 'auditLog.cleanupCategoryLogin',
  system: 'auditLog.cleanupCategorySystem',
};

function AuditLogCleanupModal({
  token,
  onClose,
  onCleaned,
}: {
  token: string | null;
  onClose: () => void;
  onCleaned: () => void;
}) {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Set<AuditLogCategory>>(
    new Set(AUDIT_LOG_CATEGORIES)
  );
  const [olderThanDays, setOlderThanDays] = useState<number>(DAY_OPTIONS[2]);

  const buildParams = useCallback(() => {
    const sp = new URLSearchParams();
    for (const c of categories) sp.append('actionCategories', c);
    sp.set('olderThanDays', String(olderThanDays));
    return sp;
  }, [categories, olderThanDays]);

  const formSignature = useMemo(
    () => `${[...categories].sort().join(',')}|${olderThanDays}`,
    [categories, olderThanDays],
  );

  const toggleCategory = (cat: AuditLogCategory) => {
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <CleanupModalShell
      title={t('auditLog.cleanupDialogTitle')}
      warning={t('auditLog.cleanupDialogWarning')}
      endpoint="/api/admin/logs"
      token={token}
      buildParams={buildParams}
      formSignature={formSignature}
      canSubmit={categories.size > 0}
      confirmDialogTitle={t('auditLog.cleanupDialogConfirmTitle')}
      confirmDialogMessage={t('auditLog.cleanupDialogConfirmMessage')}
      successTitle={(n) => t('auditLog.cleanupSuccess', { n })}
      failureTitle={t('auditLog.cleanupFailed')}
      previewErrorTitle={t('auditLog.cleanupDialogPreviewError')}
      onClose={onClose}
      onCleaned={onCleaned}
    >
      <div>
        <label className="text-xs font-semibold text-charcoal-600 dark:text-charcoal-300 uppercase tracking-wider mb-2 block">
          {t('auditLog.cleanupDialogCategories')}
        </label>
        <div className="space-y-1.5">
          {AUDIT_LOG_CATEGORIES.map((cat) => (
            <label
              key={cat}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600 cursor-pointer hover:bg-cream-50 dark:hover:bg-charcoal-700/50 transition-colors"
            >
              <input
                type="checkbox"
                checked={categories.has(cat)}
                onChange={() => toggleCategory(cat)}
                className="w-4 h-4 rounded text-rust-500 focus:ring-rust-300 focus:ring-2"
              />
              <span className="text-sm text-charcoal-700 dark:text-cream-200">
                {t(CATEGORY_LABEL_KEYS[cat])}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-charcoal-600 dark:text-charcoal-300 uppercase tracking-wider mb-2 block">
          {t('admin.cleanup.olderThan')}
        </label>
        <select
          value={olderThanDays}
          onChange={(e) => setOlderThanDays(Number(e.target.value))}
          className="w-full px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-sm text-charcoal-700 dark:text-cream-200
                     focus:outline-none focus:ring-2 focus:ring-rust-300 cursor-pointer"
        >
          {DAY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {t('admin.cleanup.days', { n: d })}
            </option>
          ))}
        </select>
      </div>
    </CleanupModalShell>
  );
}
