import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  isCloudreveConfiguredAsyncMock,
  buildAuthorizeUrlMock,
  generateCodeVerifierMock,
  siteSettingUpsertMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  isCloudreveConfiguredAsyncMock: vi.fn(),
  buildAuthorizeUrlMock: vi.fn(),
  generateCodeVerifierMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  isCloudreveConfiguredAsync: isCloudreveConfiguredAsyncMock,
  buildAuthorizeUrl: buildAuthorizeUrlMock,
  generateCodeVerifier: generateCodeVerifierMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      upsert: siteSettingUpsertMock,
    },
  },
}));

import { GET } from '@/app/api/admin/cloudreve/authorize/route';

describe('GET /api/admin/cloudreve/authorize', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockResolvedValue({
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        role: 'ADMIN',
      },
      response: null,
    });
    isCloudreveConfiguredAsyncMock.mockResolvedValue(true);
    generateCodeVerifierMock.mockReturnValue('verifier-123');
    buildAuthorizeUrlMock.mockResolvedValue(
      'https://cloud.example.com/session/authorize?client_id=client-1'
    );
    siteSettingUpsertMock.mockResolvedValue({});
  });

  it('支持从异步配置源读取 Cloudreve OAuth 配置并返回授权链接', async () => {
    const response = await GET(
      new Request('http://localhost:3000/api/admin/cloudreve/authorize')
    );

    expect(response.status).toBe(200);
    await expect(readJson<{ authorize_url: string }>(response)).resolves.toEqual({
      authorize_url: 'https://cloud.example.com/session/authorize?client_id=client-1',
    });
    expect(isCloudreveConfiguredAsyncMock).toHaveBeenCalledTimes(1);
    expect(siteSettingUpsertMock).toHaveBeenCalledWith({
      where: { key: 'cloudreve_code_verifier' },
      update: { value: 'verifier-123' },
      create: { key: 'cloudreve_code_verifier', value: 'verifier-123' },
    });
    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/admin/cloudreve/callback',
      'verifier-123'
    );
  });

  it('在未配置时返回 400，而不是继续写入 PKCE 状态', async () => {
    isCloudreveConfiguredAsyncMock.mockResolvedValue(false);

    const response = await GET(
      new Request('http://localhost:3000/api/admin/cloudreve/authorize')
    );

    expect(response.status).toBe(400);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({
      error: 'Cloudreve OAuth 未配置，请先设置 CLOUDREVE_BASE_URL、CLOUDREVE_CLIENT_ID、CLOUDREVE_CLIENT_SECRET',
    });
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
    expect(buildAuthorizeUrlMock).not.toHaveBeenCalled();
  });
});
