import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteSettings } from '@/lib/siteSettings';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  buildAuthorizeUrl,
  clearCachedTokens,
  exchangeAuthorizationCode,
  invalidateCloudreveConfigCache,
  isCloudreveConfiguredAsync,
} from '@/lib/storage/cloudreve';

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: vi.fn(),
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
    sender_name: 'LectureLive',
    sender_email: '',
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
    expect(url.searchParams.get('scope')).toBe('openid offline_access Files.Read Files.Write');
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
});
