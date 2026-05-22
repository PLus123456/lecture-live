'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Search,
  Trash2,
  Loader2,
  Image as ImageIcon,
  FileText,
  File,
  Paperclip,
  Save,
  ChevronDown,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import ConfirmDialog from '@/components/ConfirmDialog';
import CleanupModalShell from '@/components/admin/CleanupModalShell';

/**
 * Chat Files 管理面板。
 *
 * 包含两块：
 *  (a) 顶部 Settings 区 —— 6 个 SiteSetting 数值字段，PATCH 到
 *      `/api/admin/settings`（PUT，整页保存）。
 *  (b) 下面的附件列表 + 过滤 + 单删 / 批量清理。批量清理走 CleanupModalShell
 *      (DELETE + querystring 模板)。
 */

interface ChatFileRow {
  id: string;
  conversationId: string;
  userId: string;
  userEmail: string | null;
  userDisplayName: string | null;
  kind: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
  lastAccessedAt: string;
}

interface SettingsData {
  chat_files_retention_days: string;
  chat_files_soft_cap_percent: string;
  chat_files_max_upload_mb: string;
  chat_files_quota_free_mb: string;
  chat_files_quota_pro_mb: string;
  chat_files_quota_admin_mb: string;
}

const DEFAULT_SETTINGS: SettingsData = {
  chat_files_retention_days: '14',
  chat_files_soft_cap_percent: '90',
  chat_files_max_upload_mb: '100',
  chat_files_quota_free_mb: '100',
  chat_files_quota_pro_mb: '1024',
  chat_files_quota_admin_mb: '10240',
};

const KIND_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'image', labelKey: 'adminChatFiles.kindImage' },
  { value: 'document', labelKey: 'adminChatFiles.kindDocument' },
  { value: 'text', labelKey: 'adminChatFiles.kindText' },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  return `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${time}`;
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'image') return <ImageIcon className="w-4 h-4 text-purple-500" />;
  if (kind === 'document') return <FileText className="w-4 h-4 text-sky-500" />;
  if (kind === 'text') return <File className="w-4 h-4 text-emerald-500" />;
  return <File className="w-4 h-4 text-charcoal-400" />;
}

