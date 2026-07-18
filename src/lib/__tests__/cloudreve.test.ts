import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteSettings } from '@/lib/siteSettings';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  buildAuthorizeUrl,
  clearCachedTokens,
  clearPersistedTokens,
  exchangeAuthorizationCode,
  getCloudreveAuthStatus,
  invalidateCloudreveConfigCache,
  isCloudreveAuthorizedAsync,
  isCloudreveConfiguredAsync,
} from '@/lib/storage/cloudreve';

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: vi.fn(),
}));

const siteSettingDeleteManyMock = vi.fn();
const siteSettingFindUniqueMock = vi.fn();
const siteSettingFindManyMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      deleteMany: (...args: unknown[]) => siteSettingDeleteManyMock(...args),
      findUnique: (...args: unknown[]) => siteSettingFindUniqueMock(...args),
      findMany: (...args: unknown[]) => siteSettingFindManyMock(...args),
    },
  },
}));

const mockedGetSiteSettings = vi.mocked(getSiteSettings);

function createSiteSettings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
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
    storage_mode: 'cloudreve',
    cloudreve_url: 'https://cloud.example.com/',
    cloudreve_client_id: 'site-client-id',
    cloudreve_client_secret: 'site-client-secret',
    local_path: './data',
    max_file_size: 500,
    local_retention_days: 0,
    theme: 'cream',
    language: 'zh',
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
    ...overrides,
  };
}

