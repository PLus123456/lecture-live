import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runCreateMock,
  runUpdateMock,
  mismatchCreateManyMock,
  userCountMock,
  transactionMock,
  reconcileUsageMock,
  getSiteSettingsMock,
} = vi.hoisted(() => ({
  runCreateMock: vi.fn(),
  runUpdateMock: vi.fn(),
  mismatchCreateManyMock: vi.fn(),
  userCountMock: vi.fn(),
  transactionMock: vi.fn(),
  reconcileUsageMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    reconciliationRun: { create: runCreateMock, update: runUpdateMock },
    reconciliationMismatch: { createMany: mismatchCreateManyMock },
    user: { count: userCountMock },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/quota', () => ({ reconcileTranscriptionUsage: reconcileUsageMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/auditLog', () => ({ logSystemEvent: vi.fn() }));

import { runTranscriptionUsageReconciliation } from '@/lib/reconciliation';

describe('runTranscriptionUsageReconciliation terminal mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCreateMock.mockResolvedValue({ id: 'run-1' });
    runUpdateMock.mockResolvedValue({
      id: 'run-1',
      status: 'completed',
      totalUsers: 1,
      mismatchCount: 1,
      mismatches: [{ id: 'mismatch-1' }],
    });
    mismatchCreateManyMock.mockResolvedValue({ count: 1 });
    userCountMock.mockResolvedValue(1);
    getSiteSettingsMock.mockResolvedValue({ async_upload_billing_multiplier: 1 });
    reconcileUsageMock.mockResolvedValue([
      {
        id: 'user-1',
        email: 'user@example.test',
        recordedMinutes: 3,
        transcriptionMinutesUsed: 1,
        driftMinutes: 2,
      },
    ]);
    transactionMock.mockImplementation(async (callback) =>
      callback({
        reconciliationRun: { update: runUpdateMock },
        reconciliationMismatch: { createMany: mismatchCreateManyMock },
      })
    );
  });

  it('commits mismatch rows, completed state, and final audit callback in one transaction', async () => {
    const completionMutation = vi.fn().mockResolvedValue(undefined);

    await runTranscriptionUsageReconciliation({
      triggeredBy: 'admin-1',
      source: 'admin',
      completionMutation,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(mismatchCreateManyMock).toHaveBeenCalledTimes(1);
    expect(runUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) })
    );
    expect(completionMutation).toHaveBeenCalledWith(
      expect.objectContaining({ reconciliationRun: expect.any(Object) }),
      expect.objectContaining({ id: 'run-1', status: 'completed' })
    );
  });

  it('commits FAILED state and failure audit callback together', async () => {
    const operationFailure = new Error('usage scan failed');
    reconcileUsageMock.mockRejectedValueOnce(operationFailure);
    runUpdateMock.mockResolvedValueOnce({ id: 'run-1', status: 'failed' });
    const failureMutation = vi.fn().mockResolvedValue(undefined);

    await expect(
      runTranscriptionUsageReconciliation({
        triggeredBy: 'admin-1',
        source: 'admin',
        failureMutation,
      })
    ).rejects.toBe(operationFailure);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(runUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) })
    );
    expect(failureMutation).toHaveBeenCalledWith(
      expect.anything(),
      { runId: 'run-1', errorMessage: 'usage scan failed' }
    );
  });
});
