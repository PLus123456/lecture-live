import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  runFindUniqueMock,
  runUpdateMock,
  mismatchFindUniqueMock,
  mismatchFindManyMock,
  mismatchUpdateManyMock,
  userUpdateMock,
  queryRawMock,
  transactionMock,
  calculateMock,
  getSiteSettingsMock,
  securityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  runFindUniqueMock: vi.fn(),
  runUpdateMock: vi.fn(),
  mismatchFindUniqueMock: vi.fn(),
  mismatchFindManyMock: vi.fn(),
  mismatchUpdateManyMock: vi.fn(),
  userUpdateMock: vi.fn(),
  queryRawMock: vi.fn(),
  transactionMock: vi.fn(),
  calculateMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  securityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: securityAuditMock }));
vi.mock('@/lib/billing', () => ({
  getQuotaCycleStartAt: () => new Date('2026-06-01T00:00:00.000Z'),
}));
vi.mock('@/lib/quota', () => ({
  calculateTranscriptionUsageReconciliation: calculateMock,
}));

const txClient = {
  $queryRaw: queryRawMock,
  reconciliationRun: { update: runUpdateMock },
  reconciliationMismatch: { updateMany: mismatchUpdateManyMock },
  user: { update: userUpdateMock },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    reconciliationRun: { findUnique: runFindUniqueMock, update: runUpdateMock },
    reconciliationMismatch: {
      findUnique: mismatchFindUniqueMock,
      findMany: mismatchFindManyMock,
      updateMany: mismatchUpdateManyMock,
    },
    user: { update: userUpdateMock },
    $transaction: transactionMock,
  },
}));

import { POST } from '@/app/api/admin/reconciliation/fix/route';

const RUN_AT = new Date('2026-06-20T00:00:00.000Z');

function mismatch(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'mm-1',
    runId: 'run-1',
    userId: 'u1',
    userEmail: 'u@x.com',
    recordedMinutes: 145,
    storedMinutes: 130,
    driftMinutes: 15,
    fixed: false,
    run: { createdAt: RUN_AT },
    ...over,
  };
}

function lockedUser(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u1',
    email: 'u@x.com',
    transcriptionMinutesUsed: 130,
    quotaResetAt: new Date('2026-07-01T00:00:00.000Z'),
    transcriptionUsageReconcileFrom: null,
    ...over,
  };
}

function post(body: unknown) {
  return POST(
    createJsonRequest('http://localhost/api/admin/reconciliation/fix', {
      method: 'POST',
      body,
    })
  );
}

describe('POST /api/admin/reconciliation/fix — SEC-030 locked repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ async_upload_billing_multiplier: 0.8 });
    transactionMock.mockImplementation((fn: (tx: typeof txClient) => unknown) => fn(txClient));
    queryRawMock.mockResolvedValue([lockedUser()]);
    mismatchUpdateManyMock.mockResolvedValue({ count: 1 });
    userUpdateMock.mockResolvedValue({});
    runUpdateMock.mockResolvedValue({});
    securityAuditMock.mockResolvedValue({
      requestId: 'req-1',
      action: 'admin.security.reconciliation.fix',
    });
    calculateMock.mockResolvedValue({
      id: 'u1',
      email: 'u@x.com',
      transcriptionMinutesUsed: 130,
      recordedMinutes: 145,
      driftMinutes: 15,
      hasAmbiguousCharges: false,
    });
  });

  it('locks User first, then recomputes committed + inflight and writes the fresh target', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    const order: string[] = [];
    queryRawMock.mockImplementation(async () => {
      order.push('lock');
      return [lockedUser()];
    });
    calculateMock.mockImplementation(async () => {
      order.push('recompute');
      return {
        id: 'u1',
        email: 'u@x.com',
        transcriptionMinutesUsed: 130,
        recordedMinutes: 145,
        driftMinutes: 15,
      };
    });
    mismatchUpdateManyMock.mockImplementation(async () => {
      order.push('mark');
      return { count: 1 };
    });
    userUpdateMock.mockImplementation(async () => {
      order.push('write');
      return {};
    });

    const response = await post({ mismatchId: 'mm-1' });

    expect(response.status).toBe(200);
    expect(order).toEqual(['lock', 'recompute', 'mark', 'write']);
    expect(calculateMock).toHaveBeenCalledWith(lockedUser(), 0.8, txClient);
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { transcriptionMinutesUsed: 145 },
    });
    expect(mismatchUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mm-1', fixed: false } })
    );
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'reconciliation.fix',
        target: expect.objectContaining({ id: 'u1', ownerId: 'u1' }),
        before: { minutes: 130 },
        after: { minutes: 145 },
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('blocks the ABA case: a reservation already became an equal committed charge', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    calculateMock.mockResolvedValue({
      id: 'u1',
      email: 'u@x.com',
      transcriptionMinutesUsed: 130,
      recordedMinutes: 130,
      driftMinutes: 0,
    });

    const response = await post({ mismatchId: 'mm-1' });

    expect(response.status).toBe(409);
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(mismatchUpdateManyMock).not.toHaveBeenCalled();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  it('can safely lower a counter because immutable charge rows survive Session deletion', async () => {
    mismatchFindUniqueMock.mockResolvedValue(
      mismatch({
        recordedMinutes: 100,
        storedMinutes: 130,
        driftMinutes: -30,
      })
    );
    calculateMock.mockResolvedValue({
      id: 'u1',
      email: 'u@x.com',
      transcriptionMinutesUsed: 130,
      // The missing 30-minute Session row may have been physically deleted. The surviving ledger
      // is therefore not proof that the user's real charge should be lowered.
      recordedMinutes: 100,
      driftMinutes: -30,
      hasAmbiguousCharges: false,
    });

    const response = await post({ mismatchId: 'mm-1' });

    expect(response.status).toBe(200);
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { transcriptionMinutesUsed: 100 },
    });
  });

  it('fixAll fails closed while the current period contains an ambiguous legacy opening balance', async () => {
    runFindUniqueMock.mockResolvedValue({ id: 'run-1', createdAt: RUN_AT });
    mismatchFindManyMock.mockResolvedValue([
      mismatch({ recordedMinutes: 100, storedMinutes: 130, driftMinutes: -30 }),
    ]);
    calculateMock.mockResolvedValue({
      id: 'u1',
      email: 'u@x.com',
      transcriptionMinutesUsed: 130,
      recordedMinutes: 100,
      driftMinutes: -30,
      hasAmbiguousCharges: true,
    });

    const response = await post({ runId: 'run-1', fixAll: true });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AMBIGUOUS_LEGACY_LEDGER',
      blockedCount: 1,
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(mismatchUpdateManyMock).not.toHaveBeenCalled();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects a run older than the locked user reconciliation lower bound', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    queryRawMock.mockResolvedValue([
      lockedUser({ transcriptionUsageReconcileFrom: new Date('2026-06-25T00:00:00.000Z') }),
    ]);

    const response = await post({ mismatchId: 'mm-1' });

    expect(response.status).toBe(409);
    expect(calculateMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('a lost fixed:false claim cannot change the user or inflate fixedCount', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    mismatchUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await post({ mismatchId: 'mm-1' });

    expect(response.status).toBe(409);
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  it('fails closed when the in-transaction security audit cannot be persisted', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());
    securityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await post({ mismatchId: 'mm-1' });

    expect(response.status).toBe(500);
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ outcome: 'SUCCESS' }),
      txClient
    );
  });
});

