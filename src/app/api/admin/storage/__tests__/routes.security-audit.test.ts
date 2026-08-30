import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  getSiteSettingsMock,
  cleanupMock,
  migrateMock,
  trackJobMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  cleanupMock: vi.fn(),
  migrateMock: vi.fn(),
  trackJobMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/storage/migration', () => ({
  cleanupExpiredLocalFiles: cleanupMock,
  migrateLocalToCloudreve: migrateMock,
}));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: {
    STORAGE_CLEANUP: 'storage_cleanup',
    STORAGE_MIGRATION: 'storage_migration',
  },
  trackJob: trackJobMock,
}));

import { POST as cleanupStorage } from '@/app/api/admin/storage/cleanup/route';
import { POST as migrateStorage } from '@/app/api/admin/storage/migrate/route';

type TrackOptions = {
  resultSummary?: (value: unknown) => Record<string, unknown>;
  terminalMutation?: (
    tx: object,
    terminal:
      | { status: 'SUCCESS'; result: unknown }
      | { status: 'FAILED'; error: unknown }
  ) => Promise<void>;
};

describe('admin storage operations — durable audit', () => {
  const tx = { auditLog: { create: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({
      local_retention_days: 7,
      storage_mode: 'cloudreve',
    });
    cleanupMock.mockResolvedValue({ deletedCount: 2, errorCount: 0, errors: [] });
    migrateMock.mockResolvedValue({
      migratedCount: 3,
      skippedCount: 1,
      errorCount: 0,
      errors: [],
    });
    writeSecurityAuditMock.mockResolvedValue(undefined);
    trackJobMock.mockImplementation(
      async (options: TrackOptions, operation: () => Promise<unknown>) => {
        let result: unknown;
        try {
          result = await operation();
        } catch (error) {
          await options.terminalMutation?.(tx, { status: 'FAILED', error });
          throw error;
        }
        await options.terminalMutation?.(tx, { status: 'SUCCESS', result });
        return result;
      }
    );
  });

  it('cleanup 将安全摘要与 SUCCESS audit 放进终态事务', async () => {
    const response = await cleanupStorage(
      new Request('http://localhost/api/admin/storage/cleanup', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    const options = trackJobMock.mock.calls[0][0] as TrackOptions;
    expect(options.resultSummary?.({
      deletedCount: 2,
      errorCount: 1,
      errors: ['/secret/local/path'],
    })).toEqual({ deletedCount: 2, errorCount: 1 });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'storage.cleanup',
        outcome: 'SUCCESS',
        after: { deletedCount: 2, errorCount: 0 },
      }),
      tx
    );
  });

  it('migration 部分失败记录 PARTIAL，journal 不保存 errors 路径', async () => {
    migrateMock.mockResolvedValue({
      migratedCount: 1,
      skippedCount: 2,
      errorCount: 1,
      errors: ['session=x /private/path'],
    });
    const response = await migrateStorage(
      new Request('http://localhost/api/admin/storage/migrate', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'storage.migrate', outcome: 'PARTIAL' }),
      tx
    );
    const options = trackJobMock.mock.calls[0][0] as TrackOptions;
    expect(JSON.stringify(options.resultSummary?.(await migrateMock.mock.results[0].value)))
      .not.toContain('/private/path');
  });

  it('外部清理失败时通过 terminal mutation 原子记录 FAILED', async () => {
    cleanupMock.mockRejectedValue(new Error('unlink failed'));
    const response = await cleanupStorage(
      new Request('http://localhost/api/admin/storage/cleanup', { method: 'POST' })
    );

    expect(response.status).toBe(500);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'storage.cleanup', outcome: 'FAILED' }),
      tx
    );
  });

  it('禁用清理且审计不可用时返回 503，不泄露正常拒绝结果', async () => {
    getSiteSettingsMock.mockResolvedValue({
      local_retention_days: 0,
      storage_mode: 'cloudreve',
    });
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await cleanupStorage(
      new Request('http://localhost/api/admin/storage/cleanup', { method: 'POST' })
    );
    expect(response.status).toBe(503);
    expect(trackJobMock).not.toHaveBeenCalled();
  });
});
