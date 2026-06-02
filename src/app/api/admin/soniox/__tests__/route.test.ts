import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 仅 mock 数据访问/鉴权/缓存失效；validateCloudreveBaseUrl 保持真实，
// 真正验证 wsUrl/restUrl 的「非法/私网地址被拒」SSRF 防线。
const {
  requireAdminAccessMock,
  siteSettingUpsertMock,
  siteSettingDeleteManyMock,
  siteSettingFindFirstMock,
  invalidateSiteSettingsCacheMock,
  invalidateSonioxDbConfigCacheMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  siteSettingDeleteManyMock: vi.fn(),
  siteSettingFindFirstMock: vi.fn(),
  invalidateSiteSettingsCacheMock: vi.fn(),
  invalidateSonioxDbConfigCacheMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      upsert: siteSettingUpsertMock,
      deleteMany: siteSettingDeleteManyMock,
      findFirst: siteSettingFindFirstMock,
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

vi.mock('@/lib/siteSettings', () => ({
  invalidateSiteSettingsCache: invalidateSiteSettingsCacheMock,
}));

vi.mock('@/lib/soniox/env', () => ({
  invalidateSonioxDbConfigCache: invalidateSonioxDbConfigCacheMock,
}));

import { PUT } from '@/app/api/admin/soniox/route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/soniox', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/admin/soniox', () => {
  const originalAllowPrivate = process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;

  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    siteSettingUpsertMock.mockReset();
    siteSettingDeleteManyMock.mockReset();
    siteSettingFindFirstMock.mockReset();
    invalidateSiteSettingsCacheMock.mockReset();
    invalidateSonioxDbConfigCacheMock.mockReset();

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
      response: null,
    });
    siteSettingUpsertMock.mockResolvedValue({});
    siteSettingDeleteManyMock.mockResolvedValue({ count: 0 });
    siteSettingFindFirstMock.mockResolvedValue(null);
    delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
  });

  afterEach(() => {
    if (originalAllowPrivate === undefined) {
      delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
    } else {
      process.env.CLOUDREVE_ALLOW_PRIVATE_HOST = originalAllowPrivate;
    }
  });

  it('拒绝非 ws(s) 协议的 wsUrl', async () => {
    const res = await PUT(makeRequest({ regions: { us: { wsUrl: 'https://evil.example.com' } } }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('wsUrl') });
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('拒绝指向内网的 wsUrl（SSRF 防护）', async () => {
    const res = await PUT(
      makeRequest({ regions: { us: { wsUrl: 'wss://127.0.0.1/transcribe-websocket' } } })
    );
    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('拒绝指向内网的 restUrl（SSRF 防护）', async () => {
    const res = await PUT(makeRequest({ regions: { us: { restUrl: 'http://169.254.169.254/' } } }));
    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('拒绝非法 restUrl（不是合法 URL）', async () => {
    const res = await PUT(makeRequest({ regions: { us: { restUrl: 'not-a-url' } } }));
    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('合法 wss/https 地址可写入，并去掉尾部斜杠', async () => {
    const res = await PUT(
      makeRequest({
        regions: {
          us: {
            wsUrl: 'wss://stt-rt.soniox.example/transcribe-websocket/',
            restUrl: 'https://api.soniox.example/',
          },
        },
      })
    );
    expect(res.status).toBe(200);

    const wsCall = siteSettingUpsertMock.mock.calls.find(
      (c) => (c[0] as { where: { key: string } }).where.key === 'soniox_US_ws_url'
    );
    const restCall = siteSettingUpsertMock.mock.calls.find(
      (c) => (c[0] as { where: { key: string } }).where.key === 'soniox_US_rest_url'
    );
    expect((wsCall?.[0] as { create: { value: string } }).create.value).toBe(
      'wss://stt-rt.soniox.example/transcribe-websocket'
    );
    expect((restCall?.[0] as { create: { value: string } }).create.value).toBe(
      'https://api.soniox.example'
    );
  });
});
