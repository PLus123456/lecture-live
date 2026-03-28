'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { useI18n } from '@/lib/i18n';

// ──── 类型定义 ────

type SettingsTab =
  | 'site'
  | 'registration'
  | 'email'
  | 'storage'
  | 'appearance'
  | 'asr'
  | 'llm'
  | 'security';

/** 站点设置（从后端 /api/admin/settings 加载） */
interface SiteSettingsData {
  site_name: string;
  site_description: string;
  site_url: string;
  site_url_alt: string;
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
  cloudreve_token: string;
  local_path: string;
  max_file_size: string;
  // 外观相关
  theme: string;
  language: string;
  // ASR 相关
  default_region: string;
  default_source_lang: string;
  default_target_lang: string;
  translation_mode: string;
  // 安全相关
  rate_limit_auth: string;
  rate_limit_api: string;
  jwt_expiry: string;
  bcrypt_rounds: string;
  [key: string]: string | boolean;
}

/** LLM 模型用途 */
type ModelPurpose = 'CHAT' | 'REALTIME_SUMMARY' | 'FINAL_SUMMARY' | 'KEYWORD_EXTRACTION';

/** LLM 思考深度 */
type ThinkingBudget = 'low' | 'medium' | 'high';

/** LLM 模型定义 */
interface LlmModel {
  id: string;
  model_id: string;
  display_name: string;
  thinking_budget: ThinkingBudget;
  max_tokens: number;
  temperature: number;
  purposes: ModelPurpose[];
  default_purposes: ModelPurpose[];
  purpose_ids: Partial<Record<ModelPurpose, string>>;
}

/** LLM 供应商定义 */
interface LlmProvider {
  id: string;
  name: string;
  api_key: string;
  has_api_key: boolean;
  masked_api_key: string;
  api_url: string;
  is_anthropic_native: boolean;
  models: LlmModel[];
}

const MODEL_PURPOSES: ModelPurpose[] = [
  'CHAT',
  'REALTIME_SUMMARY',
  'FINAL_SUMMARY',
  'KEYWORD_EXTRACTION',
];

function getPurposeLabel(t: (key: string) => string, purpose: ModelPurpose) {
  switch (purpose) {
    case 'CHAT':
      return t('adminSettings.purposeChat');
    case 'REALTIME_SUMMARY':
      return t('adminSettings.purposeRealtimeSummary');
    case 'FINAL_SUMMARY':
      return t('adminSettings.purposeFinalSummary');
    case 'KEYWORD_EXTRACTION':
      return t('adminSettings.purposeKeywordExtraction');
    default:
      return purpose;
  }
}

