import 'server-only';

import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';

/**
 * 需要「静态加密落库 + 管理后台 GET 脱敏」的敏感设置键。
 * 与 LLM/Soniox 凭据一致：这些值在 SiteSetting 表里加密存储，对外只回脱敏占位。
 */
export const SENSITIVE_SETTING_KEYS = [
  'smtp_password',
  'cloudreve_client_secret',
  'audio_enhance_worker_token',
] as const;

/**
 * 脱敏占位符。管理后台 GET 时已设置的敏感值回传它（表示"已配置但隐藏"）；
 * PUT 收到它（或空串）表示"保持原值不变"，避免脱敏值被回存导致密钥被清空。
 */
export const SETTING_SECRET_MASK = '********';

/** 读取敏感设置：解密落库值（明文/未加密值原样返回，兼容历史数据）。 */
function decryptSensitiveSetting(value: string | undefined): string {
  if (!value) return '';
  try {
    return decrypt(value);
  } catch {
    // 解密失败（如轮换 ENCRYPTION_KEY 后旧值不匹配）不抛错，回空避免拖垮整个设置读取。
    return '';
  }
}

export interface SiteSettings {
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
  allow_registration: boolean;
  default_group: 'FREE' | 'PRO' | 'ADMIN';
  email_verification: boolean;
  password_min_length: number;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  smtp_secure: boolean;              // 隐式 TLS（通常 465 端口）；false 时若服务器支持则走 STARTTLS
  sender_name: string;
  sender_email: string;
  // 注册域名管控（教育邮箱白名单 + 一次性邮箱拦截）
  block_disposable_email: boolean;   // 开启后拦截一次性/临时邮箱域名注册
  disposable_email_extra: string;    // 管理员追加的一次性邮箱域名（逗号/换行分隔），与内置列表合并
  email_domain_allowlist: string;    // 允许注册的域名白名单（逗号/换行分隔，如 edu.cn,stanford.edu）；空=不限制
  email_domain_allowlist_enforce: boolean; // true=只有白名单域名能注册；false=白名单仅作标记（教育邮箱识别）
  // 营销/通知邮件站点级总开关（关闭则一律不发促销类邮件，无视个人偏好；事务类邮件不受影响）
  marketing_emails_enabled: boolean;
  storage_mode: 'local' | 'cloudreve';
  cloudreve_url: string;
  cloudreve_client_id: string;
  cloudreve_client_secret: string;
  local_path: string;
  max_file_size: number;
  local_retention_days: number;
  theme: 'cream' | 'dark';
  language: 'en' | 'zh';
  default_region: 'auto' | 'us' | 'eu' | 'jp';
  default_source_lang: string;
  default_target_lang: string;
  translation_mode: 'soniox' | 'local' | 'both';
  rate_limit_auth: number;
  rate_limit_api: number;
  jwt_expiry: number;
  bcrypt_rounds: number;
  trusted_proxy: boolean;
  // Chat 文件配额 & 清理（U13 引入；U14 cron / U2 quota 共用）
  chat_files_retention_days: number;     // 0 = 关闭定期清理
  chat_files_soft_cap_percent: number;   // 0 = 关闭软上限触发；否则配额占用 > N% 时 LRU 清
  chat_files_max_upload_mb: number;      // 单次上传大小硬上限（MB）
  chat_files_quota_free_mb: number;      // FREE 角色 storage_bytes 配额（MB）
  chat_files_quota_pro_mb: number;       // PRO 角色配额（MB）
  // 异步文件上传转录计费倍率（批2）：实时转录全额(1.0)；上传转录按此倍率计费，
  // 默认 0.8（8 折）。扣费与对账两侧共用此值，口径必须一致。范围 [0, 10]。
  async_upload_billing_multiplier: number;
  chat_files_quota_admin_mb: number;     // ADMIN 角色配额（MB），相当于上限
  // 录音音频增强（外部 worker 后处理：响度归一化 + 降噪）
  audio_enhance_enabled: boolean;        // 站点级总开关（组能力开关另见 GroupPermissions.allowAudioEnhance）
  audio_enhance_worker_url: string;      // worker 基址，如 https://enhance.example.com
  audio_enhance_worker_token: string;    // Bearer token（敏感，加密落库）
  audio_enhance_target_lufs: number;     // 响度目标（LUFS），默认 -14
  audio_enhance_atten_lim_db: number;    // 降噪衰减上限（dB），默认 30；越大降噪越狠、人声越干
  audio_enhance_concurrency: number;     // 主服务器同时派发给 worker 的任务数，默认 1
}

