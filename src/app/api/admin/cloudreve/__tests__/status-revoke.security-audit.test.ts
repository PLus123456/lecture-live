import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  configuredMock,
  statusMock,
  clearPersistedTokensMock,
  writeSecurityAuditMock,
  transactionMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  configuredMock: vi.fn(),
  statusMock: vi.fn(),
  clearPersistedTokensMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/storage/cloudreve', () => ({
  isCloudreveConfiguredAsync: configuredMock,
  getCloudreveAuthStatus: statusMock,
  clearPersistedTokens: clearPersistedTokensMock,
}));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { $transaction: transactionMock },
}));

import { GET as readStatus } from '@/app/api/admin/cloudreve/status/route';
import { POST as revoke } from '@/app/api/admin/cloudreve/revoke/route';

describe('Cloudreve status/revoke security audit', () => {
  const tx = { siteSetting: { deleteMany: vi.fn() }, auditLog: { create: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' },
      response: null,
    });
    configuredMock.mockResolvedValue(true);
    statusMock.mockResolvedValue({ authorized: true, expiresAt: 1_800_000_000_000 });
    clearPersistedTokensMock.mockResolvedValue(undefined);
    writeSecurityAuditMock.mockResolvedValue(undefined);
    transactionMock.mockImplementation(
      async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)
    );
  });

  it('授权状态属于敏感读取，审计成功后才返回', async () => {
    const response = await readStatus(
      new Request('http://localhost/api/admin/cloudreve/status')
    );
    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'cloudreve.status-read',
        outcome: 'SUCCESS',
        metadata: { configured: true, authorized: true, hasExpiry: true },
      })
    );
  });

  it('状态读取审计失败时不返回授权状态', async () => {
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await readStatus(
      new Request('http://localhost/api/admin/cloudreve/status')
    );
    expect(response.status).toBe(500);
  });

  it('撤销 token 与 SUCCESS audit 在同一事务', async () => {
    const response = await revoke(
      new Request('http://localhost/api/admin/cloudreve/revoke', { method: 'POST' })
    );
    expect(response.status).toBe(200);
    expect(clearPersistedTokensMock).toHaveBeenCalledWith(tx);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'cloudreve.revoke', outcome: 'SUCCESS' }),
      tx
    );
  });

  it('撤销成功审计失败时不向客户端确认成功', async () => {
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await revoke(
      new Request('http://localhost/api/admin/cloudreve/revoke', { method: 'POST' })
    );
    expect(response.status).toBe(500);
  });
});