export default function ChatFilesPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  // ── Settings 区状态 ──
  const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
  const [initialSettings, setInitialSettings] =
    useState<SettingsData>(DEFAULT_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  // ── 列表区状态 ──
  const [files, setFiles] = useState<ChatFileRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [userFilter, setUserFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [conversationFilter, setConversationFilter] = useState('');
  const [ageFilter, setAgeFilter] = useState<string>(''); // 天数
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatFileRow | null>(null);
  const [showCleanup, setShowCleanup] = useState(false);

  // 注意：每次 render 重建 headers 字面量是廉价的，但 fetchFiles / loadSettings
  // 用 useCallback 缓存时需要稳定的引用 — 因此我们直接闭包 token，避免把
  // headers 当依赖。fetch 调用处用 `buildHeaders()` 现场构造。
  const buildHeaders = useCallback((): Record<string, string> => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  // ─── 加载 Settings ──────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await fetch('/api/admin/settings', { headers: buildHeaders() });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        // 后端返回的可能是 string（serializeSiteSettingsForAdmin）或 number；
        // 统一转 string 喂给 <input>。任一字段缺失时回落默认。
        const next = (Object.keys(DEFAULT_SETTINGS) as Array<keyof SettingsData>).reduce(
          (acc, key) => {
            const raw = data[key];
            acc[key] = raw == null ? DEFAULT_SETTINGS[key] : String(raw);
            return acc;
          },
          { ...DEFAULT_SETTINGS }
        );
        setSettings(next);
        setInitialSettings(next);
      } else {
        toast.error(t('adminChatFiles.loadSettingsFailed'));
      }
    } catch {
      toast.error(t('adminChatFiles.loadSettingsFailed'), t('common.networkError'));
    } finally {
      setSettingsLoading(false);
    }
  }, [buildHeaders, t]);

  // ─── 加载列表 ───────────────────────────────────────────────
  const fetchFiles = useCallback(
    async (cursor?: string | null, append = false) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (userFilter) params.set('userId', userFilter);
        if (kindFilter) params.set('kind', kindFilter);
        if (conversationFilter) params.set('conversationId', conversationFilter);
        if (ageFilter) params.set('olderThanDays', ageFilter);
        if (cursor) params.set('cursor', cursor);

        const res = await fetch(`/api/admin/chat-files?${params}`, { headers: buildHeaders() });
        if (res.ok) {
          const data = await res.json();
          setFiles((prev) =>
            append ? [...prev, ...(data.items ?? [])] : data.items ?? []
          );
          setHasMore(Boolean(data.hasMore));
          setNextCursor(data.nextCursor ?? null);
        } else {
          const err = await res.json().catch(() => null);
          toast.error(t('common.networkError'), err?.error);
        }
      } catch {
        toast.error(t('common.networkError'));
      } finally {
        setLoading(false);
      }
    },
    [buildHeaders, userFilter, kindFilter, conversationFilter, ageFilter, t]
  );

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    fetchFiles(null, false);
  }, [fetchFiles]);

  // ─── Settings 字段变更 + 保存 ──────────────────────────────
  const onSettingsChange = (key: keyof SettingsData, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const settingsDirty = useMemo(
    () =>
      (Object.keys(settings) as Array<keyof SettingsData>).some(
        (k) => settings[k] !== initialSettings[k]
      ),
    [settings, initialSettings]
  );

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      // 整页保存：每个字段都转成 Number 交给 PUT；admin/settings PUT 已经做了
      // 白名单 + 类型校验。
      const payload = (Object.keys(settings) as Array<keyof SettingsData>).reduce(
        (acc, key) => {
          acc[key] = Number(settings[key]);
          return acc;
        },
        {} as Record<keyof SettingsData, number>
      );
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setInitialSettings(settings);
        toast.success(t('common.saveSuccess'));
      } else {
        const err = await res.json().catch(() => null);
        toast.error(t('common.saveFailed'), err?.error);
      }
    } catch {
      toast.error(t('common.saveFailed'), t('common.networkError'));
    } finally {
      setSavingSettings(false);
    }
  };

  // ─── 单删 ───────────────────────────────────────────────────
  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    setDeletingId(target.id);
    try {
      const res = await fetch(`/api/admin/chat-files/${target.id}`, {
        method: 'DELETE',
        headers: buildHeaders(),
      });
      if (res.ok) {
        toast.success(t('common.deleteSuccess'));
        setFiles((prev) => prev.filter((f) => f.id !== target.id));
      } else {
        const err = await res.json().catch(() => null);
        toast.error(t('common.deleteFailed'), err?.error);
      }
    } catch {
      toast.error(t('common.deleteFailed'), t('common.networkError'));
    } finally {
      setDeletingId(null);
    }
  };

  // ─── UI ────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in">
      <div className="mb-5">
        <h2 className="text-xl md:text-2xl font-serif font-bold text-charcoal-800 dark:text-cream-100">
          {t('adminChatFiles.title')}
        </h2>
        <p className="text-sm text-charcoal-500 dark:text-charcoal-400 mt-1">
          {t('adminChatFiles.description')}
        </p>
      </div>

      {/* ─── (a) Settings 区 ─── */}
      <section className="mb-6 bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-charcoal-700 dark:text-cream-200">
            {t('adminChatFiles.settingsTitle')}
          </h3>
          <button
            onClick={handleSaveSettings}
            disabled={!settingsDirty || savingSettings || settingsLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium
                       bg-rust-500 text-white hover:bg-rust-600 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingSettings ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            {t('common.save')}
          </button>
        </div>

        {settingsLoading ? (
          <div className="flex items-center gap-2 text-sm text-charcoal-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingField
              label={t('adminChatFiles.retentionDays')}
              description={t('adminChatFiles.retentionDaysDesc')}
              suffix={t('adminChatFiles.unitDays')}
              value={settings.chat_files_retention_days}
              onChange={(v) => onSettingsChange('chat_files_retention_days', v)}
              min={0}
              max={365}
            />
            <SettingField
              label={t('adminChatFiles.softCapPercent')}
              description={t('adminChatFiles.softCapPercentDesc')}
              suffix="%"
              value={settings.chat_files_soft_cap_percent}
              onChange={(v) => onSettingsChange('chat_files_soft_cap_percent', v)}
              min={0}
              max={100}
            />
            <SettingField
              label={t('adminChatFiles.maxUploadMb')}
              description={t('adminChatFiles.maxUploadMbDesc')}
              suffix="MB"
              value={settings.chat_files_max_upload_mb}
              onChange={(v) => onSettingsChange('chat_files_max_upload_mb', v)}
              min={1}
              max={10240}
            />
            <SettingField
              label={t('adminChatFiles.quotaFreeMb')}
              description={t('adminChatFiles.quotaFreeMbDesc')}
              suffix="MB"
              value={settings.chat_files_quota_free_mb}
              onChange={(v) => onSettingsChange('chat_files_quota_free_mb', v)}
              min={0}
            />
            <SettingField
              label={t('adminChatFiles.quotaProMb')}
              description={t('adminChatFiles.quotaProMbDesc')}
              suffix="MB"
              value={settings.chat_files_quota_pro_mb}
              onChange={(v) => onSettingsChange('chat_files_quota_pro_mb', v)}
              min={0}
            />
            <SettingField
              label={t('adminChatFiles.quotaAdminMb')}
              description={t('adminChatFiles.quotaAdminMbDesc')}
              suffix="MB"
              value={settings.chat_files_quota_admin_mb}
              onChange={(v) => onSettingsChange('chat_files_quota_admin_mb', v)}
              min={0}
            />
          </div>
        )}
      </section>

      {/* ─── (b) 列表区 ─── */}
      <section className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700">
        {/* 过滤栏 */}
        <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-cream-200 dark:border-charcoal-700">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-400" />
            <input
              type="text"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              placeholder={t('adminChatFiles.searchUserPlaceholder')}
              className="w-full pl-9 pr-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                         bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                         placeholder:text-charcoal-400 focus:outline-none focus:ring-2 focus:ring-rust-300"
            />
          </div>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-700 dark:text-cream-200
                       focus:outline-none focus:ring-2 focus:ring-rust-300 cursor-pointer"
          >
            <option value="">{t('adminChatFiles.allKinds')}</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {t(k.labelKey)}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={conversationFilter}
            onChange={(e) => setConversationFilter(e.target.value)}
            placeholder={t('adminChatFiles.conversationIdPlaceholder')}
            className="min-w-[160px] flex-1 max-w-[220px] px-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                       placeholder:text-charcoal-400 focus:outline-none focus:ring-2 focus:ring-rust-300"
          />
          <input
            type="number"
            min={0}
            max={365}
            value={ageFilter}
            onChange={(e) => setAgeFilter(e.target.value)}
            placeholder={t('adminChatFiles.olderThanDaysPlaceholder')}
            className="w-32 px-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                       bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                       placeholder:text-charcoal-400 focus:outline-none focus:ring-2 focus:ring-rust-300"
          />
          <button
            onClick={() => fetchFiles(null, false)}
            disabled={loading}
            className="p-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                       bg-white dark:bg-charcoal-800 text-charcoal-500 hover:text-charcoal-700
                       hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-colors
                       disabled:opacity-50"
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setShowCleanup(true)}
            className="inline-flex items-center gap-1.5 ml-auto px-3 py-2 rounded-lg text-sm font-medium
                       border border-cream-200 dark:border-charcoal-600
                       bg-white dark:bg-charcoal-800 text-charcoal-700 dark:text-cream-200
                       hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t('adminChatFiles.batchCleanup')}
          </button>
        </div>

        {/* 表头 */}
        <div className="grid grid-cols-[40px_minmax(220px,2fr)_90px_100px_minmax(160px,1.2fr)_130px_140px_120px_60px] gap-3 px-5 py-3 border-b border-cream-200 dark:border-charcoal-700 bg-cream-50 dark:bg-charcoal-750 min-w-[1100px]">
          <div />
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminChatFiles.colFileName')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminChatFiles.colKind')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminChatFiles.colBytes')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminChatFiles.colUser')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminChatFiles.colConversation')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminChatFiles.colCreated')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
            {t('adminChatFiles.colLastAccessed')}
          </div>
          <div className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider text-right">
            {t('shareLinks.colActions')}
          </div>
        </div>

        {/* 内容 */}
        <div className="overflow-x-auto">
          {loading && files.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 text-charcoal-400 animate-spin mr-2" />
              <span className="text-charcoal-400 text-sm">{t('common.loading')}</span>
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Paperclip className="w-10 h-10 text-charcoal-300 mb-3" />
              <p className="text-charcoal-600 dark:text-charcoal-300 font-medium">
                {t('adminChatFiles.noFiles')}
              </p>
              <p className="text-charcoal-400 text-sm mt-1">
                {t('adminChatFiles.noFilesDesc')}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-cream-100 dark:divide-charcoal-700 min-w-[1100px]">
              {files.map((file) => {
                const isDeleting = deletingId === file.id;
                return (
                  <div
                    key={file.id}
                    className={`grid grid-cols-[40px_minmax(220px,2fr)_90px_100px_minmax(160px,1.2fr)_130px_140px_120px_60px] gap-3 px-5 py-3 items-center
                                hover:bg-cream-50/60 dark:hover:bg-charcoal-750/60 transition-colors
                                ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <div className="flex items-center justify-center">
                      <KindIcon kind={file.kind} />
                    </div>
                    <div className="min-w-0">
                      <div
                        className="text-sm font-medium text-charcoal-800 dark:text-cream-100 truncate"
                        title={file.fileName}
                      >
                        {file.fileName}
                      </div>
                      <div className="text-[11px] text-charcoal-400 truncate">
                        {file.mimeType}
                      </div>
                    </div>
                    <div className="text-xs uppercase tracking-wide text-charcoal-500">
                      {file.kind}
                    </div>
                    <div className="text-sm text-charcoal-600 dark:text-charcoal-300 font-mono tabular-nums">
                      {formatBytes(file.bytes)}
                    </div>
                    <div className="min-w-0 text-sm" title={file.userEmail ?? file.userId}>
                      <div className="text-charcoal-700 dark:text-cream-200 truncate">
                        {file.userDisplayName ?? '—'}
                      </div>
                      <div className="text-[11px] text-charcoal-400 truncate">
                        {file.userEmail ?? file.userId}
                      </div>
                    </div>
                    <div
                      className="font-mono text-xs text-charcoal-500 truncate"
                      title={file.conversationId}
                    >
                      {file.conversationId.slice(0, 6)}…
                    </div>
                    <div className="text-xs text-charcoal-500 whitespace-nowrap">
                      {formatDateTime(file.createdAt)}
                    </div>
                    <div className="text-xs text-charcoal-500 whitespace-nowrap">
                      {formatDateTime(file.lastAccessedAt)}
                    </div>
                    <div className="flex items-center justify-end">
                      <button
                        onClick={() => setPendingDelete(file)}
                        disabled={isDeleting}
                        className="p-1.5 rounded-md text-rust-500 hover:text-rust-700
                                   hover:bg-rust-50 dark:hover:bg-rust-900/30 transition-colors
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
                );
              })}
            </div>
          )}
        </div>

        {/* Load more */}
        {hasMore && (
          <div className="flex items-center justify-center px-5 py-3 border-t border-cream-200 dark:border-charcoal-700">
            <button
              onClick={() => fetchFiles(nextCursor, true)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg
                         border border-cream-200 dark:border-charcoal-600
                         text-charcoal-700 dark:text-cream-200 hover:bg-cream-50 dark:hover:bg-charcoal-700
                         transition-colors disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
              {t('adminChatFiles.loadMore')}
            </button>
          </div>
        )}
      </section>

      {/* 删除单条确认 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={t('adminChatFiles.deleteConfirmTitle')}
        message={
          pendingDelete
            ? t('adminChatFiles.deleteConfirmMessage', {
                file: pendingDelete.fileName,
              })
            : ''
        }
        confirmText={t('common.delete')}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* 批量清理弹窗 */}
      {showCleanup && (
        <ChatFilesCleanupModal
          token={token}
          onClose={() => setShowCleanup(false)}
          onCleaned={() => fetchFiles(null, false)}
        />
      )}
    </div>
  );
}

// ─── Settings 输入字段 ────────────────────────────────────────
function SettingField({
  label,
  description,
  suffix,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  description: string;
  suffix?: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-charcoal-600 dark:text-charcoal-300 mb-1">
        {label}
      </label>
      <p className="text-[11px] text-charcoal-400 mb-2 leading-snug">{description}</p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 px-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg
                     bg-white dark:bg-charcoal-800 text-charcoal-800 dark:text-cream-100
                     focus:outline-none focus:ring-2 focus:ring-rust-300"
        />
        {suffix && (
          <span className="text-xs text-charcoal-500 whitespace-nowrap">{suffix}</span>
        )}
      </div>
    </div>
  );
}

// ─── 批量清理弹窗 ─────────────────────────────────────────────
function ChatFilesCleanupModal({
  token,
  onClose,
  onCleaned,
}: {
  token: string | null;
  onClose: () => void;
  onCleaned: () => void;
}) {
  const { t } = useI18n();
  const [olderThanDays, setOlderThanDays] = useState(14);
  const [sizeBytesGT, setSizeBytesGT] = useState(0);
  const [kinds, setKinds] = useState<Set<string>>(new Set());

  const toggleKind = (k: string) => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const buildParams = useCallback(() => {
    const sp = new URLSearchParams();
    sp.set('olderThanDays', String(olderThanDays));
    if (sizeBytesGT > 0) sp.set('sizeBytesGT', String(sizeBytesGT));
    for (const k of kinds) sp.append('kinds', k);
    return sp;
  }, [olderThanDays, sizeBytesGT, kinds]);

  const formSignature = useMemo(
    () => `${olderThanDays}|${sizeBytesGT}|${[...kinds].sort().join(',')}`,
    [olderThanDays, sizeBytesGT, kinds]
  );

  const canSubmit = olderThanDays >= 1 && olderThanDays <= 365;

  return (
    <CleanupModalShell
      title={t('adminChatFiles.cleanupTitle')}
      warning={t('adminChatFiles.cleanupWarning')}
      endpoint="/api/admin/chat-files"
      token={token}
      buildParams={buildParams}
      formSignature={formSignature}
      canSubmit={canSubmit}
      confirmDialogTitle={t('adminChatFiles.cleanupConfirmTitle')}
      confirmDialogMessage={t('adminChatFiles.cleanupConfirmMessage')}
      successTitle={(n) => t('adminChatFiles.cleanupSuccess', { n })}
      failureTitle={t('adminChatFiles.cleanupFailed')}
      previewErrorTitle={t('adminChatFiles.cleanupPreviewError')}
      onClose={onClose}
      onCleaned={onCleaned}
    >
      <div>
        <label className="text-xs font-semibold text-charcoal-600 dark:text-charcoal-300 uppercase tracking-wider mb-2 block">
          {t('adminChatFiles.cleanupOlderThanDays')}
        </label>
        <input
          type="number"
          min={1}
          max={365}
          value={olderThanDays}
          onChange={(e) => setOlderThanDays(Number(e.target.value) || 0)}
          className="w-full px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-sm text-charcoal-700 dark:text-cream-200
                     focus:outline-none focus:ring-2 focus:ring-rust-300"
        />
      </div>

      <div>
        <label className="text-xs font-semibold text-charcoal-600 dark:text-charcoal-300 uppercase tracking-wider mb-2 block">
          {t('adminChatFiles.cleanupSizeBytesGT')}
        </label>
        <input
          type="number"
          min={0}
          value={sizeBytesGT}
          onChange={(e) =>
            setSizeBytesGT(Math.max(0, Math.floor(Number(e.target.value) || 0)))
          }
          placeholder="0"
          className="w-full px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600
                     bg-white dark:bg-charcoal-800 text-sm text-charcoal-700 dark:text-cream-200
                     focus:outline-none focus:ring-2 focus:ring-rust-300"
        />
        <p className="text-[11px] text-charcoal-400 mt-1">
          {t('adminChatFiles.cleanupSizeBytesGTHint')}
        </p>
      </div>

      <div>
        <label className="text-xs font-semibold text-charcoal-600 dark:text-charcoal-300 uppercase tracking-wider mb-2 block">
          {t('adminChatFiles.cleanupKinds')}
        </label>
        <div className="space-y-1.5">
          {KIND_OPTIONS.map((k) => (
            <label
              key={k.value}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cream-200 dark:border-charcoal-600 cursor-pointer hover:bg-cream-50 dark:hover:bg-charcoal-700/50 transition-colors"
            >
              <input
                type="checkbox"
                checked={kinds.has(k.value)}
                onChange={() => toggleKind(k.value)}
                className="w-4 h-4 rounded text-rust-500 focus:ring-rust-300 focus:ring-2"
              />
              <span className="text-sm text-charcoal-700 dark:text-cream-200">
                {t(k.labelKey)}
              </span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-charcoal-400 mt-1">
          {t('adminChatFiles.cleanupKindsHint')}
        </p>
      </div>
    </CleanupModalShell>
  );
}
