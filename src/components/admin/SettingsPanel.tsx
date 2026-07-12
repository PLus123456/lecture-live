'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  Globe,
  UserPlus,
  Mail,
  HardDrive,
  Palette,
  Server,
  Shield,
  Cpu,
  Save,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Upload,
  Image as ImageIcon,
  AudioLines,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import ConfirmDialog from '@/components/ConfirmDialog';
import LlmSettingsPanel from '@/components/admin/LlmSettingsPanel';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';

// ──── 类型定义 ────

type SettingsTab =
  | 'site'
  | 'registration'
  | 'email'
  | 'storage'
  | 'appearance'
  | 'asr'
  | 'audioEnhance'
  | 'llm'
  | 'security';

/** 站点设置（从后端 /api/admin/settings 加载） */
interface SiteSettingsData {
  site_name: string;
  site_description: string;
  site_url: string;
  site_url_backups: string[];
  footer_code: string;
  site_announcement: string;
  terms_url: string;
  privacy_url: string;
  logo_path: string;
  favicon_path: string;
  icon_medium_path: string;
  icon_large_path: string;
  // 注册相关
  allow_registration: boolean;
  default_group: string;
  email_verification: boolean;
  password_min_length: string;
  // 邮件相关
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_password: string;
  sender_name: string;
  sender_email: string;
  // 存储相关
  storage_mode: string;
  cloudreve_url: string;
  cloudreve_client_id: string;
  cloudreve_client_secret: string;
  local_path: string;
  max_file_size: string;
  local_retention_days: string;
  // 外观相关
  theme: string;
  language: string;
  // ASR 相关
  default_region: string;
  default_source_lang: string;
  default_target_lang: string;
  translation_mode: string;
  async_upload_billing_multiplier: string;
  // 录音音频增强（外部 worker 后处理）
  audio_enhance_enabled: boolean;
  audio_enhance_worker_url: string;
  audio_enhance_worker_token: string;
  audio_enhance_target_lufs: string;
  audio_enhance_atten_lim_db: string;
  audio_enhance_concurrency: string;
  // 安全相关
  rate_limit_auth: string;
  rate_limit_api: string;
  jwt_expiry: string;
  bcrypt_rounds: string;
  [key: string]: string | boolean | string[];
}

const MAX_BACKUP_URLS = 10;

// 标签页配置
const settingsTabs: { id: SettingsTab; label: string; icon: typeof Globe }[] = [
  { id: 'site', label: 'Site Info', icon: Globe },
  { id: 'registration', label: 'Registration', icon: UserPlus },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'asr', label: 'ASR', icon: Cpu },
  { id: 'audioEnhance', label: 'Audio Enhance', icon: AudioLines },
  { id: 'llm', label: 'LLM', icon: Server },
  { id: 'security', label: 'Security', icon: Shield },
];

const SETTINGS_TAB_IDS: SettingsTab[] = settingsTabs.map((t) => t.id);
const isSettingsTab = (v: string | null): v is SettingsTab =>
  v !== null && (SETTINGS_TAB_IDS as string[]).includes(v);

// 站点设置默认值
const defaultSettings: SiteSettingsData = {
  site_name: 'LectureLive',
  site_description: '',
  site_url: 'http://localhost:3000',
  site_url_backups: [],
  footer_code: '',
  site_announcement: '',
  terms_url: '/terms',
  privacy_url: '/privacy',
  logo_path: '',
  favicon_path: '',
  icon_medium_path: '',
  icon_large_path: '',
  allow_registration: true,
  default_group: 'FREE',
  email_verification: false,
  password_min_length: '8',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_password: '',
  sender_name: 'LectureLive',
  sender_email: '',
  storage_mode: 'local',
  cloudreve_url: '',
  cloudreve_client_id: '',
  cloudreve_client_secret: '',
  local_path: './data',
  max_file_size: '500',
  local_retention_days: '0',
  theme: 'cream',
  language: 'en',
  default_region: 'auto',
  default_source_lang: 'en',
  default_target_lang: 'zh',
  translation_mode: 'soniox',
  async_upload_billing_multiplier: '0.8',
  audio_enhance_enabled: false,
  audio_enhance_worker_url: '',
  audio_enhance_worker_token: '',
  audio_enhance_target_lufs: '-14',
  audio_enhance_atten_lim_db: '30',
  audio_enhance_concurrency: '1',
  rate_limit_auth: '5',
  rate_limit_api: '60',
  jwt_expiry: '7',
  bcrypt_rounds: '12',
};

// ──── 基础 UI 组件 ────