const SITE_SETTINGS_CACHE_TTL_MS = 60_000;

export const MAX_BACKUP_URLS = 10;

const DEFAULT_SITE_SETTINGS: SiteSettings = {
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
  password_min_length: 8,
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_password: '',
  smtp_secure: false,
  sender_name: 'LectureLive',
  sender_email: '',
  block_disposable_email: false,
  disposable_email_extra: '',
  email_domain_allowlist: '',
  email_domain_allowlist_enforce: false,
  marketing_emails_enabled: true,
  storage_mode: 'local',
  cloudreve_url: '',
  cloudreve_client_id: '',
  cloudreve_client_secret: '',
  local_path: './data',
  max_file_size: 500,
  local_retention_days: 0,
  theme: 'cream',
  language: 'en',
  default_region: 'auto',
  default_source_lang: 'en',
  default_target_lang: 'zh',
  translation_mode: 'soniox',
  rate_limit_auth: 5,
  rate_limit_api: 60,
  jwt_expiry: 7,
  bcrypt_rounds: 12,
  trusted_proxy: false,
  chat_files_retention_days: 14,
  chat_files_soft_cap_percent: 90,
  chat_files_max_upload_mb: 100,
  chat_files_quota_free_mb: 100,
  chat_files_quota_pro_mb: 1024,
  chat_files_quota_admin_mb: 10240,
  async_upload_billing_multiplier: 0.8,
  audio_enhance_enabled: false,
  audio_enhance_worker_url: '',
  audio_enhance_worker_token: '',
  audio_enhance_target_lufs: -14,
  audio_enhance_atten_lim_db: 30,
  audio_enhance_concurrency: 1,
};

let siteSettingsCache: SiteSettings | null = null;
let siteSettingsCacheTime = 0;

function parseBoolean(value: string | null | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(
  value: string | null | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;

  if (options?.min !== undefined && parsed < options.min) {
    return options.min;
  }

  if (options?.max !== undefined && parsed > options.max) {
    return options.max;
  }

  return parsed;
}

/** 解析浮点配置（用于计费倍率等小数值）。NaN / 缺失回落 fallback，超界 clamp。 */
function parseFloatSetting(
  value: string | null | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  const parsed = Number.parseFloat(value ?? '');
  if (!Number.isFinite(parsed)) return fallback;

  if (options?.min !== undefined && parsed < options.min) {
    return options.min;
  }

  if (options?.max !== undefined && parsed > options.max) {
    return options.max;
  }

  return parsed;
}

function parseUrlBackups(raw: Record<string, string>): string[] {
  const rawValue = raw.site_url_backups;
  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean);
        if (cleaned.length > 0) {
          return cleaned.slice(0, MAX_BACKUP_URLS);
        }
      }
    } catch {
      // Fall through to legacy migration
    }
  }

  // Legacy migration from site_url_alt
  const legacy = raw.site_url_alt?.trim();
  if (legacy) {
    return [legacy];
  }

  return [];
}

