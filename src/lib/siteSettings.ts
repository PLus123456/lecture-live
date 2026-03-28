import 'server-only';

import { prisma } from '@/lib/prisma';

export interface SiteSettings {
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
  allow_registration: boolean;
  default_group: 'FREE' | 'PRO' | 'ADMIN';
  email_verification: boolean;
  password_min_length: number;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  sender_name: string;
  sender_email: string;
  storage_mode: 'local' | 'cloudreve';
  cloudreve_url: string;
  cloudreve_token: string;
  local_path: string;
  max_file_size: number;
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
}

const SITE_SETTINGS_CACHE_TTL_MS = 60_000;

const DEFAULT_SITE_SETTINGS: SiteSettings = {
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
  password_min_length: 8,
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_password: '',
  sender_name: 'LectureLive',
  sender_email: '',
  storage_mode: 'local',
  cloudreve_url: '',
  cloudreve_token: '',
  local_path: './data',
  max_file_size: 500,
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

function parseEnum<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  if (!value) return fallback;
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeSiteSettings(raw: Record<string, string>): SiteSettings {
  return {
    ...DEFAULT_SITE_SETTINGS,
    ...raw,
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
    password_min_length: String(settings.password_min_length),
    smtp_port: String(settings.smtp_port),
    max_file_size: String(settings.max_file_size),
    rate_limit_auth: String(settings.rate_limit_auth),
    rate_limit_api: String(settings.rate_limit_api),
    jwt_expiry: String(settings.jwt_expiry),
    bcrypt_rounds: String(settings.bcrypt_rounds),
    trusted_proxy: settings.trusted_proxy,
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
    site_url_alt: settings.site_url_alt,
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