function toFiniteNumber(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sortModelPurposes(purposes: ModelPurpose[]): ModelPurpose[] {
  return Array.from(new Set(purposes)).sort(
    (a, b) => MODEL_PURPOSES.indexOf(a) - MODEL_PURPOSES.indexOf(b)
  );
}

function buildModelGroupKey(model: Record<string, unknown>) {
  const modelId = (model.modelId ?? model.model_id ?? '') as string;
  const displayName = (model.displayName ?? model.display_name ?? '') as string;
  const thinkingDepth = (model.thinkingDepth ?? model.thinking_budget ?? 'medium') as string;
  const maxTokens = toFiniteNumber(model.maxTokens ?? model.max_tokens, 4096);
  const temperature = toFiniteNumber(model.temperature, 0.3);

  return [modelId, displayName, thinkingDepth, maxTokens, temperature].join('::');
}

function groupProviderModels(models: Record<string, unknown>[]): LlmModel[] {
  const grouped = new Map<string, LlmModel>();

  models.forEach((model, index) => {
    const key = buildModelGroupKey(model);
    const purpose = (model.purpose ?? 'CHAT') as ModelPurpose;
    const modelRowId =
      typeof model.id === 'string' && model.id ? model.id : `temp-group-${index}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        id: modelRowId,
        model_id: (model.modelId ?? model.model_id ?? '') as string,
        display_name: (model.displayName ?? model.display_name ?? '') as string,
        thinking_budget: (model.thinkingDepth ?? model.thinking_budget ?? 'medium') as ThinkingBudget,
        max_tokens: toFiniteNumber(model.maxTokens ?? model.max_tokens, 4096),
        temperature: toFiniteNumber(model.temperature, 0.3),
        purposes: [],
        default_purposes: [],
        purpose_ids: {},
      });
    }

    const groupedModel = grouped.get(key);
    if (!groupedModel) return;

    groupedModel.purpose_ids[purpose] = modelRowId;
    groupedModel.purposes = sortModelPurposes([...groupedModel.purposes, purpose]);

    if (Boolean(model.isDefault ?? model.is_default ?? false)) {
      groupedModel.default_purposes = sortModelPurposes([
        ...groupedModel.default_purposes,
        purpose,
      ]);
    }
  });

  return Array.from(grouped.values());
}

function mapProviderFromResponse(provider: Record<string, unknown>): LlmProvider {
  return {
    id: provider.id as string,
    name: (provider.name ?? '') as string,
    api_key: (provider.apiKey ?? '') as string,
    has_api_key: Boolean(provider.hasApiKey ?? provider.apiKey),
    masked_api_key: (provider.maskedApiKey ?? '') as string,
    api_url: (provider.apiBase ?? '') as string,
    is_anthropic_native: Boolean(provider.isAnthropic ?? false),
    models: groupProviderModels((provider.models as Record<string, unknown>[]) ?? []),
  };
}

function expandProviderModelsForSave(models: LlmModel[]) {
  let sortOrder = 0;

  return models.flatMap((model) =>
    sortModelPurposes(model.purposes).map((purpose) => ({
      id: model.purpose_ids[purpose] ?? `temp-${model.id}-${purpose}`,
      modelId: model.model_id,
      displayName: model.display_name,
      thinkingDepth: model.thinking_budget,
      maxTokens: model.max_tokens,
      temperature: model.temperature,
      purpose,
      isDefault: model.default_purposes.includes(purpose),
      sortOrder: sortOrder++,
    }))
  );
}

// 标签页配置
const settingsTabs: { id: SettingsTab; label: string; icon: typeof Globe }[] = [
  { id: 'site', label: 'Site Info', icon: Globe },
  { id: 'registration', label: 'Registration', icon: UserPlus },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'asr', label: 'ASR', icon: Cpu },
  { id: 'llm', label: 'LLM', icon: Server },
  { id: 'security', label: 'Security', icon: Shield },
];

// 站点设置默认值
const defaultSettings: SiteSettingsData = {
  site_name: 'LectureLive',
  site_description: '',
  site_url: 'http://localhost:3000',
  site_url_alt: '',
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
  cloudreve_token: '',
  local_path: './data',
  max_file_size: '500',
  theme: 'cream',
  language: 'en',
  default_region: 'auto',
  default_source_lang: 'en',
  default_target_lang: 'zh',
  translation_mode: 'soniox',
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
      if (res.ok) {
        const data = await res.json();
        onUploaded(data.path || '');
      }
    } catch (err) {
      console.error('图标上传失败:', err);
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

// ──── LLM 子组件 ────

/** 模型行组件 — 展示/编辑单个模型 */
function ModelRow({
  model,
  onUpdate,
  onDelete,
}: {
  model: LlmModel;
  onUpdate: (updated: LlmModel) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();

  const togglePurpose = (purpose: ModelPurpose, enabled: boolean) => {
    if (!enabled && model.purposes.length === 1 && model.purposes.includes(purpose)) {
      return;
    }

    const purposes = enabled
      ? sortModelPurposes([...model.purposes, purpose])
      : model.purposes.filter((item) => item !== purpose);
    const defaultPurposes = enabled
      ? model.default_purposes
      : model.default_purposes.filter((item) => item !== purpose);

    onUpdate({
      ...model,
      purposes,
      default_purposes: sortModelPurposes(defaultPurposes),
    });
  };

  const toggleDefaultPurpose = (purpose: ModelPurpose, enabled: boolean) => {
    if (!model.purposes.includes(purpose)) {
      return;
    }

    const defaultPurposes = enabled
      ? sortModelPurposes([...model.default_purposes, purpose])
      : model.default_purposes.filter((item) => item !== purpose);

    onUpdate({
      ...model,
      default_purposes: sortModelPurposes(defaultPurposes),
    });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-2 items-end p-3 bg-cream-50 dark:bg-charcoal-750 rounded-lg border border-cream-100 dark:border-charcoal-600">
      {/* 模型 ID */}
      <div className="md:col-span-1">
        <label className="text-xs text-charcoal-500 dark:text-charcoal-400 mb-0.5 block">{t('adminSettings.modelId')}</label>
        <input
          type="text"
          value={model.model_id}
          onChange={(e) => onUpdate({ ...model, model_id: e.target.value })}
          placeholder="model-id"
          className="w-full px-2 py-1.5 text-xs border border-cream-200 rounded bg-white text-charcoal-800
                     dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                     focus:outline-none focus:ring-1 focus:ring-rust-200"
        />
      </div>

      {/* 显示名称 */}
      <div className="md:col-span-1">
        <label className="text-xs text-charcoal-500 dark:text-charcoal-400 mb-0.5 block">{t('adminSettings.modelDisplayName')}</label>
        <input
          type="text"
          value={model.display_name}
          onChange={(e) => onUpdate({ ...model, display_name: e.target.value })}
          placeholder={t('adminSettings.modelDisplayName')}
          className="w-full px-2 py-1.5 text-xs border border-cream-200 rounded bg-white text-charcoal-800
                     dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                     focus:outline-none focus:ring-1 focus:ring-rust-200"
        />
      </div>

      {/* 思考深度 */}
      <div>
        <label className="text-xs text-charcoal-500 dark:text-charcoal-400 mb-0.5 block">{t('adminSettings.thinkingDepth')}</label>
        <select
          value={model.thinking_budget}
          onChange={(e) => onUpdate({ ...model, thinking_budget: e.target.value as ThinkingBudget })}
          className="w-full px-2 py-1.5 text-xs border border-cream-200 rounded bg-white text-charcoal-800
                     dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                     focus:outline-none focus:ring-1 focus:ring-rust-200"
        >
          <option value="low">{t('adminSettings.thinkingLow')}</option>
          <option value="medium">{t('adminSettings.thinkingMedium')}</option>
          <option value="high">{t('adminSettings.thinkingHigh')}</option>
        </select>
      </div>

      {/* 最大 Token 数 */}
      <div>
        <label className="text-xs text-charcoal-500 dark:text-charcoal-400 mb-0.5 block">{t('adminSettings.maxTokens')}</label>
        <input
          type="number"
          value={model.max_tokens}
          onChange={(e) => onUpdate({ ...model, max_tokens: Number(e.target.value) })}
          className="w-full px-2 py-1.5 text-xs border border-cream-200 rounded bg-white text-charcoal-800
                     dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                     focus:outline-none focus:ring-1 focus:ring-rust-200"
        />
      </div>

      {/* 温度 */}
      <div>
        <label className="text-xs text-charcoal-500 dark:text-charcoal-400 mb-0.5 block">{t('adminSettings.temperature')}</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={model.temperature}
          onChange={(e) => onUpdate({ ...model, temperature: Number(e.target.value) })}
          className="w-full px-2 py-1.5 text-xs border border-cream-200 rounded bg-white text-charcoal-800
                     dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                     focus:outline-none focus:ring-1 focus:ring-rust-200"
        />
      </div>

      {/* 用途 */}
      <div className="xl:col-span-2">
        <label className="text-xs text-charcoal-500 dark:text-charcoal-400 mb-0.5 block">{t('adminSettings.purpose')}</label>
        <div className="space-y-1.5 rounded border border-cream-200 bg-white p-2 dark:border-charcoal-600 dark:bg-charcoal-700">
          {MODEL_PURPOSES.map((purpose) => {
            const selected = model.purposes.includes(purpose);
            const isDefault = model.default_purposes.includes(purpose);

            return (
              <div key={purpose} className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-xs text-charcoal-700 dark:text-cream-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => togglePurpose(purpose, e.target.checked)}
                    className="rounded border-cream-300 text-rust-500 focus:ring-rust-200"
                  />
                  <span>{getPurposeLabel(t, purpose)}</span>
                </label>
                <label
                  className={`flex items-center gap-1 text-[11px] cursor-pointer ${
                    selected
                      ? 'text-charcoal-500 dark:text-charcoal-300'
                      : 'text-charcoal-300 dark:text-charcoal-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isDefault}
                    disabled={!selected}
                    onChange={(e) => toggleDefaultPurpose(purpose, e.target.checked)}
                    className="rounded border-cream-300 text-rust-500 focus:ring-rust-200 disabled:opacity-50"
                  />
                  {t('adminSettings.isDefault')}
                </label>
              </div>
            );
          })}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 xl:justify-end">
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-charcoal-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          title={t('common.delete')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** LLM 供应商卡片（可展开/折叠） */
function ProviderCard({
  provider,
  onUpdate,
  onDelete,
  onSaveProvider,
}: {
  provider: LlmProvider;
  onUpdate: (updated: LlmProvider) => void;
  onDelete: () => void;
  onSaveProvider: (provider: LlmProvider) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // 更新单个模型
  const handleModelUpdate = (index: number, updatedModel: LlmModel) => {
    const newModels = [...provider.models];
    newModels[index] = updatedModel;
    onUpdate({ ...provider, models: newModels });
  };

  // 删除模型
  const handleModelDelete = (index: number) => {
    const newModels = provider.models.filter((_, i) => i !== index);
    onUpdate({ ...provider, models: newModels });
  };

  // 添加新模型
  const handleAddModel = () => {
    const newModel: LlmModel = {
      id: `temp-${Date.now()}`,
      model_id: '',
      display_name: '',
      thinking_budget: 'medium',
      max_tokens: 4096,
      temperature: 0.7,
      purposes: ['CHAT'],
      default_purposes: [],
      purpose_ids: {},
    };
    onUpdate({ ...provider, models: [...provider.models, newModel] });
  };

  return (
    <div className="bg-white rounded-xl border border-cream-200 dark:bg-charcoal-800 dark:border-charcoal-700 overflow-hidden">
      {/* 卡片头部 — 点击展开/折叠 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-cream-50 dark:hover:bg-charcoal-750 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-charcoal-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-charcoal-400" />
          )}
          <span className="text-sm font-medium text-charcoal-800 dark:text-cream-100">
            {provider.name || t('adminSettings.providerName')}
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-charcoal-400 dark:text-charcoal-500">
          {provider.has_api_key && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">
              {provider.masked_api_key || 'API Key saved'}
            </span>
          )}
          <span className="truncate max-w-[200px]">{provider.api_url || t('adminSettings.apiUrl')}</span>
          <span className="bg-cream-100 dark:bg-charcoal-700 px-2 py-0.5 rounded-full">
            {provider.models.length}
          </span>
        </div>
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-cream-100 dark:border-charcoal-700 space-y-4 pt-4">
          {/* 供应商基本信息 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-charcoal-600 dark:text-cream-300 mb-1 block">{t('adminSettings.providerName')}</label>
              <input
                type="text"
                value={provider.name}
                onChange={(e) => onUpdate({ ...provider, name: e.target.value })}
                placeholder={t('adminSettings.providerNamePlaceholder')}
                className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg bg-white text-charcoal-800
                           dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                           focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300 transition-colors"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-charcoal-600 dark:text-cream-300 mb-1 block">{t('adminSettings.apiUrl')}</label>
              <input
                type="text"
                value={provider.api_url}
                onChange={(e) => onUpdate({ ...provider, api_url: e.target.value })}
                placeholder="https://api.anthropic.com"
                className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg bg-white text-charcoal-800
                           dark:bg-charcoal-700 dark:border-charcoal-600 dark:text-cream-100
                           focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300 transition-colors"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-charcoal-600 dark:text-cream-300 mb-1 block">API Key</label>
              <TextInput
                value={provider.api_key}
                onChange={(v) => onUpdate({ ...provider, api_key: v })}
                type="password"
                placeholder={
                  provider.has_api_key && !provider.api_key
                    ? 'Leave blank to keep the current key'
                    : 'sk-...'
                }
              />
              {provider.has_api_key && !provider.api_key ? (
                <p className="mt-1 text-xs text-charcoal-400 dark:text-charcoal-500">
                  API key already stored securely as {provider.masked_api_key || '****'}. Leave this blank to keep it unchanged.
                </p>
              ) : null}
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-charcoal-700 dark:text-cream-200 cursor-pointer">
                <ToggleSwitch
                  checked={provider.is_anthropic_native}
                  onChange={(v) => onUpdate({ ...provider, is_anthropic_native: v })}
                />
                {t('adminSettings.isAnthropicApi')}
              </label>
            </div>
          </div>

          {/* 模型列表 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-charcoal-600 dark:text-cream-300 uppercase tracking-wider">
                {t('adminSettings.modelList')}
              </span>
              <button
                type="button"
                onClick={handleAddModel}
                className="flex items-center gap-1 px-2 py-1 text-xs text-rust-600 dark:text-rust-400 hover:bg-rust-50 dark:hover:bg-charcoal-700 rounded transition-colors"
              >
                <Plus className="w-3 h-3" />
                {t('adminSettings.addModel')}
              </button>
            </div>
            <div className="space-y-2">
              {provider.models.map((model, idx) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  onUpdate={(updated) => handleModelUpdate(idx, updated)}
                  onDelete={() => handleModelDelete(idx)}
                />
              ))}
              {provider.models.length === 0 && (
                <div className="text-center py-4 text-xs text-charcoal-400 dark:text-charcoal-500">
                  {t('adminSettings.noModels')}
                </div>
              )}
            </div>
          </div>

          {/* 卡片底部操作 */}
          <div className="flex items-center justify-between pt-2 border-t border-cream-100 dark:border-charcoal-700">
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('adminSettings.deleteProvider')}
            </button>
            <button
              type="button"
              onClick={() => onSaveProvider(provider)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-rust-500 hover:bg-rust-600 rounded-lg transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              {t('adminSettings.saveProvider')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ──── 各标签页面板 ────

/** 站点信息设置 */
function SiteInfoPanel({
  settings,
  onChange,
}: {
  settings: SiteSettingsData;
  onChange: (key: string, value: string) => void;
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

      <SettingField label={t('adminSettings.altUrl')} description={t('adminSettings.altUrlDesc')}>
        <TextInput value={settings.site_url_alt} onChange={(v) => onChange('site_url_alt', v)} placeholder="https://alt.example.com" />
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
            <TextInput value={settings.cloudreve_url} onChange={(v) => onChange('cloudreve_url', v)} placeholder="http://localhost:5212" />
          </SettingField>
          <SettingField label={t('adminSettings.cloudreveToken')} description={t('adminSettings.cloudreveTokenDesc')}>
            <TextInput value={settings.cloudreve_token} onChange={(v) => onChange('cloudreve_token', v)} type="password" />
          </SettingField>
        </>
      )}
      <SettingField label={t('adminSettings.maxUploadSize')} description={t('adminSettings.maxUploadSizeDesc')}>
        <TextInput value={settings.max_file_size} onChange={(v) => onChange('max_file_size', v)} type="number" />
      </SettingField>
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
        setSonioxError('请至少输入一个区域的 API Key');
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
        setSonioxError(data.error || '保存失败');
        return;
      }

      setSonioxSuccess('Soniox API Key 已更新');
      setNewKeys({ us: '', eu: '', jp: '' });

      // 重新加载配置状态
      const refreshRes = await fetch('/api/admin/soniox');
      if (refreshRes.ok) {
        setSonioxConfig(await refreshRes.json());
      }

      setTimeout(() => setSonioxSuccess(''), 3000);
    } catch {
      setSonioxError('保存失败，请检查网络连接');
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
        setSonioxSuccess(`${SONIOX_REGION_LABELS[region]} API Key 已删除`);
        setTimeout(() => setSonioxSuccess(''), 3000);
      }
    } catch {
      setSonioxError('删除失败');
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
    </div>
  );
}

/** LLM 设置面板 — 完全重新设计 */
function LlmPanel({
  providers,
  setProviders,
}: {
  providers: LlmProvider[];
  setProviders: React.Dispatch<React.SetStateAction<LlmProvider[]>>;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);

  // 更新某个供应商
  const handleProviderUpdate = (index: number, updated: LlmProvider) => {
    const newProviders = [...providers];
    newProviders[index] = updated;
    setProviders(newProviders);
  };

  // 保存单个供应商到后端（前端 snake_case → 后端 camelCase 映射）
  const handleSaveProvider = async (provider: LlmProvider) => {
    setSaving(true);
    try {
      const isNew = provider.id.startsWith('temp-');
      const url = isNew ? '/api/admin/llm-providers' : `/api/admin/llm-providers/${provider.id}`;
      const method = isNew ? 'POST' : 'PATCH';
      const trimmedApiKey = provider.api_key.trim();
      // 映射为后端期望的 camelCase 字段（包含模型数据）
      const payload = {
        name: provider.name,
        apiBase: provider.api_url,
        isAnthropic: provider.is_anthropic_native,
        ...(trimmedApiKey || isNew ? { apiKey: trimmedApiKey } : {}),
        models: expandProviderModelsForSave(provider.models),
      };
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        const saved = data.provider ?? data;
        const mapped = mapProviderFromResponse(saved as Record<string, unknown>);
        setProviders((prev) =>
          prev.map((p) => (p.id === provider.id ? mapped : p))
        );
      }
    } catch (err) {
      console.error('保存供应商失败:', err);
    } finally {
      setSaving(false);
    }
  };

  // 删除供应商
  const handleDeleteProvider = async (provider: LlmProvider) => {
    const isNew = provider.id.startsWith('temp-');
    if (!isNew) {
      try {
        await fetch(`/api/admin/llm-providers/${provider.id}`, { method: 'DELETE' });
      } catch (err) {
        console.error('删除供应商失败:', err);
        return;
      }
    }
    setProviders((prev) => prev.filter((p) => p.id !== provider.id));
  };

  // 添加新供应商
  const handleAddProvider = () => {
    const newProvider: LlmProvider = {
      id: `temp-${Date.now()}`,
      name: '',
      api_key: '',
      has_api_key: false,
      masked_api_key: '',
      api_url: '',
      is_anthropic_native: false,
      models: [],
    };
    setProviders((prev) => [...prev, newProvider]);
  };

  return (
    <div className="space-y-4">
      {/* 用途说明 */}
      <div className="bg-cream-50 dark:bg-charcoal-750 rounded-lg p-4 border border-cream-100 dark:border-charcoal-700">
        <div className="text-xs font-medium text-charcoal-600 dark:text-cream-300 mb-2">{t('adminSettings.purposeDesc')}</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-charcoal-500 dark:text-charcoal-400">
          <div><span className="font-medium text-charcoal-700 dark:text-cream-200">{t('adminSettings.purposeChat')}</span> — {t('adminSettings.purposeChatDesc')}</div>
          <div><span className="font-medium text-charcoal-700 dark:text-cream-200">{t('adminSettings.purposeRealtimeSummary')}</span> — {t('adminSettings.purposeRealtimeSummaryDesc')}</div>
          <div><span className="font-medium text-charcoal-700 dark:text-cream-200">{t('adminSettings.purposeFinalSummary')}</span> — {t('adminSettings.purposeFinalSummaryDesc')}</div>
          <div><span className="font-medium text-charcoal-700 dark:text-cream-200">{t('adminSettings.purposeKeywordExtraction')}</span> — {t('adminSettings.purposeKeywordExtractionDesc')}</div>
        </div>
      </div>

      {/* 供应商列表 */}
      {providers.map((provider, idx) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          onUpdate={(updated) => handleProviderUpdate(idx, updated)}
          onDelete={() => handleDeleteProvider(provider)}
          onSaveProvider={handleSaveProvider}
        />
      ))}

      {providers.length === 0 && (
        <div className="text-center py-8 text-sm text-charcoal-400 dark:text-charcoal-500">
          {t('adminSettings.noProviders')}
        </div>
      )}

      {/* 添加供应商按钮 */}
      <button
        type="button"
        onClick={handleAddProvider}
        disabled={saving}
        className="w-full flex items-center justify-center gap-2 py-3 text-sm text-rust-600 dark:text-rust-400 border-2 border-dashed border-cream-200 dark:border-charcoal-600 rounded-xl hover:bg-cream-50 dark:hover:bg-charcoal-750 transition-colors"
      >
        <Plus className="w-4 h-4" />
        {t('adminSettings.addProvider')}
      </button>
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
  const [activeTab, setActiveTab] = useState<SettingsTab>('site');
  const [settings, setSettings] = useState<SiteSettingsData>(defaultSettings);
  const [originalSettings, setOriginalSettings] = useState<SiteSettingsData>(defaultSettings);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
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

  // 加载 LLM 供应商配置（后端 camelCase → 前端 snake_case 映射）
  useEffect(() => {
    const loadProviders = async () => {
      try {
        const res = await fetch('/api/admin/llm-providers');
        if (res.ok) {
          const data = await res.json();
          const raw = data.providers ?? (Array.isArray(data) ? data : []);
          const mapped: LlmProvider[] = raw.map((p: Record<string, unknown>) =>
            mapProviderFromResponse(p)
          );
          setProviders(mapped);
        }
      } catch (err) {
        console.error('加载 LLM 供应商失败:', err);
      }
    };
    loadProviders();
  }, []);

  // 主题切换由 ThemeProvider 管理，此处无需直接操作 DOM

  // 更新字符串类型的设置
  const handleChange = useCallback((key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 更新布尔类型的设置
  const handleToggle = useCallback((key: string, value: boolean) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 重置设置为上次保存的状态
  const handleReset = () => {
    setSettings(originalSettings);
  };

  // 保存站点设置到后端
  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        setOriginalSettings(settings);
      }
    } catch (err) {
      console.error('保存设置失败:', err);
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
        return <SiteInfoPanel settings={settings} onChange={handleChange} />;
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
      case 'llm':
        return <LlmPanel providers={providers} setProviders={setProviders} />;
      case 'security':
        return <SecurityPanel settings={settings} onChange={handleChange} onToggle={handleToggle} />;
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-charcoal-800 dark:text-cream-100">{t('adminSettings.title')}</h2>

      {/* 水平标签栏 */}
      <div className="bg-white rounded-xl border border-cream-200 dark:bg-charcoal-800 dark:border-charcoal-700 overflow-hidden">
        <div className="flex overflow-x-auto border-b border-cream-200 dark:border-charcoal-700 px-2 pt-2 gap-1 scrollbar-thin">
          {settingsTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg
                  whitespace-nowrap transition-colors flex-shrink-0
                  ${isActive
                    ? 'bg-cream-50 dark:bg-charcoal-700 text-rust-600 dark:text-rust-400 border-b-2 border-rust-500'
                    : 'text-charcoal-400 hover:text-charcoal-600 dark:hover:text-cream-300 hover:bg-cream-50 dark:hover:bg-charcoal-750'
                  }
                `}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t(tabLabelKeys[tab.id])}</span>
              </button>
            );
          })}
        </div>

        {/* 设置内容区域 */}
        <div className="p-6">
          {renderContent()}
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