function parseEnum<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  if (!value) return fallback;
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeSiteSettings(raw: Record<string, string>): SiteSettings {
  // Avoid spreading legacy site_url_alt onto the result object — the canonical
  // field is now site_url_backups (populated via parseUrlBackups below).
  const { site_url_alt: _legacyAlt, site_url_backups: _rawBackups, ...rest } = raw;
  void _legacyAlt;
  void _rawBackups;
  return {
    ...DEFAULT_SITE_SETTINGS,
    ...rest,
    // 敏感键解密（覆盖 ...rest 里的密文，供 SMTP/Cloudreve 等消费者拿到明文）
    smtp_password: decryptSensitiveSetting(raw.smtp_password),
    cloudreve_client_secret: decryptSensitiveSetting(raw.cloudreve_client_secret),
    site_url_backups: parseUrlBackups(raw),
    allow_registration: parseBoolean(
      raw.allow_registration,
      DEFAULT_SITE_SETTINGS.allow_registration
    ),
    default_group: parseEnum(
      raw.default_group,
      ['FREE', 'PRO', 'ADMIN'] as const,
      DEFAULT_SITE_SETTINGS.default_group
    ),
    email_verification: parseBoolean(
      raw.email_verification,
      DEFAULT_SITE_SETTINGS.email_verification
    ),
    password_min_length: parseInteger(
      raw.password_min_length,
      DEFAULT_SITE_SETTINGS.password_min_length,
      { min: 8, max: 128 }
    ),
    smtp_port: parseInteger(
      raw.smtp_port,
      DEFAULT_SITE_SETTINGS.smtp_port,
      { min: 1, max: 65535 }
    ),
    smtp_secure: parseBoolean(
      raw.smtp_secure,
      DEFAULT_SITE_SETTINGS.smtp_secure
    ),
    block_disposable_email: parseBoolean(
      raw.block_disposable_email,
      DEFAULT_SITE_SETTINGS.block_disposable_email
    ),
    email_domain_allowlist_enforce: parseBoolean(
      raw.email_domain_allowlist_enforce,
      DEFAULT_SITE_SETTINGS.email_domain_allowlist_enforce
    ),
    marketing_emails_enabled: parseBoolean(
      raw.marketing_emails_enabled,
      DEFAULT_SITE_SETTINGS.marketing_emails_enabled
    ),
    storage_mode: parseEnum(
      raw.storage_mode,
      ['local', 'cloudreve'] as const,
      DEFAULT_SITE_SETTINGS.storage_mode
    ),
    max_file_size: parseInteger(
      raw.max_file_size,
      DEFAULT_SITE_SETTINGS.max_file_size,
      { min: 1, max: 10240 }
    ),
    local_retention_days: parseInteger(
      raw.local_retention_days,
      DEFAULT_SITE_SETTINGS.local_retention_days,
      { min: 0, max: 3650 }
    ),
    theme: parseEnum(
      raw.theme,
      ['cream', 'dark'] as const,
      DEFAULT_SITE_SETTINGS.theme
    ),
    language: parseEnum(
      raw.language ?? raw.default_language,
      ['en', 'zh'] as const,
      DEFAULT_SITE_SETTINGS.language
    ),
    default_region: parseEnum(
      raw.default_region ?? raw.soniox_default_region,
      ['auto', 'us', 'eu', 'jp'] as const,
      DEFAULT_SITE_SETTINGS.default_region
    ),
    translation_mode: parseEnum(
      raw.translation_mode,
      ['soniox', 'local', 'both'] as const,
      DEFAULT_SITE_SETTINGS.translation_mode
    ),
    rate_limit_auth: parseInteger(
      raw.rate_limit_auth,
      DEFAULT_SITE_SETTINGS.rate_limit_auth,
      { min: 1, max: 1000 }
    ),
    rate_limit_api: parseInteger(
      raw.rate_limit_api,
      DEFAULT_SITE_SETTINGS.rate_limit_api,
      { min: 1, max: 10000 }
    ),
    jwt_expiry: parseInteger(
      raw.jwt_expiry,
      DEFAULT_SITE_SETTINGS.jwt_expiry,
      { min: 1, max: 365 }
    ),
    bcrypt_rounds: parseInteger(
      raw.bcrypt_rounds,
      DEFAULT_SITE_SETTINGS.bcrypt_rounds,
      { min: 8, max: 15 }
    ),
    trusted_proxy: parseBoolean(
      raw.trusted_proxy,
      DEFAULT_SITE_SETTINGS.trusted_proxy
    ),
    chat_files_retention_days: parseInteger(
      raw.chat_files_retention_days,
      DEFAULT_SITE_SETTINGS.chat_files_retention_days,
      { min: 0, max: 365 }
    ),
    chat_files_soft_cap_percent: parseInteger(
      raw.chat_files_soft_cap_percent,
      DEFAULT_SITE_SETTINGS.chat_files_soft_cap_percent,
      { min: 0, max: 100 }
    ),
    chat_files_max_upload_mb: parseInteger(
      raw.chat_files_max_upload_mb,
      DEFAULT_SITE_SETTINGS.chat_files_max_upload_mb,
      { min: 1, max: 10240 }
    ),
    chat_files_quota_free_mb: parseInteger(
      raw.chat_files_quota_free_mb,
      DEFAULT_SITE_SETTINGS.chat_files_quota_free_mb,
      { min: 0, max: 1_048_576 }
    ),
    chat_files_quota_pro_mb: parseInteger(
      raw.chat_files_quota_pro_mb,
      DEFAULT_SITE_SETTINGS.chat_files_quota_pro_mb,
      { min: 0, max: 1_048_576 }
    ),
    chat_files_quota_admin_mb: parseInteger(
      raw.chat_files_quota_admin_mb,
      DEFAULT_SITE_SETTINGS.chat_files_quota_admin_mb,
      { min: 0, max: 1_048_576 }
    ),
    async_upload_billing_multiplier: parseFloatSetting(
      raw.async_upload_billing_multiplier,
      DEFAULT_SITE_SETTINGS.async_upload_billing_multiplier,
      { min: 0, max: 10 }
    ),
    audio_enhance_enabled: parseBoolean(
      raw.audio_enhance_enabled,
      DEFAULT_SITE_SETTINGS.audio_enhance_enabled
    ),
    audio_enhance_worker_token: decryptSensitiveSetting(
      raw.audio_enhance_worker_token
    ),
    audio_enhance_target_lufs: parseInteger(
      raw.audio_enhance_target_lufs,
      DEFAULT_SITE_SETTINGS.audio_enhance_target_lufs,
      { min: -30, max: -8 }
    ),
    audio_enhance_atten_lim_db: parseInteger(
      raw.audio_enhance_atten_lim_db,
      DEFAULT_SITE_SETTINGS.audio_enhance_atten_lim_db,
      { min: 6, max: 100 }
    ),
    audio_enhance_concurrency: parseInteger(
      raw.audio_enhance_concurrency,
      DEFAULT_SITE_SETTINGS.audio_enhance_concurrency,
      { min: 1, max: 4 }
    ),
  };
}

