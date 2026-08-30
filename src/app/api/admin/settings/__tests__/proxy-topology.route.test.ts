import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  siteSettingUpsertMock,
  transactionMock,
  userUpdateManyMock,
  getSiteSettingsMock,
  invalidateTrustedProxyCacheMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  transactionMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  invalidateTrustedProxyCacheMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: { upsert: siteSettingUpsertMock },
    user: { updateMany: userUpdateManyMock },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/siteSettings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/siteSettings')>(
    '@/lib/siteSettings'
  );
  return {
    ...actual,
    getSiteSettings: getSiteSettingsMock,
    invalidateSiteSettingsCache: vi.fn(),
  };
});

vi.mock('@/lib/crypto', () => ({ encrypt: (value: string) => `enc:${value}` }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/securityAudit', () => ({
  getSecurityAuditRequestId: () => 'request-1',
  writeSecurityAudit: vi.fn().mockResolvedValue({
    requestId: 'request-1',
    action: 'admin.security.settings.update',
  }),
}));
vi.mock('@/lib/soniox/env', () => ({ invalidateSonioxDbConfigCache: vi.fn() }));
vi.mock('@/lib/clientIp', () => ({
  invalidateTrustedProxyCache: invalidateTrustedProxyCacheMock,
}));
vi.mock('@/lib/email/mailer', () => ({ invalidateMailer: vi.fn() }));
vi.mock('@/lib/storage/migration', () => ({ migrateLocalToCloudreve: vi.fn() }));
vi.mock('@/lib/storage/cloudreve', () => ({
  clearPersistedTokens: vi.fn(),
  invalidateCloudreveConfigCache: vi.fn(),
  validateCloudreveBaseUrl: vi.fn(),
}));
vi.mock('@/lib/audio/enhanceWorkerClient', () => ({ parseWorkerUrls: () => [] }));

import { PUT } from '@/app/api/admin/settings/route';

const SETTINGS_FIXTURE = {
  trusted_proxy: true,
  chat_files_quota_free_mb: 100,
  chat_files_quota_pro_mb: 100,
  chat_files_quota_admin_mb: 100,
  cloudreve_url: '',
  cloudreve_client_id: '',
  cloudreve_client_secret: '',
  storage_mode: 'local',
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/admin/settings — trusted proxy topology is startup-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' },
      response: null,
    });
    siteSettingUpsertMock.mockImplementation((args) => args);
    transactionMock.mockImplementation(
      async (
        operation: (tx: {
          siteSetting: { upsert: typeof siteSettingUpsertMock };
          user: { updateMany: typeof userUpdateManyMock };
        }) => Promise<unknown>
      ) =>
        operation({
          siteSetting: { upsert: siteSettingUpsertMock },
          user: { updateMany: userUpdateManyMock },
        })
    );
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    getSiteSettingsMock.mockResolvedValue({ ...SETTINGS_FIXTURE });
  });

  it('rejects a write containing only the legacy trusted_proxy key', async () => {
    const response = await PUT(makeRequest({ trusted_proxy: false }));

    expect(response.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(invalidateTrustedProxyCacheMock).not.toHaveBeenCalled();
  });

  it('filters the legacy key from mixed saves and never hot-reloads proxy trust', async () => {
    const response = await PUT(
      makeRequest({ site_name: 'LectureLive Secure', trusted_proxy: false })
    );

    expect(response.status).toBe(200);
    expect(siteSettingUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'site_name' } })
    );
    expect(siteSettingUpsertMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'trusted_proxy' } })
    );
    expect(invalidateTrustedProxyCacheMock).not.toHaveBeenCalled();
  });
});