/** 设置字段容器（标签 + 描述 + 子元素） */
function SettingField({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-6 py-4 border-b border-cream-100 dark:border-charcoal-700 last:border-0">
      <div className="sm:w-48 flex-shrink-0">
        <div className="text-sm font-medium text-charcoal-700 dark:text-cream-200">{label}</div>
        {description && (
          <div className="text-xs text-charcoal-400 dark:text-charcoal-400 mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

/** 单行文本输入 */
function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === 'password';

  return (
    <div className="relative">
      <input
        type={isPassword && showPassword ? 'text' : type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                   bg-white text-charcoal-800 placeholder:text-charcoal-300
                   dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100 dark:placeholder:text-charcoal-400
                   focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300
                   transition-colors"
      />
      {/* 密码类型输入框提供显示/隐藏切换按钮 */}
      {isPassword && (
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-charcoal-400 hover:text-charcoal-600 dark:hover:text-cream-300"
        >
          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}

/** 多行文本输入 */
function TextAreaInput({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                 bg-white text-charcoal-800 placeholder:text-charcoal-300
                 dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100 dark:placeholder:text-charcoal-400
                 focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300
                 transition-colors resize-vertical"
    />
  );
}

/** 下拉选择框 */
function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                 bg-white text-charcoal-800
                 dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                 focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300
                 transition-colors"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 开关切换 */
function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`
        relative w-10 h-5 rounded-full transition-colors duration-200
        ${checked ? 'bg-rust-500' : 'bg-charcoal-200 dark:bg-charcoal-600'}
      `}
    >
      <span
        className={`
          absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200
          ${checked ? 'translate-x-5' : 'translate-x-0'}
        `}
      />
    </button>
  );
}

/** 图标类型 → 数据库设置键的映射 */
const ICON_TYPE_TO_SETTING_KEY: Record<string, string> = {
  logo: 'logo_path',
  favicon: 'favicon_path',
  icon_medium: 'icon_medium_path',
  icon_large: 'icon_large_path',
};

/** 图标上传组件（预览 + 上传按钮） */
function IconUpload({
  label,
  currentPath,
  uploadType,
  onUploaded,
}: {
  label: string;
  currentPath: string;
  uploadType: string;
  onUploaded: (newPath: string) => void;
}) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // 处理文件选择并上传
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/admin/upload-icon?type=${uploadType}`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(t('common.saveFailed'), err?.error);
        return;
      }
      const data = await res.json();
      const newPath = data.path || '';
      onUploaded(newPath);
      // 上传成功后立即将路径保存到数据库，无需手动点保存
      const settingKey = ICON_TYPE_TO_SETTING_KEY[uploadType];
      if (settingKey && newPath) {
        const persistRes = await fetch('/api/admin/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [settingKey]: newPath }),
        });
        if (!persistRes.ok) {
          const err = await persistRes.json().catch(() => null);
          toast.error(t('common.saveFailed'), err?.error);
          return;
        }
      }
      toast.success(t('common.saveSuccess'));
    } catch (err) {
      console.error('图标上传失败:', err);
      toast.error(t('common.saveFailed'), t('common.networkError'));
    } finally {
      setUploading(false);
      // 重置 file input 以便重复选择同一文件
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex items-center gap-4 py-3">
      {/* 图标预览 */}
      <div className="w-16 h-16 flex-shrink-0 rounded-lg border border-cream-200 dark:border-charcoal-600 bg-cream-50 dark:bg-charcoal-700 flex items-center justify-center overflow-hidden">
        {currentPath ? (
          <img src={currentPath} alt={label} className="w-full h-full object-contain" />
        ) : (
          <ImageIcon className="w-6 h-6 text-charcoal-300 dark:text-charcoal-500" />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-charcoal-700 dark:text-cream-200">{label}</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-charcoal-600 dark:text-cream-300 border border-cream-200 dark:border-charcoal-600 rounded-lg hover:bg-cream-100 dark:hover:bg-charcoal-600 transition-colors disabled:opacity-50"
        >
          <Upload className="w-3 h-3" />
          {uploading ? t('common.loading') : t('adminSettings.selectFile')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />
        {currentPath && (
          <span className="text-xs text-charcoal-400 truncate max-w-[200px]">{currentPath}</span>
        )}
      </div>
    </div>
  );
}

/** 备用 URL 动态列表 */
function BackupUrlList({
  urls,
  onChange,
  onAdd,
  onRemove,
}: {
  urls: string[];
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useI18n();
  const atLimit = urls.length >= MAX_BACKUP_URLS;
  return (
    <div className="space-y-2">
      {urls.map((url, index) => (
        <div key={index} className="flex items-center gap-2">
          <div className="flex-1">
            <TextInput
              value={url}
              onChange={(v) => onChange(index, v)}
              placeholder="https://backup.example.com"
            />
          </div>
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="flex-shrink-0 p-2 text-charcoal-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
            aria-label={t('common.delete')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        disabled={atLimit}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-rust-600 dark:text-rust-400 hover:bg-rust-50 dark:hover:bg-charcoal-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:disabled:hover:bg-transparent"
      >
        <Plus className="w-3.5 h-3.5" />
        {atLimit
          ? t('adminSettings.backupUrlLimitReached')
          : t('adminSettings.addBackupUrl')}
      </button>
    </div>
  );
}

// ──── 各标签页面板 ────

/** 站点信息设置 */
function SiteInfoPanel({
  settings,
  onChange,
  onBackupChange,
  onBackupAdd,
  onBackupRemove,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
  onBackupChange: (index: number, value: string) => void;
  onBackupAdd: () => void;
  onBackupRemove: (index: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <SettingField label={t('adminSettings.siteName')} description={t('adminSettings.siteNameDesc')}>
        <TextInput value={settings.site_name} onChange={(v) => onChange('site_name', v)} placeholder="LectureLive" />
      </SettingField>

      <SettingField label={t('adminSettings.siteDescription')} description={t('adminSettings.siteDescriptionDesc')}>
        <TextAreaInput value={settings.site_description} onChange={(v) => onChange('site_description', v)} placeholder={t('adminSettings.siteDescriptionPlaceholder')} rows={2} />
      </SettingField>

      <SettingField label={t('adminSettings.siteUrl')} description={t('adminSettings.siteUrlDesc')}>
        <TextInput value={settings.site_url} onChange={(v) => onChange('site_url', v)} placeholder="https://example.com" />
      </SettingField>

      <SettingField label={t('adminSettings.backupUrls')} description={t('adminSettings.backupUrlsDesc')}>
        <BackupUrlList
          urls={settings.site_url_backups}
          onChange={onBackupChange}
          onAdd={onBackupAdd}
          onRemove={onBackupRemove}
        />
      </SettingField>

      <SettingField label={t('adminSettings.footerCode')} description={t('adminSettings.footerCodeDesc')}>
        <TextAreaInput value={settings.footer_code} onChange={(v) => onChange('footer_code', v)} placeholder="<script>...</script>" rows={4} />
      </SettingField>

      <SettingField label={t('adminSettings.siteAnnouncement')} description={t('adminSettings.siteAnnouncementDesc')}>
        <TextAreaInput value={settings.site_announcement} onChange={(v) => onChange('site_announcement', v)} placeholder={t('adminSettings.siteAnnouncementPlaceholder')} rows={2} />
      </SettingField>

      <SettingField label={t('adminSettings.termsLink')}>
        <TextInput value={settings.terms_url} onChange={(v) => onChange('terms_url', v)} placeholder="https://example.com/terms" />
      </SettingField>

      <SettingField label={t('adminSettings.privacyLink')}>
        <TextInput value={settings.privacy_url} onChange={(v) => onChange('privacy_url', v)} placeholder="https://example.com/privacy" />
      </SettingField>

      {/* 图标区域 */}
      <div className="py-4 border-b border-cream-100 dark:border-charcoal-700">
        <div className="text-sm font-medium text-charcoal-700 dark:text-cream-200 mb-3">{t('adminSettings.siteIcons')}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <IconUpload
            label={t('adminSettings.logo')}
            currentPath={settings.logo_path}
            uploadType="logo"
            onUploaded={(p) => onChange('logo_path', p)}
          />
          <IconUpload
            label={t('adminSettings.favicon')}
            currentPath={settings.favicon_path}
            uploadType="favicon"
            onUploaded={(p) => onChange('favicon_path', p)}
          />
          <IconUpload
            label={t('adminSettings.mediumIcon')}
            currentPath={settings.icon_medium_path}
            uploadType="icon_medium"
            onUploaded={(p) => onChange('icon_medium_path', p)}
          />
          <IconUpload
            label={t('adminSettings.largeIcon')}
            currentPath={settings.icon_large_path}
            uploadType="icon_large"
            onUploaded={(p) => onChange('icon_large_path', p)}
          />
        </div>
      </div>
    </div>
  );
}

/** 注册设置 */
function RegistrationPanel({
  settings,
  onChange,
  onToggle,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
  onToggle: (key: string, value: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <SettingField label={t('adminSettings.allowRegistration')} description={t('adminSettings.allowRegistrationDesc')}>
        <ToggleSwitch checked={settings.allow_registration as boolean} onChange={(v) => onToggle('allow_registration', v)} />
      </SettingField>
      <SettingField label={t('adminSettings.defaultGroup')} description={t('adminSettings.defaultGroupDesc')}>
        <SelectInput
          value={settings.default_group}
          onChange={(v) => onChange('default_group', v)}
          options={[
            { value: 'FREE', label: 'Free' },
            { value: 'PRO', label: 'Pro' },
          ]}
        />
      </SettingField>
      <SettingField label={t('adminSettings.emailVerification')} description={t('adminSettings.emailVerificationDesc')}>
        <ToggleSwitch checked={settings.email_verification as boolean} onChange={(v) => onToggle('email_verification', v)} />
      </SettingField>
      <SettingField label={t('adminSettings.minPasswordLength')} description={t('adminSettings.minPasswordLengthDesc')}>
        <TextInput value={settings.password_min_length} onChange={(v) => onChange('password_min_length', v)} type="number" />
      </SettingField>
      {/* 头像设置说明 */}
      <div className="py-4 border-b border-cream-100 dark:border-charcoal-700 last:border-0">
        <div className="text-sm font-medium text-charcoal-700 dark:text-cream-200 mb-1">{t('adminSettings.avatarSettings')}</div>
        <div className="text-xs text-charcoal-400 dark:text-charcoal-500 leading-relaxed">
          {t('adminSettings.avatarSettingsDesc')}
        </div>
      </div>
    </div>
  );
}

/** 邮件设置 */
function EmailPanel({
  settings,
  onChange,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <SettingField label={t('adminSettings.smtpServer')} description={t('adminSettings.smtpServerDesc')}>
        <TextInput value={settings.smtp_host} onChange={(v) => onChange('smtp_host', v)} placeholder="smtp.example.com" />
      </SettingField>
      <SettingField label={t('adminSettings.smtpPort')}>
        <TextInput value={settings.smtp_port} onChange={(v) => onChange('smtp_port', v)} placeholder="587" />
      </SettingField>
      <SettingField label={t('adminSettings.smtpUsername')}>
        <TextInput value={settings.smtp_user} onChange={(v) => onChange('smtp_user', v)} placeholder="user@example.com" />
      </SettingField>
      <SettingField label={t('adminSettings.smtpPassword')}>
        <TextInput value={settings.smtp_password} onChange={(v) => onChange('smtp_password', v)} type="password" />
      </SettingField>
      <SettingField label={t('adminSettings.senderName')}>
        <TextInput value={settings.sender_name} onChange={(v) => onChange('sender_name', v)} placeholder="LectureLive" />
      </SettingField>
      <SettingField label={t('adminSettings.senderEmail')}>
        <TextInput value={settings.sender_email} onChange={(v) => onChange('sender_email', v)} placeholder="noreply@example.com" />
      </SettingField>
    </div>
  );
}

/** 存储设置 */
function StoragePanel({
  settings,
  onChange,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [authResult, setAuthResult] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<{
    authorized: boolean;
    expiresAt: number | null;
  } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const refreshAuthStatus = useCallback(async () => {
    if (settings.storage_mode !== 'cloudreve') {
      setAuthStatus((prev) => (prev === null ? prev : null));
      return;
    }
    const applyStatus = (next: { authorized: boolean; expiresAt: number | null }) => {
      setAuthStatus((prev) =>
        prev &&
        prev.authorized === next.authorized &&
        prev.expiresAt === next.expiresAt
          ? prev
          : next
      );
    };
    try {
      const res = await fetch('/api/admin/cloudreve/status', {
        cache: 'no-store',
      });
      if (!res.ok) {
        applyStatus({ authorized: false, expiresAt: null });
        return;
      }
      const data = await res.json();
      applyStatus({
        authorized: Boolean(data.authorized),
        expiresAt:
          typeof data.expires_at === 'number' && Number.isFinite(data.expires_at)
            ? data.expires_at
            : null,
      });
    } catch {
      applyStatus({ authorized: false, expiresAt: null });
    }
  }, [settings.storage_mode]);

  // Cloudreve token 由 WS 进程定时刷新，刷新后只更新 DB。
  // 这里轮询拉取一次最新状态，避免 admin 面板看着 "已过期" 直到刷新整页。
  useEffect(() => {
    void refreshAuthStatus();
    if (settings.storage_mode !== 'cloudreve') {
      return;
    }
    const timer = setInterval(() => {
      void refreshAuthStatus();
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, [refreshAuthStatus, settings.storage_mode]);

  const handleManualRefreshAuthStatus = async () => {
    setManualRefreshing(true);
    try {
      await refreshAuthStatus();
    } finally {
      setManualRefreshing(false);
    }
  };

  const handleMigrate = async () => {
    setMigrating(true);
    setMigrateResult(null);
    try {
      const res = await fetch('/api/admin/storage/migrate', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const msg = t('adminSettings.migrateSuccess')
          .replace('{migrated}', String(data.migratedCount))
          .replace('{skipped}', String(data.skippedCount))
          .replace('{errors}', String(data.errorCount));
        setMigrateResult(msg);
        toast.success(msg);
      } else {
        const errMsg = data.error || t('adminSettings.migrateFailed');
        setMigrateResult(errMsg);
        toast.error(t('adminSettings.migrateFailed'), data.error);
      }
    } catch {
      setMigrateResult(t('adminSettings.migrateFailed'));
      toast.error(t('adminSettings.migrateFailed'), t('common.networkError'));
    } finally {
      setMigrating(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await fetch('/api/admin/storage/cleanup', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const msg = t('adminSettings.cleanupSuccess')
          .replace('{deleted}', String(data.deletedCount))
          .replace('{errors}', String(data.errorCount));
        setCleanResult(msg);
        toast.success(msg);
      } else {
        const errMsg = data.error || t('adminSettings.cleanupFailed');
        setCleanResult(errMsg);
        toast.error(t('adminSettings.cleanupFailed'), data.error);
      }
    } catch {
      setCleanResult(t('adminSettings.cleanupFailed'));
      toast.error(t('adminSettings.cleanupFailed'), t('common.networkError'));
    } finally {
      setCleaning(false);
    }
  };

  const handleAuthorize = async () => {
    setAuthorizing(true);
    setAuthResult(null);
    try {
      if (
        !settings.cloudreve_url.trim() ||
        !settings.cloudreve_client_id.trim() ||
        !settings.cloudreve_client_secret.trim()
      ) {
        setAuthResult(t('adminSettings.cloudreveAuthFailed'));
        toast.error(t('adminSettings.cloudreveAuthFailed'));
        return;
      }

      const saveRes = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storage_mode: settings.storage_mode,
          cloudreve_url: settings.cloudreve_url,
          cloudreve_client_id: settings.cloudreve_client_id,
          cloudreve_client_secret: settings.cloudreve_client_secret,
        }),
      });

      if (!saveRes.ok) {
        const saveData = await saveRes.json().catch(() => null);
        setAuthResult(saveData?.error || t('adminSettings.cloudreveAuthFailed'));
        toast.error(t('adminSettings.cloudreveAuthFailed'), saveData?.error);
        return;
      }

      const res = await fetch('/api/admin/cloudreve/authorize');
      const data = await res.json();
      if (res.ok && data.authorize_url) {
        window.location.href = data.authorize_url;
      } else {
        setAuthResult(data.error || t('adminSettings.cloudreveAuthFailed'));
        toast.error(t('adminSettings.cloudreveAuthFailed'), data.error);
      }
    } catch {
      setAuthResult(t('adminSettings.cloudreveAuthFailed'));
      toast.error(t('adminSettings.cloudreveAuthFailed'), t('common.networkError'));
    } finally {
      setAuthorizing(false);
    }
  };

  const handleRevoke = () => {
    setRevokeConfirmOpen(true);
  };

  const handleRevokeConfirm = async () => {
    setRevokeConfirmOpen(false);
    setRevoking(true);
    setAuthResult(null);
    try {
      const res = await fetch('/api/admin/cloudreve/revoke', { method: 'POST' });
      if (res.ok) {
        setAuthResult(t('adminSettings.cloudreveRevokeSuccess'));
        toast.success(t('adminSettings.cloudreveRevokeSuccess'));
        await refreshAuthStatus();
      } else {
        const data = await res.json().catch(() => null);
        setAuthResult(
          data?.error || t('adminSettings.cloudreveRevokeFailed')
        );
        toast.error(t('adminSettings.cloudreveRevokeFailed'), data?.error);
      }
    } catch {
      setAuthResult(t('adminSettings.cloudreveRevokeFailed'));
      toast.error(t('adminSettings.cloudreveRevokeFailed'), t('common.networkError'));
    } finally {
      setRevoking(false);
    }
  };

  const isAuthorized = Boolean(authStatus?.authorized);
  const isExpired =
    isAuthorized &&
    authStatus?.expiresAt !== null &&
    authStatus?.expiresAt !== undefined &&
    authStatus.expiresAt > 0 &&
    authStatus.expiresAt <= Date.now();

  return (
    <div>
      <SettingField label={t('adminSettings.storageMode')} description={t('adminSettings.storageModeDesc')}>
        <SelectInput
          value={settings.storage_mode}
          onChange={(v) => onChange('storage_mode', v)}
          options={[
            { value: 'local', label: t('adminSettings.localStorage') },
            { value: 'cloudreve', label: t('adminSettings.cloudreveStorage') },
          ]}
        />
      </SettingField>
      {settings.storage_mode === 'local' && (
        <SettingField label={t('adminSettings.localPath')} description={t('adminSettings.localPathDesc')}>
          <TextInput value={settings.local_path} onChange={(v) => onChange('local_path', v)} placeholder="./data" />
        </SettingField>
      )}
      {settings.storage_mode === 'cloudreve' && (
        <>
          <SettingField label={t('adminSettings.cloudreveUrl')} description={t('adminSettings.cloudreveUrlDesc')}>
            <TextInput value={settings.cloudreve_url} onChange={(v) => onChange('cloudreve_url', v)} placeholder="https://cloud.example.com" />
          </SettingField>
          <SettingField label={t('adminSettings.cloudreveClientId')} description={t('adminSettings.cloudreveClientIdDesc')}>
            <TextInput value={settings.cloudreve_client_id} onChange={(v) => onChange('cloudreve_client_id', v)} placeholder="OAuth Client ID" />
          </SettingField>
          <SettingField label={t('adminSettings.cloudreveClientSecret')} description={t('adminSettings.cloudreveClientSecretDesc')}>
            <TextInput value={settings.cloudreve_client_secret} onChange={(v) => onChange('cloudreve_client_secret', v)} type="password" />
          </SettingField>

          {/* OAuth 授权状态 + 操作按钮 */}
          <div className="mt-2 space-y-2">
            {authStatus && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={
                    isAuthorized && !isExpired
                      ? 'inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : isExpired
                      ? 'inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                      : 'inline-flex items-center gap-1 rounded-full bg-charcoal-200 px-2 py-0.5 text-xs font-medium text-charcoal-600 dark:bg-charcoal-700 dark:text-charcoal-300'
                  }
                >
                  {isExpired
                    ? t('adminSettings.cloudreveStatusExpired')
                    : isAuthorized
                    ? t('adminSettings.cloudreveStatusAuthorized')
                    : t('adminSettings.cloudreveStatusUnauthorized')}
                </span>
                <button
                  type="button"
                  onClick={handleManualRefreshAuthStatus}
                  disabled={manualRefreshing}
                  title={t('adminSettings.cloudreveRefreshStatus')}
                  aria-label={t('adminSettings.cloudreveRefreshStatus')}
                  className="inline-flex items-center justify-center rounded-md p-1 text-charcoal-500 transition-colors hover:bg-charcoal-100 hover:text-charcoal-700 disabled:opacity-50 dark:text-charcoal-400 dark:hover:bg-charcoal-700 dark:hover:text-charcoal-200"
                >
                  <RotateCcw
                    size={14}
                    className={manualRefreshing ? 'animate-spin' : undefined}
                  />
                </button>
                {isAuthorized && !isExpired && authStatus.expiresAt && (
                  <span className="text-xs text-charcoal-500 dark:text-charcoal-400">
                    {t('adminSettings.cloudreveTokenExpiresAt').replace(
                      '{time}',
                      new Date(authStatus.expiresAt).toLocaleString()
                    )}
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleAuthorize}
                disabled={
                  authorizing ||
                  revoking ||
                  !settings.cloudreve_url.trim() ||
                  !settings.cloudreve_client_id.trim() ||
                  !settings.cloudreve_client_secret.trim()
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-rust-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rust-600 disabled:opacity-50"
              >
                <Globe size={14} />
                {authorizing
                  ? t('adminSettings.cloudreveAuthorizing')
                  : isAuthorized
                  ? t('adminSettings.cloudreveReauthorize')
                  : t('adminSettings.cloudreveAuthorize')}
              </button>
              {isAuthorized && (
                <button
                  type="button"
                  onClick={handleRevoke}
                  disabled={revoking || authorizing}
                  className="inline-flex items-center gap-1.5 rounded-md border border-charcoal-300 bg-white px-3 py-1.5 text-sm font-medium text-charcoal-700 transition-colors hover:bg-charcoal-50 disabled:opacity-50 dark:border-charcoal-600 dark:bg-charcoal-800 dark:text-charcoal-200 dark:hover:bg-charcoal-700"
                >
                  <Trash2 size={14} />
                  {revoking
                    ? t('adminSettings.cloudreveRevoking')
                    : t('adminSettings.cloudreveRevoke')}
                </button>
              )}
            </div>
            {authResult && (
              <p className="mt-1 text-sm text-charcoal-600 dark:text-charcoal-400">{authResult}</p>
            )}
          </div>
          <SettingField label={t('adminSettings.localRetentionDays')} description={t('adminSettings.localRetentionDaysDesc')}>
            <TextInput value={settings.local_retention_days} onChange={(v) => onChange('local_retention_days', v)} type="number" placeholder="0" />
          </SettingField>

          {/* 迁移与清理操作 */}
          <div className="mt-4 space-y-3 rounded-lg border border-charcoal-200 bg-charcoal-50 p-4 dark:border-charcoal-700 dark:bg-charcoal-800">
            <p className="text-sm font-medium text-charcoal-700 dark:text-charcoal-300">
              {t('adminSettings.storageActions')}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleMigrate}
                disabled={migrating}
                className="inline-flex items-center gap-1.5 rounded-md bg-rust-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rust-600 disabled:opacity-50"
              >
                <Upload size={14} />
                {migrating ? t('adminSettings.migrating') : t('adminSettings.migrateNow')}
              </button>
              <button
                type="button"
                onClick={handleCleanup}
                disabled={cleaning || Number(settings.local_retention_days) <= 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-charcoal-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-charcoal-600 disabled:opacity-50"
              >
                <Trash2 size={14} />
                {cleaning ? t('adminSettings.cleaning') : t('adminSettings.cleanupNow')}
              </button>
            </div>
            {migrateResult && (
              <p className="text-sm text-charcoal-600 dark:text-charcoal-400">{migrateResult}</p>
            )}
            {cleanResult && (
              <p className="text-sm text-charcoal-600 dark:text-charcoal-400">{cleanResult}</p>
            )}
          </div>
        </>
      )}
      <SettingField label={t('adminSettings.maxUploadSize')} description={t('adminSettings.maxUploadSizeDesc')}>
        <TextInput value={settings.max_file_size} onChange={(v) => onChange('max_file_size', v)} type="number" />
      </SettingField>
      <ConfirmDialog
        open={revokeConfirmOpen}
        title={t('adminSettings.cloudreveRevoke')}
        message={t('adminSettings.cloudreveRevokeConfirm')}
        confirmText={t('adminSettings.cloudreveRevoke')}
        danger
        loading={revoking}
        onConfirm={handleRevokeConfirm}
        onCancel={() => setRevokeConfirmOpen(false)}
      />
    </div>
  );
}

/** 外观设置 — 支持暗黑模式切换 */
function AppearancePanel({
  settings,
  onChange,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
}) {
  const { setTheme } = useTheme();
  const { t, setLocale } = useI18n();

  // 切换主题时通过 ThemeProvider 同步更新（持久化到 localStorage）
  const handleThemeChange = (value: string) => {
    onChange('theme', value);
    setTheme(value === 'dark' ? 'dark' : 'light');
  };

  const handleLanguageChange = (v: string) => {
    onChange('language', v);
    if (v === 'en' || v === 'zh') setLocale(v);
  };

  return (
    <div>
      <SettingField label={t('adminSettings.theme')} description={t('adminSettings.themeDesc')}>
        <SelectInput
          value={settings.theme}
          onChange={handleThemeChange}
          options={[
            { value: 'cream', label: t('adminSettings.themeCream') },
            { value: 'dark', label: t('adminSettings.themeDark') },
          ]}
        />
      </SettingField>
      <SettingField label={t('adminSettings.defaultLanguage')} description={t('adminSettings.defaultLanguageDesc')}>
        <SelectInput
          value={settings.language}
          onChange={handleLanguageChange}
          options={[
            { value: 'en', label: 'English' },
            { value: 'zh', label: '中文' },
          ]}
        />
      </SettingField>
    </div>
  );
}

/** ASR 设置 */
/** Soniox 区域配置状态 */
interface SonioxRegionStatus {
  hasApiKey: boolean;
  maskedKey: string;
  wsUrl: string;
  restUrl: string;
}

interface SonioxConfig {
  configured: boolean;
  defaultRegion: string;
  regions: Record<string, SonioxRegionStatus>;
}

const DEFAULT_SONIOX_ENDPOINTS: Record<string, { wsUrl: string; restUrl: string }> = {
  us: { wsUrl: 'wss://stt-rt.soniox.com/transcribe-websocket', restUrl: 'https://api.soniox.com' },
  eu: { wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket', restUrl: 'https://api.eu.soniox.com' },
  jp: { wsUrl: 'wss://stt-rt.jp.soniox.com/transcribe-websocket', restUrl: 'https://api.jp.soniox.com' },
};

const SONIOX_REGION_LABELS: Record<string, string> = {
  us: 'US (美国)',
  eu: 'EU (欧洲)',
  jp: 'JP (日本)',
};

function AsrPanel({
  settings,
  onChange,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();

  // Soniox API Key 管理状态
  const [sonioxConfig, setSonioxConfig] = useState<SonioxConfig | null>(null);
  const [sonioxLoading, setSonioxLoading] = useState(true);
  const [sonioxSaving, setSonioxSaving] = useState(false);
  const [sonioxError, setSonioxError] = useState('');
  const [sonioxSuccess, setSonioxSuccess] = useState('');
  // 每个区域的新 API Key 输入（仅在用户主动输入时才发送更新）
  const [newKeys, setNewKeys] = useState<Record<string, string>>({ us: '', eu: '', jp: '' });
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({ us: false, eu: false, jp: false });
  const [expandedRegion, setExpandedRegion] = useState<string | null>(null);

  // 加载 Soniox 配置状态
  useEffect(() => {
    const loadSoniox = async () => {
      try {
        const res = await fetch('/api/admin/soniox');
        if (res.ok) {
          const data = await res.json();
          setSonioxConfig(data);
        }
      } catch (err) {
        console.error('加载 Soniox 配置失败:', err);
      } finally {
        setSonioxLoading(false);
      }
    };
    loadSoniox();
  }, []);

  // 保存 Soniox 配置
  const handleSaveSoniox = async () => {
    setSonioxSaving(true);
    setSonioxError('');
    setSonioxSuccess('');

    try {
      // 只发送有变更的区域
      const regionsPayload: Record<string, { apiKey?: string }> = {};
      for (const region of ['us', 'eu', 'jp']) {
        if (newKeys[region]) {
          regionsPayload[region] = { apiKey: newKeys[region] };
        }
      }

      if (Object.keys(regionsPayload).length === 0) {
        const msg = '请至少输入一个区域的 API Key';
        setSonioxError(msg);
        toast.error(msg);
        setSonioxSaving(false);
        return;
      }

      const res = await fetch('/api/admin/soniox', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regions: regionsPayload }),
      });

      if (!res.ok) {
        const data = await res.json();
        const msg = data.error || t('common.saveFailed');
        setSonioxError(msg);
        toast.error(t('common.saveFailed'), data.error);
        return;
      }

      const msg = 'Soniox API Key 已更新';
      setSonioxSuccess(msg);
      toast.success(msg);
      setNewKeys({ us: '', eu: '', jp: '' });

      // 重新加载配置状态
      const refreshRes = await fetch('/api/admin/soniox');
      if (refreshRes.ok) {
        setSonioxConfig(await refreshRes.json());
      }

      setTimeout(() => setSonioxSuccess(''), 3000);
    } catch {
      const msg = '保存失败，请检查网络连接';
      setSonioxError(msg);
      toast.error(t('common.saveFailed'), t('common.networkError'));
    } finally {
      setSonioxSaving(false);
    }
  };

  // 删除某个区域的 API Key
  const handleDeleteKey = async (region: string) => {
    setSonioxSaving(true);
    setSonioxError('');
    try {
      const res = await fetch('/api/admin/soniox', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          regions: { [region]: { apiKey: '' } },
        }),
      });

      if (res.ok) {
        const refreshRes = await fetch('/api/admin/soniox');
        if (refreshRes.ok) {
          setSonioxConfig(await refreshRes.json());
        }
        const msg = `${SONIOX_REGION_LABELS[region]} API Key 已删除`;
        setSonioxSuccess(msg);
        toast.success(msg);
        setTimeout(() => setSonioxSuccess(''), 3000);
      } else {
        const data = await res.json().catch(() => null);
        toast.error(t('common.deleteFailed'), data?.error);
      }
    } catch {
      setSonioxError('删除失败');
      toast.error(t('common.deleteFailed'), t('common.networkError'));
    } finally {
      setSonioxSaving(false);
    }
  };

  return (
    <div>
      {/* ── Soniox API Key 管理 ── */}
      <div className="mb-6 pb-6 border-b border-cream-200 dark:border-charcoal-700">
        <h3 className="text-sm font-semibold text-charcoal-700 dark:text-cream-200 mb-3">
          Soniox API Key 配置
        </h3>
        <p className="text-xs text-charcoal-400 dark:text-charcoal-400 mb-4">
          配置各区域的 Soniox 语音识别 API Key。至少需要配置一个区域。如已通过环境变量配置则无需在此设置。
        </p>

        {sonioxLoading ? (
          <div className="text-sm text-charcoal-400 py-4">加载中...</div>
        ) : (
          <div className="space-y-3">
            {['us', 'eu', 'jp'].map((region) => {
              const status = sonioxConfig?.regions?.[region];
              const isExpanded = expandedRegion === region;

              return (
                <div
                  key={region}
                  className="border border-cream-200 dark:border-charcoal-600 rounded-lg overflow-hidden"
                >
                  {/* 区域标题栏 */}
                  <button
                    type="button"
                    onClick={() => setExpandedRegion(isExpanded ? null : region)}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm
                               hover:bg-cream-50 dark:hover:bg-charcoal-750 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-charcoal-700 dark:text-cream-200">
                        {SONIOX_REGION_LABELS[region]}
                      </span>
                      {status?.hasApiKey ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          已配置
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-charcoal-100 text-charcoal-500 dark:bg-charcoal-700 dark:text-charcoal-400">
                          未配置
                        </span>
                      )}
                    </div>
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-charcoal-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-charcoal-400" />
                    )}
                  </button>

                  {/* 展开的配置区域 */}
                  {isExpanded && (
                    <div className="px-4 pb-4 space-y-3 border-t border-cream-100 dark:border-charcoal-700">
                      {/* 当前状态 */}
                      {status?.hasApiKey && (
                        <div className="flex items-center justify-between mt-3">
                          <div className="text-xs text-charcoal-500 dark:text-charcoal-400">
                            当前 Key：
                            <code className="ml-1 px-1.5 py-0.5 bg-cream-100 dark:bg-charcoal-700 rounded text-charcoal-600 dark:text-cream-300">
                              {status.maskedKey}
                            </code>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDeleteKey(region)}
                            disabled={sonioxSaving}
                            className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50"
                          >
                            <Trash2 className="w-3.5 h-3.5 inline mr-1" />
                            删除
                          </button>
                        </div>
                      )}

                      {/* 输入新 Key */}
                      <div className="mt-2">
                        <label className="text-xs text-charcoal-500 dark:text-charcoal-400 mb-1 block">
                          {status?.hasApiKey ? '替换 API Key' : '输入 API Key'}
                        </label>
                        <div className="relative">
                          <input
                            type={showKeys[region] ? 'text' : 'password'}
                            value={newKeys[region]}
                            onChange={(e) => setNewKeys(prev => ({ ...prev, [region]: e.target.value }))}
                            placeholder="输入 Soniox API Key..."
                            className="w-full px-3 py-2 pr-10 text-sm border border-cream-200 rounded-lg
                                       bg-white text-charcoal-800 placeholder:text-charcoal-300
                                       dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100 dark:placeholder:text-charcoal-400
                                       focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300
                                       transition-colors"
                          />
                          <button
                            type="button"
                            onClick={() => setShowKeys(prev => ({ ...prev, [region]: !prev[region] }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-charcoal-400 hover:text-charcoal-600 dark:hover:text-cream-300"
                          >
                            {showKeys[region] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {/* 默认端点提示 */}
                      <div className="text-xs text-charcoal-400 dark:text-charcoal-500">
                        REST: {DEFAULT_SONIOX_ENDPOINTS[region].restUrl}
                        <br />
                        WebSocket: {DEFAULT_SONIOX_ENDPOINTS[region].wsUrl}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* 保存按钮 & 状态消息 */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSaveSoniox}
                disabled={sonioxSaving || !Object.values(newKeys).some(Boolean)}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-rust-500 rounded-lg
                           hover:bg-rust-600 transition-colors shadow-sm disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {sonioxSaving ? '保存中...' : '保存 API Key'}
              </button>
              {sonioxError && (
                <span className="text-xs text-red-500">{sonioxError}</span>
              )}
              {sonioxSuccess && (
                <span className="text-xs text-green-600 dark:text-green-400">{sonioxSuccess}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── ASR 默认设置 ── */}
      <SettingField label={t('adminSettings.defaultAsrRegion')} description={t('adminSettings.defaultAsrRegionDesc')}>
        <SelectInput
          value={settings.default_region}
          onChange={(v) => onChange('default_region', v)}
          options={[
            { value: 'auto', label: t('adminSettings.autoRegion') },
            { value: 'us', label: t('adminSettings.usRegion') },
            { value: 'eu', label: t('adminSettings.euRegion') },
            { value: 'jp', label: t('adminSettings.jpRegion') },
          ]}
        />
      </SettingField>
      <SettingField label={t('adminSettings.defaultSourceLang')} description={t('adminSettings.defaultSourceLangDesc')}>
        <SelectInput
          value={settings.default_source_lang}
          onChange={(v) => onChange('default_source_lang', v)}
          options={[
            { value: 'en', label: 'English' },
            { value: 'zh', label: 'Chinese' },
            { value: 'ja', label: 'Japanese' },
            { value: 'ko', label: 'Korean' },
            { value: 'es', label: 'Spanish' },
            { value: 'fr', label: 'French' },
            { value: 'de', label: 'German' },
          ]}
        />
      </SettingField>
      <SettingField label={t('adminSettings.defaultTargetLang')} description={t('adminSettings.defaultTargetLangDesc')}>
        <SelectInput
          value={settings.default_target_lang}
          onChange={(v) => onChange('default_target_lang', v)}
          options={[
            { value: 'zh', label: 'Chinese' },
            { value: 'en', label: 'English' },
            { value: 'ja', label: 'Japanese' },
            { value: 'ko', label: 'Korean' },
            { value: 'es', label: 'Spanish' },
            { value: 'fr', label: 'French' },
          ]}
        />
      </SettingField>
      <SettingField label={t('adminSettings.translationMode')} description={t('adminSettings.translationModeDesc')}>
        <SelectInput
          value={settings.translation_mode}
          onChange={(v) => onChange('translation_mode', v)}
          options={[
            { value: 'soniox', label: t('adminSettings.sonioxCloud') },
            { value: 'local', label: t('adminSettings.localTransformers') },
          ]}
        />
      </SettingField>
      <SettingField
        label={t('adminSettings.asyncUploadBillingMultiplier')}
        description={t('adminSettings.asyncUploadBillingMultiplierDesc')}
      >
        <TextInput
          value={settings.async_upload_billing_multiplier}
          onChange={(v) => onChange('async_upload_billing_multiplier', v)}
          type="number"
          placeholder="0.8"
        />
      </SettingField>
    </div>
  );
}

/** 录音音频增强（外部 worker 后处理：响度归一化 + 降噪） */
function AudioEnhancePanel({
  settings,
  onChange,
  onToggle,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
  onToggle: (key: string, value: boolean) => void;
}) {
  const { t } = useI18n();
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // 测试连接：带上表单当前值（token 是掩码时后端自动回落已保存值）
  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch('/api/admin/audio-enhance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerUrl: settings.audio_enhance_worker_url,
          workerToken: settings.audio_enhance_worker_token,
        }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok) {
        const deepFilter = data.engines?.deepFilter
          ? t('adminSettings.audioEnhanceVerifyDeepFilter')
          : t('adminSettings.audioEnhanceVerifyAfftdnOnly');
        setVerifyResult({
          ok: true,
          message: `${t('adminSettings.audioEnhanceVerifyOk')} (v${data.version ?? '?'}, ${deepFilter})`,
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data?.error ?? t('common.networkError'),
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: t('common.networkError') });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div>
      <p className="text-xs text-charcoal-400 dark:text-charcoal-400 pb-2">
        {t('adminSettings.audioEnhanceIntro')}
      </p>
      <SettingField
        label={t('adminSettings.audioEnhanceEnabled')}
        description={t('adminSettings.audioEnhanceEnabledDesc')}
      >
        <ToggleSwitch
          checked={settings.audio_enhance_enabled as boolean}
          onChange={(v) => onToggle('audio_enhance_enabled', v)}
        />
      </SettingField>
      <SettingField
        label={t('adminSettings.audioEnhanceWorkerUrl')}
        description={t('adminSettings.audioEnhanceWorkerUrlDesc')}
      >
        <TextInput
          value={settings.audio_enhance_worker_url}
          onChange={(v) => onChange('audio_enhance_worker_url', v)}
          placeholder="https://enhance.example.com"
        />
      </SettingField>
      <SettingField
        label={t('adminSettings.audioEnhanceWorkerToken')}
        description={t('adminSettings.audioEnhanceWorkerTokenDesc')}
      >
        <div className="space-y-2">
          <TextInput
            value={settings.audio_enhance_worker_token}
            onChange={(v) => onChange('audio_enhance_worker_token', v)}
            type="password"
            placeholder={t('adminSettings.audioEnhanceWorkerTokenPlaceholder')}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleVerify}
              disabled={verifying || !settings.audio_enhance_worker_url}
              className="px-3 py-1.5 text-xs font-medium text-charcoal-600 border border-cream-200 rounded-lg
                         hover:bg-cream-50 dark:text-cream-200 dark:border-charcoal-600 dark:hover:bg-charcoal-700
                         transition-colors disabled:opacity-50"
            >
              {verifying
                ? t('common.loading')
                : t('adminSettings.audioEnhanceVerify')}
            </button>
            {verifyResult && (
              <span
                className={`text-xs ${verifyResult.ok ? 'text-green-600' : 'text-rust-500'}`}
              >
                {verifyResult.message}
              </span>
            )}
          </div>
        </div>
      </SettingField>
      <SettingField
        label={t('adminSettings.audioEnhanceTargetLufs')}
        description={t('adminSettings.audioEnhanceTargetLufsDesc')}
      >
        <TextInput
          value={settings.audio_enhance_target_lufs}
          onChange={(v) => onChange('audio_enhance_target_lufs', v)}
          type="number"
        />
      </SettingField>
      <SettingField
        label={t('adminSettings.audioEnhanceAttenLim')}
        description={t('adminSettings.audioEnhanceAttenLimDesc')}
      >
        <TextInput
          value={settings.audio_enhance_atten_lim_db}
          onChange={(v) => onChange('audio_enhance_atten_lim_db', v)}
          type="number"
        />
      </SettingField>
      <SettingField
        label={t('adminSettings.audioEnhanceConcurrency')}
        description={t('adminSettings.audioEnhanceConcurrencyDesc')}
      >
        <TextInput
          value={settings.audio_enhance_concurrency}
          onChange={(v) => onChange('audio_enhance_concurrency', v)}
          type="number"
        />
      </SettingField>
    </div>
  );
}

/** 安全设置 */
function SecurityPanel({
  settings,
  onChange,
  onToggle,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
  onToggle: (key: string, value: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <SettingField label={t('adminSettings.trustedProxy')} description={t('adminSettings.trustedProxyDesc')}>
        <ToggleSwitch checked={settings.trusted_proxy as boolean} onChange={(v) => onToggle('trusted_proxy', v)} />
      </SettingField>
      <SettingField label={t('adminSettings.loginRateLimit')} description={t('adminSettings.loginRateLimitDesc')}>
        <TextInput value={settings.rate_limit_auth} onChange={(v) => onChange('rate_limit_auth', v)} type="number" />
      </SettingField>
      <SettingField label={t('adminSettings.apiRateLimit')} description={t('adminSettings.apiRateLimitDesc')}>
        <TextInput value={settings.rate_limit_api} onChange={(v) => onChange('rate_limit_api', v)} type="number" />
      </SettingField>
      <SettingField label={t('adminSettings.jwtExpiry')} description={t('adminSettings.jwtExpiryDesc')}>
        <TextInput value={settings.jwt_expiry} onChange={(v) => onChange('jwt_expiry', v)} type="number" />
      </SettingField>
      <SettingField label={t('adminSettings.bcryptRounds')} description={t('adminSettings.bcryptRoundsDesc')}>
        <TextInput value={settings.bcrypt_rounds} onChange={(v) => onChange('bcrypt_rounds', v)} type="number" />
      </SettingField>
    </div>
  );
}

// ──── 主组件 ────

export default function SettingsPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // sub-tab 状态由 URL `?subtab=` 驱动
  const subtabFromUrl = searchParams.get('subtab');
  const activeTab: SettingsTab = isSettingsTab(subtabFromUrl) ? subtabFromUrl : 'site';

  const setActiveTab = useCallback(
    (next: SettingsTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'site') {
        params.delete('subtab');
      } else {
        params.set('subtab', next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const [settings, setSettings] = useState<SiteSettingsData>(defaultSettings);
  const [originalSettings, setOriginalSettings] = useState<SiteSettingsData>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { t } = useI18n();

  const tabLabelKeys: Record<SettingsTab, string> = {
    site: 'adminSettings.tabSiteInfo',
    registration: 'adminSettings.tabRegistration',
    email: 'adminSettings.tabEmail',
    storage: 'adminSettings.tabStorage',
    appearance: 'adminSettings.tabAppearance',
    asr: 'adminSettings.tabAsr',
    audioEnhance: 'adminSettings.tabAudioEnhance',
    llm: 'adminSettings.tabLlm',
    security: 'adminSettings.tabSecurity',
  };

  // 加载站点设置
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch('/api/admin/settings');
        if (res.ok) {
          const data = await res.json();
          const merged = { ...defaultSettings, ...data };
          setSettings(merged);
          setOriginalSettings(merged);
        }
      } catch (err) {
        console.error('加载站点设置失败:', err);
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
  }, []);

  // 主题切换由 ThemeProvider 管理，此处无需直接操作 DOM
  // LLM 设置（用途路由 + 模型库）自带数据加载，见 LlmSettingsPanel

  // 更新字符串类型的设置
  const handleChange = useCallback((key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 更新布尔类型的设置
  const handleToggle = useCallback((key: string, value: boolean) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 备用 URL 列表操作
  const handleBackupChange = useCallback((index: number, value: string) => {
    setSettings((prev) => {
      const next = [...prev.site_url_backups];
      next[index] = value;
      return { ...prev, site_url_backups: next };
    });
  }, []);

  const handleBackupAdd = useCallback(() => {
    setSettings((prev) => {
      if (prev.site_url_backups.length >= MAX_BACKUP_URLS) return prev;
      return { ...prev, site_url_backups: [...prev.site_url_backups, ''] };
    });
  }, []);

  const handleBackupRemove = useCallback((index: number) => {
    setSettings((prev) => ({
      ...prev,
      site_url_backups: prev.site_url_backups.filter((_, i) => i !== index),
    }));
  }, []);

  // 重置设置为上次保存的状态
  const handleReset = () => {
    setSettings(originalSettings);
  };

  // 保存站点设置到后端
  const handleSave = async () => {
    // 前端校验：清洗备用 URL 列表
    const cleanedBackups = settings.site_url_backups
      .map((s) => s.trim())
      .filter(Boolean);

    for (const url of cleanedBackups) {
      try {
        new URL(url);
      } catch {
        toast.error(t('adminSettings.invalidBackupUrl'));
        return;
      }
    }

    if (cleanedBackups.length > MAX_BACKUP_URLS) {
      toast.error(t('adminSettings.backupUrlLimitReached'));
      return;
    }

    const payload = { ...settings, site_url_backups: cleanedBackups };

    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSettings(payload);
        setOriginalSettings(payload);
        toast.success(t('common.saveSuccess'));
      } else {
        const err = await res.json().catch(() => null);
        toast.error(t('common.saveFailed'), err?.error);
      }
    } catch (err) {
      console.error('保存设置失败:', err);
      toast.error(t('common.saveFailed'), t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  // 渲染当前选中标签的内容
  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-12 text-charcoal-400 dark:text-charcoal-500">
          {t('common.loading')}
        </div>
      );
    }

    switch (activeTab) {
      case 'site':
        return (
          <SiteInfoPanel
            settings={settings}
            onChange={handleChange}
            onBackupChange={handleBackupChange}
            onBackupAdd={handleBackupAdd}
            onBackupRemove={handleBackupRemove}
          />
        );
      case 'registration':
        return <RegistrationPanel settings={settings} onChange={handleChange} onToggle={handleToggle} />;
      case 'email':
        return <EmailPanel settings={settings} onChange={handleChange} />;
      case 'storage':
        return <StoragePanel settings={settings} onChange={handleChange} />;
      case 'appearance':
        return <AppearancePanel settings={settings} onChange={handleChange} />;
      case 'asr':
        return <AsrPanel settings={settings} onChange={handleChange} />;
      case 'audioEnhance':
        return (
          <AudioEnhancePanel
            settings={settings}
            onChange={handleChange}
            onToggle={handleToggle}
          />
        );
      case 'llm':
        return <LlmSettingsPanel />;
      case 'security':
        return <SecurityPanel settings={settings} onChange={handleChange} onToggle={handleToggle} />;
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl md:text-2xl font-serif font-bold text-charcoal-800 dark:text-cream-100">{t('adminSettings.title')}</h2>

      {/* 水平标签栏 */}
      <div className="bg-white rounded-xl border border-cream-200 dark:bg-charcoal-800 dark:border-charcoal-700 overflow-hidden">
        <div className="relative flex overflow-x-auto border-b border-cream-200 dark:border-charcoal-700 px-2 pt-2 gap-1 scrollbar-thin">
          {settingsTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg
                  whitespace-nowrap flex-shrink-0
                  transition-all duration-200 ease-out
                  ${isActive
                    ? 'bg-cream-50 dark:bg-charcoal-700 text-rust-600 dark:text-rust-400'
                    : 'text-charcoal-400 hover:text-charcoal-600 dark:hover:text-cream-300 hover:bg-cream-50/70 dark:hover:bg-charcoal-750'
                  }
                `}
              >
                <Icon
                  className={`w-3.5 h-3.5 transition-transform duration-200 ease-out ${
                    isActive ? 'scale-110' : 'group-hover:scale-105'
                  }`}
                />
                <span>{t(tabLabelKeys[tab.id])}</span>
                {/* 用 absolute span 做 active 下划线，动画过渡更自然 */}
                <span
                  className={`absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-rust-500 origin-center
                              transition-transform duration-300 ease-out ${
                                isActive ? 'scale-x-100 opacity-100' : 'scale-x-0 opacity-0'
                              }`}
                />
              </button>
            );
          })}
        </div>

        {/* 设置内容区域 — key 切换触发 fade-in，使切 tab 时内容有过渡 */}
        <div className="p-6">
          <div key={activeTab} className="animate-fade-in">
            {renderContent()}
          </div>
        </div>

        {/* 底部操作栏 — LLM 标签页不显示全局保存按钮（LLM 有独立保存逻辑） */}
        {activeTab !== 'llm' && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-100 dark:border-charcoal-700 bg-cream-50/50 dark:bg-charcoal-800/50">
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-charcoal-500 dark:text-charcoal-400 rounded-lg
                         hover:bg-cream-200 dark:hover:bg-charcoal-700 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('common.reset')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-rust-500 rounded-lg
                         hover:bg-rust-600 transition-colors shadow-sm disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? t('common.saving') : t('adminSettings.saveChanges')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