describe('Cloudreve OAuth 配置', () => {
  const originalEnv = {
    CLOUDREVE_BASE_URL: process.env.CLOUDREVE_BASE_URL,
    CLOUDREVE_CLIENT_ID: process.env.CLOUDREVE_CLIENT_ID,
    CLOUDREVE_CLIENT_SECRET: process.env.CLOUDREVE_CLIENT_SECRET,
  };

  beforeEach(() => {
    delete process.env.CLOUDREVE_BASE_URL;
    delete process.env.CLOUDREVE_CLIENT_ID;
    delete process.env.CLOUDREVE_CLIENT_SECRET;
    mockedGetSiteSettings.mockReset();
    siteSettingDeleteManyMock.mockReset();
    siteSettingFindUniqueMock.mockReset();
    siteSettingFindManyMock.mockReset();
    siteSettingDeleteManyMock.mockResolvedValue({ count: 0 });
    siteSettingFindUniqueMock.mockResolvedValue(null);
    siteSettingFindManyMock.mockResolvedValue([]);
    clearCachedTokens();
    invalidateCloudreveConfigCache();
  });

  afterEach(() => {
    if (originalEnv.CLOUDREVE_BASE_URL === undefined) {
      delete process.env.CLOUDREVE_BASE_URL;
    } else {
      process.env.CLOUDREVE_BASE_URL = originalEnv.CLOUDREVE_BASE_URL;
    }

    if (originalEnv.CLOUDREVE_CLIENT_ID === undefined) {
      delete process.env.CLOUDREVE_CLIENT_ID;
    } else {
      process.env.CLOUDREVE_CLIENT_ID = originalEnv.CLOUDREVE_CLIENT_ID;
    }

    if (originalEnv.CLOUDREVE_CLIENT_SECRET === undefined) {
      delete process.env.CLOUDREVE_CLIENT_SECRET;
    } else {
      process.env.CLOUDREVE_CLIENT_SECRET = originalEnv.CLOUDREVE_CLIENT_SECRET;
    }

    clearCachedTokens();
    invalidateCloudreveConfigCache();
  });

  it('在环境变量缺失时会读取后台保存的 Cloudreve 配置', async () => {
    mockedGetSiteSettings.mockResolvedValue(createSiteSettings());

    await expect(isCloudreveConfiguredAsync()).resolves.toBe(true);
  });

  it('生成符合 Cloudreve V4 文档的授权 URL', async () => {
    mockedGetSiteSettings.mockResolvedValue(createSiteSettings());

    const authorizeUrl = await buildAuthorizeUrl(
      'http://localhost:3000/api/admin/cloudreve/callback',
      'verifier-verifier-verifier-verifier-verifier-verifier'
    );
    const url = new URL(authorizeUrl);

    expect(url.origin).toBe('https://cloud.example.com');
    expect(url.pathname).toBe('/session/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('site-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/admin/cloudreve/callback'
    );
    // scope 仅请求 Files.Write —— Cloudreve V4 用 Files.Write 表示读写权限，
    // 同时请求 Files.Read + Files.Write 在部分实例会被同意页拒绝。
    expect(url.searchParams.get('scope')).toBe('openid offline_access Files.Write');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('用后台保存的 client 配置交换 token', async () => {
    mockedGetSiteSettings.mockResolvedValue(createSiteSettings());

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 7200,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const startedAt = Date.now();
    const tokens = await exchangeAuthorizationCode(
      'auth-code',
      'http://localhost:3000/api/admin/cloudreve/callback',
      'verifier-verifier-verifier-verifier-verifier-verifier'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cloud.example.com/api/v4/session/oauth/token');

    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    const body = requestInit?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('site-client-id');
    expect(body.get('client_secret')).toBe('site-client-secret');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toBe('http://localhost:3000/api/admin/cloudreve/callback');
    expect(body.get('code_verifier')).toBe(
      'verifier-verifier-verifier-verifier-verifier-verifier'
    );

    expect(tokens).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(startedAt + 7190 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(startedAt + 7210 * 1000);
  });

  it('Cloudreve V4 返回 code !== 0 时拒绝写入 token，避免把 undefined 缓存', async () => {
    mockedGetSiteSettings.mockResolvedValue(createSiteSettings());

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 40001,
          msg: 'invalid grant',
          data: {},
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      exchangeAuthorizationCode(
        'auth-code',
        'http://localhost:3000/api/admin/cloudreve/callback',
        'verifier-verifier-verifier-verifier-verifier-verifier'
      )
    ).rejects.toThrow(/40001|invalid grant/);
  });

  it('响应缺少 access_token 时也要拒绝，绝不能写入空字符串', async () => {
    mockedGetSiteSettings.mockResolvedValue(createSiteSettings());

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          // 没有 access_token
          refresh_token: 'rt',
          expires_in: 7200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      exchangeAuthorizationCode(
        'auth-code',
        'http://localhost:3000/api/admin/cloudreve/callback',
        'verifier-verifier-verifier-verifier-verifier-verifier'
      )
    ).rejects.toThrow(/access_token|refresh_token/);
  });

  it('clearPersistedTokens 同时清除内存缓存与数据库三行', async () => {
    siteSettingDeleteManyMock.mockResolvedValue({ count: 3 });

    await clearPersistedTokens();

    expect(siteSettingDeleteManyMock).toHaveBeenCalledWith({
      where: {
        key: {
          in: [
            'cloudreve_access_token',
            'cloudreve_refresh_token',
            'cloudreve_token_expires_at',
          ],
        },
      },
    });
  });

  it('isCloudreveAuthorizedAsync 在数据库存有 refresh_token 时返回 true', async () => {
    siteSettingFindUniqueMock.mockResolvedValue({
      key: 'cloudreve_refresh_token',
      value: 'enc:v2:abc:def:ghi',
    });

    await expect(isCloudreveAuthorizedAsync()).resolves.toBe(true);
  });

  it('isCloudreveAuthorizedAsync 在没有 refresh_token 时返回 false', async () => {
    siteSettingFindUniqueMock.mockResolvedValue(null);

    await expect(isCloudreveAuthorizedAsync()).resolves.toBe(false);
  });

  it('getCloudreveAuthStatus 返回授权状态与过期时间', async () => {
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_refresh_token', value: 'enc:v2:abc:def:ghi' },
      { key: 'cloudreve_token_expires_at', value: '1800000000000' },
    ]);

    const status = await getCloudreveAuthStatus();
    expect(status.authorized).toBe(true);
    expect(status.expiresAt).toBe(1800000000000);
  });
});
