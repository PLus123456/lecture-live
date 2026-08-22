import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  getSiteSettingsMock,
  siteSettingUpsertMock,
  userUpdateManyMock,
  transactionMock,
  writeSecurityAuditMock,
  clearPersistedTokensMock,
  migrateLocalToCloudreveMock,
  trackJobMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  clearPersistedTokensMock: vi.fn(),
  migrateLocalToCloudreveMock: vi.fn(),
  trackJobMock: vi.fn(),
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

vi.mock('@/lib/securityAudit', () => ({
  getSecurityAuditRequestId: () => 'request-1',
  writeSecurityAudit: writeSecurityAuditMock,
}));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/crypto', () => ({ encrypt: (value: string) => `enc:${value}` }));
vi.mock('@/lib/soniox/env', () => ({ invalidateSonioxDbConfigCache: vi.fn() }));
vi.mock('@/lib/email/mailer', () => ({ invalidateMailer: vi.fn() }));
vi.mock('@/lib/storage/migration', () => ({
  migrateLocalToCloudreve: migrateLocalToCloudreveMock,
}));
vi.mock('@/lib/storage/cloudreve', () => ({
  clearPersistedTokens: clearPersistedTokensMock,
  invalidateCloudreveConfigCache: vi.fn(),
  validateCloudreveBaseUrl: vi.fn(),
}));
vi.mock('@/lib/audio/enhanceWorkerClient', () => ({ parseWorkerUrls: () => [] }));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { STORAGE_MIGRATION: 'storage_migration' },
  trackJob: trackJobMock,
}));

import { GET, PUT } from '@/app/api/admin/settings/route';

const admin = {
  id: 'admin-1',
  email: 'admin@example.test',
  role: 'ADMIN' as const,
};

const settings = {
  site_name: 'Sensitive administration',
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_password: '',
  chat_files_quota_free_mb: 100,
  chat_files_quota_pro_mb: 100,
  chat_files_quota_admin_mb: 100,
  cloudreve_url: '',
  cloudreve_client_id: '',
  cloudreve_client_secret: '',
  audio_enhance_worker_url: '',
  storage_mode: 'local',
};

const txClient = {
  siteSetting: { upsert: siteSettingUpsertMock },
  user: { updateMany: userUpdateManyMock },
  auditLog: { create: vi.fn() },
};

function getRequest(): Request {
  return new Request('http://localhost/api/admin/settings');
}

function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminAccessMock.mockResolvedValue({ user: admin, response: null });
  getSiteSettingsMock.mockResolvedValue({ ...settings });
  siteSettingUpsertMock.mockImplementation((args) => args);
  userUpdateManyMock.mockResolvedValue({ count: 0 });
  transactionMock.mockImplementation(
    async (operation: (tx: typeof txClient) => Promise<unknown>) =>
      operation(txClient)
  );
  clearPersistedTokensMock.mockResolvedValue(undefined);
  migrateLocalToCloudreveMock.mockResolvedValue({
    migratedCount: 0,
    skippedCount: 0,
    errorCount: 0,
  });
  trackJobMock.mockImplementation(
    async (
      options: {
        terminalMutation?: (
          tx: typeof txClient,
          terminal:
            | { status: 'SUCCESS'; result: unknown }
            | { status: 'FAILED'; error: unknown }
        ) => Promise<void>;
      },
      operation: () => Promise<unknown>
    ) => {
      try {
        const result = await operation();
        await options.terminalMutation?.(txClient, {
          status: 'SUCCESS',
          result,
        });
        return result;
      } catch (error) {
        await options.terminalMutation?.(txClient, {
          status: 'FAILED',
          error,
        });
        throw error;
      }
    }
  );
  writeSecurityAuditMock.mockResolvedValue({
    requestId: 'request-1',
    action: 'admin.security.settings.read',
  });
});

describe('GET /api/admin/settings security audit', () => {
  it('waits for the critical audit before returning settings', async () => {
    let release!: () => void;
    writeSecurityAuditMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () =>
          resolve({
            requestId: 'request-1',
            action: 'admin.security.settings.read',
          });
      })
    );

    let settled = false;
    const pending = GET(getRequest()).then((response) => {
      settled = true;
      return response;
    });
    await vi.waitFor(() => expect(writeSecurityAuditMock).toHaveBeenCalled());
    expect(settled).toBe(false);

    release();
    const response = await pending;
    expect(response.status).toBe(200);
  });

  it('fails closed without returning settings when the audit is unavailable', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: '安全审计服务不可用' });
    expect(JSON.stringify(body)).not.toContain('Sensitive administration');
  });
});

describe('PUT /api/admin/settings security audit', () => {
  it('does not mutate when the ATTEMPTED audit cannot be persisted', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await PUT(putRequest({ site_name: 'Changed' }));

    expect(response.status).toBe(503);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('records ATTEMPTED and SUCCESS around a completed update', async () => {
    const response = await PUT(putRequest({ site_name: 'Changed' }));

    expect(response.status).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Request),
      expect.objectContaining({
        event: 'settings.update',
        outcome: 'ATTEMPTED',
        requestId: 'request-1',
      })
    );
    expect(writeSecurityAuditMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Request),
      expect.objectContaining({
        event: 'settings.update',
        outcome: 'SUCCESS',
        requestId: 'request-1',
      }),
      txClient
    );
  });

  it('records FAILED when the settings transaction rejects', async () => {
    transactionMock.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await PUT(putRequest({ site_name: 'Changed' }));

    expect(response.status).toBe(500);
    expect(writeSecurityAuditMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Request),
      expect.objectContaining({ outcome: 'FAILED' })
    );
  });

  it('rolls back the settings transaction when changed Cloudreve credentials cannot clear old tokens', async () => {
    getSiteSettingsMock
      .mockResolvedValueOnce({ ...settings, cloudreve_client_id: 'old-client' })
      .mockResolvedValueOnce({ ...settings, cloudreve_client_id: 'new-client' });
    clearPersistedTokensMock.mockRejectedValueOnce(new Error('token store unavailable'));

    const response = await PUT(
      putRequest({ cloudreve_client_id: 'new-client' })
    );

    expect(response.status).toBe(500);
    expect(clearPersistedTokensMock).toHaveBeenCalledWith(txClient);
    expect(writeSecurityAuditMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Request),
      expect.objectContaining({
        outcome: 'FAILED',
      })
    );
  });

  it('runs storage migration through a durable job and persists its terminal audit', async () => {
    getSiteSettingsMock
      .mockResolvedValueOnce({ ...settings, storage_mode: 'local' })
      .mockResolvedValueOnce({ ...settings, storage_mode: 'cloudreve' });

    const response = await PUT(putRequest({ storage_mode: 'cloudreve' }));

    expect(response.status).toBe(200);
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'storage_migration',
        terminalMutation: expect.any(Function),
      }),
      expect.any(Function)
    );
    expect(migrateLocalToCloudreveMock).toHaveBeenCalledTimes(1);
    expect(migrateLocalToCloudreveMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeSecurityAuditMock.mock.invocationCallOrder[2]
    );
    expect(writeSecurityAuditMock.mock.calls[2]).toEqual([
      expect.any(Request),
      expect.objectContaining({
        event: 'settings.storage_migration',
        outcome: 'SUCCESS',
      }),
      txClient,
    ]);
    expect(writeSecurityAuditMock.mock.calls[1][1]).toMatchObject({
      event: 'settings.update',
      outcome: 'SUCCESS',
      metadata: expect.objectContaining({ migrationRequired: true }),
    });
  });
});