export async function getSiteSettings(options?: {
  fresh?: boolean;
}): Promise<SiteSettings> {
  const now = Date.now();
  if (
    !options?.fresh &&
    siteSettingsCache &&
    now - siteSettingsCacheTime < SITE_SETTINGS_CACHE_TTL_MS
  ) {
    return siteSettingsCache;
  }

  const rows = await prisma.siteSetting.findMany();
  const raw: Record<string, string> = {};
  for (const row of rows) {
    raw[row.key] = row.value;
  }

  const normalized = normalizeSiteSettings(raw);
  siteSettingsCache = normalized;
  siteSettingsCacheTime = now;
  return normalized;
}

export function invalidateSiteSettingsCache() {
  siteSettingsCache = null;
  siteSettingsCacheTime = 0;
}

export function serializeSiteSettingsForAdmin(settings: SiteSettings) {
  return {
    ...settings,
    // 安全：敏感凭据对外只回脱敏占位（已设置→掩码，未设置→空），杜绝明文经 GET 回传/缓存。
    smtp_password: settings.smtp_password ? SETTING_SECRET_MASK : '',
    cloudreve_client_secret: settings.cloudreve_client_secret
      ? SETTING_SECRET_MASK
      : '',
    audio_enhance_worker_token: settings.audio_enhance_worker_token
      ? SETTING_SECRET_MASK
      : '',
    password_min_length: String(settings.password_min_length),
    smtp_port: String(settings.smtp_port),
    max_file_size: String(settings.max_file_size),
    local_retention_days: String(settings.local_retention_days),
    rate_limit_auth: String(settings.rate_limit_auth),
    rate_limit_api: String(settings.rate_limit_api),
    jwt_expiry: String(settings.jwt_expiry),
    bcrypt_rounds: String(settings.bcrypt_rounds),
    trusted_proxy: settings.trusted_proxy,
    chat_files_retention_days: String(settings.chat_files_retention_days),
    chat_files_soft_cap_percent: String(settings.chat_files_soft_cap_percent),
    chat_files_max_upload_mb: String(settings.chat_files_max_upload_mb),
    chat_files_quota_free_mb: String(settings.chat_files_quota_free_mb),
    chat_files_quota_pro_mb: String(settings.chat_files_quota_pro_mb),
    chat_files_quota_admin_mb: String(settings.chat_files_quota_admin_mb),
    async_upload_billing_multiplier: String(settings.async_upload_billing_multiplier),
    audio_enhance_target_lufs: String(settings.audio_enhance_target_lufs),
    audio_enhance_atten_lim_db: String(settings.audio_enhance_atten_lim_db),
    audio_enhance_concurrency: String(settings.audio_enhance_concurrency),
  };
}

export function toPublicSiteConfig(settings: SiteSettings) {
  return {
    site_name: settings.site_name,
    site_description: settings.site_description,
    site_announcement: settings.site_announcement,
    footer_code: settings.footer_code,
    terms_url: settings.terms_url,
    privacy_url: settings.privacy_url,
    logo_path: settings.logo_path,
    favicon_path: settings.favicon_path,
    site_url: settings.site_url,
    site_url_backups: settings.site_url_backups,
    allow_registration: settings.allow_registration,
    password_min_length: settings.password_min_length,
    theme: settings.theme,
    language: settings.language,
    default_region: settings.default_region,
    default_source_lang: settings.default_source_lang,
    default_target_lang: settings.default_target_lang,
    translation_mode: settings.translation_mode,
  };
}
