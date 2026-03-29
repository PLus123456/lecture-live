import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  exchangeAuthorizationCodeMock,
  loadTokensIntoCacheMock,
  invalidateSiteSettingsCacheMock,
  siteSettingFindManyMock,
  siteSettingUpsertMock,
  siteSettingDeleteManyMock,
  transactionMock,
} = vi.hoisted(() => ({
  exchangeAuthorizationCodeMock: vi.fn(),
  loadTokensIntoCacheMock: vi.fn(),
  invalidateSiteSettingsCacheMock: vi.fn(),
  siteSettingFindManyMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  siteSettingDeleteManyMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  exchangeAuthorizationCode: exchangeAuthorizationCodeMock,
  loadTokensIntoCache: loadTokensIntoCacheMock,
}));

vi.mock('@/lib/siteSettings', () => ({
  invalidateSiteSettingsCache: invalidateSiteSettingsCacheMock,
  getSiteSettings: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      findMany: siteSettingFindManyMock,
      upsert: siteSettingUpsertMock,
      deleteMany: siteSettingDeleteManyMock,
    },
    $transaction: transactionMock,
  },
}));

import { GET } from '@/app/api/admin/cloudreve/callback/route';

describe('GET /api/admin/cloudreve/callback', () => {
  beforeEach(() => {
    exchangeAuthorizationCodeMock.mockReset();
    loadTokensIntoCacheMock.mockReset();
    invalidateSiteSettingsCacheMock.mockReset();
    siteSettingFindManyMock.mockReset();
    siteSettingUpsertMock.mockReset();
    siteSettingDeleteManyMock.mockReset();
    transactionMock.mockReset();

    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_code_verifier', value: 'verifier-123' },
      {
        key: 'cloudreve_redirect_uri',
        value: 'https://lecture.example.com/api/admin/cloudreve/callback',
      },
    ]);
    exchangeAuthorizationCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_800_000_000_000,
    });
    siteSettingUpsertMock.mockImplementation((payload: unknown) => payload);
    siteSettingDeleteManyMock.mockImplementation((payload: unknown) => payload);
    transactionMock.mockResolvedValue([]);
  });

  it('使用授权阶段保存的 redirect_uri 交换 token，并回到外部域名', async () => {
    const response = await GET(
      new Request('http://127.0.0.1:3000/api/admin/cloudreve/callback?code=auth-code', {
        headers: {
          host: 'lecture.example.com',
          'x-forwarded-proto': 'https',
        },
      })
    );

    expect(exchangeAuthorizationCodeMock).toHaveBeenCalledWith(
      'auth-code',
      'https://lecture.example.com/api/admin/cloudreve/callback',
      'verifier-123'
    );
    expect(siteSettingDeleteManyMock).toHaveBeenCalledWith({
      where: {
        key: {
          in: ['cloudreve_code_verifier', 'cloudreve_redirect_uri'],
        },
      },
    });
    expect(loadTokensIntoCacheMock).toHaveBeenCalledWith({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_800_000_000_000,
    });
    expect(invalidateSiteSettingsCacheMock).toHaveBeenCalledTimes(1);
    expect(response.headers.get('location')).toBe(
      'https://lecture.example.com/admin?cloudreve_authorized=true'
    );
  });
});