describe('POST /api/admin/reconciliation/fix — true concurrent requests', () => {
  let releaseTail: Promise<void> = Promise.resolve();
  let fixed: Set<string>;
  let usedByUser: Map<string, number>;
  let ledgerByUser: Map<string, number>;
  let fixedCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    fixed = new Set();
    usedByUser = new Map([
      ['u1', 100],
      ['u2', 50],
    ]);
    ledgerByUser = new Map([
      ['u1', 130],
      ['u2', 70],
    ]);
    fixedCount = 0;
    releaseTail = Promise.resolve();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ async_upload_billing_multiplier: 0.8 });
    runFindUniqueMock.mockResolvedValue({ id: 'run-1', createdAt: RUN_AT });
    securityAuditMock.mockResolvedValue({
      requestId: 'req-1',
      action: 'admin.security.reconciliation.fix',
    });

    // Actual overlapping route promises share a row-lock harness.  The callback owns the lock until
    // commit, matching the transaction boundary rather than merely sequencing individual mocks.
    transactionMock.mockImplementation(async (fn: (tx: typeof txClient) => unknown) => {
      const previous = releaseTail;
      let release!: () => void;
      releaseTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(txClient);
      } finally {
        release();
      }
    });
    queryRawMock.mockImplementation(async (_strings: TemplateStringsArray, userId: string) => [
      lockedUser({ id: userId, email: `${userId}@x.com`, transcriptionMinutesUsed: usedByUser.get(userId) }),
    ]);
    calculateMock.mockImplementation(async (user: ReturnType<typeof lockedUser>) => {
      const target = ledgerByUser.get(String(user.id)) ?? 0;
      const used = usedByUser.get(String(user.id)) ?? 0;
      return {
        id: user.id,
        email: user.email,
        transcriptionMinutesUsed: used,
        recordedMinutes: target,
        driftMinutes: target - used,
      };
    });
    mismatchUpdateManyMock.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (fixed.has(where.id)) return { count: 0 };
      fixed.add(where.id);
      return { count: 1 };
    });
    userUpdateMock.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: { transcriptionMinutesUsed: number } }) => {
        usedByUser.set(where.id, data.transcriptionMinutesUsed);
        return {};
      }
    );
    runUpdateMock.mockImplementation(async () => {
      fixedCount += 1;
      return {};
    });
  });

  it('two simultaneous single fixes apply exactly once', async () => {
    mismatchFindUniqueMock.mockResolvedValue(mismatch());

    const [a, b] = await Promise.all([
      post({ mismatchId: 'mm-1' }),
      post({ mismatchId: 'mm-1' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(usedByUser.get('u1')).toBe(130);
    expect(fixedCount).toBe(1);
    expect(fixed).toEqual(new Set(['mm-1']));
  });

  it('simultaneous bulk repairs use stable order and count each mismatch once', async () => {
    const rows = [
      mismatch({ id: 'mm-2', userId: 'u2' }),
      mismatch({ id: 'mm-1', userId: 'u1' }),
    ];
    mismatchFindManyMock.mockResolvedValue(rows);

    const [a, b] = await Promise.all([
      post({ runId: 'run-1', fixAll: true }),
      post({ runId: 'run-1', fixAll: true }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(usedByUser).toEqual(
      new Map([
        ['u1', 130],
        ['u2', 70],
      ])
    );
    expect(fixedCount).toBe(2);
    expect(fixed).toEqual(new Set(['mm-1', 'mm-2']));
    const lockedOrder = queryRawMock.mock.calls.map((call) => call[1]);
    expect(lockedOrder).toEqual(['u1', 'u1', 'u2', 'u2']);
    // One short transaction per user per request: no batch-wide RR snapshot survives from u1 to u2.
    expect(transactionMock).toHaveBeenCalledTimes(4);
  });
});
