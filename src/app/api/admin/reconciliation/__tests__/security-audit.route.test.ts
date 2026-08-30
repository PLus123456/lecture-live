import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  runFindManyMock,
  runCountMock,
  runReconciliationMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  runFindManyMock: vi.fn(),
  runCountMock: vi.fn(),
  runReconciliationMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    reconciliationRun: { findMany: runFindManyMock, count: runCountMock },
  },
}));
vi.mock('@/lib/reconciliation', () => ({
  runTranscriptionUsageReconciliation: runReconciliationMock,
}));
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: writeSecurityAuditMock }));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (_scope: string, handler: (req: Request) => Promise<Response>) => handler,
}));

import { GET, POST } from '@/app/api/admin/reconciliation/route';

const request = (method = 'GET') =>
  new Request('http://localhost/api/admin/reconciliation?page=1&pageSize=20', {
    method,
  });

describe('/api/admin/reconciliation — SEC-033', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' },
      response: null,
    });
    runFindManyMock.mockResolvedValue([{ id: 'run-1', status: 'completed' }]);
    runCountMock.mockResolvedValue(1);
    writeSecurityAuditMock.mockResolvedValue({});
    runReconciliationMock.mockImplementation(async (options) => {
      const run = {
        id: 'run-new',
        status: 'completed',
        totalUsers: 4,
        mismatchCount: 1,
        mismatches: [],
      };
      await options.completionMutation(
        { auditLog: { create: vi.fn() } },
        run
      );
      return run;
    });
  });

  it('audits a history read before returning the records', async () => {
    const response = await GET(request(), {} as never);

    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'reconciliation.read',
        outcome: 'SUCCESS',
        metadata: expect.objectContaining({ resultCount: 1, total: 1 }),
      })
    );
  });

  it('does not return reconciliation history if the read audit fails', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await GET(request(), {} as never);

    expect(response.status).toBe(500);
  });

  it('passes final SUCCESS/FAILED audit callbacks into the durable run', async () => {
    const response = await POST(request('POST'), {} as never);

    expect(response.status).toBe(200);
    const options = runReconciliationMock.mock.calls[0][0];
    expect(options).toMatchObject({
      triggeredBy: 'admin-1',
      source: 'admin',
      completionMutation: expect.any(Function),
      failureMutation: expect.any(Function),
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'reconciliation.run',
        outcome: 'SUCCESS',
        target: { type: 'reconciliation_run', id: 'run-new' },
      }),
      expect.objectContaining({ auditLog: expect.any(Object) })
    );
  });
});
