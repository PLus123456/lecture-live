import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P5-1(b)：在途预留在入口就计进了 transcriptionMinutesUsed，而 reconcileTranscriptionUsage 只统计
 * 已 COMPLETED 的用量 → 任何在对账时刻有在途上传/完整版补全/未结 grant 的用户**必被**报负 drift，
 * 而面板把负 drift 标成「多扣了用户」并配一键修复。详情接口必须把在途分钟一并返回，面板才能警示。
 */

const {
  requireAdminAccessMock,
  runFindUniqueMock,
  sessionGroupByMock,
  grantGroupByMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  runFindUniqueMock: vi.fn(),
  sessionGroupByMock: vi.fn(),
  grantGroupByMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: writeSecurityAuditMock }));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    reconciliationRun: { findUnique: runFindUniqueMock },
    session: { groupBy: sessionGroupByMock },
    sonioxStreamGrant: { groupBy: grantGroupByMock },
  },
}));

import { GET } from '@/app/api/admin/reconciliation/[runId]/route';

const get = (runId: string) =>
  GET(new Request(`http://localhost/api/admin/reconciliation/${runId}`), {
    params: Promise.resolve({ runId }),
  });

describe('GET /api/admin/reconciliation/[runId] — 在途预留提示（P5-1b）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({ user: { id: 'a' }, response: null });
    sessionGroupByMock.mockResolvedValue([]);
    grantGroupByMock.mockResolvedValue([]);
    writeSecurityAuditMock.mockResolvedValue({});
  });

  it('▶ 每条差异带上该用户的在途预留分钟（async + full + 未结 grant 求和）', async () => {
    runFindUniqueMock.mockResolvedValue({
      id: 'run-1',
      mismatches: [
        { id: 'mm-1', userId: 'u1', driftMinutes: -30 },
        { id: 'mm-2', userId: 'u2', driftMinutes: 5 },
      ],
    });
    sessionGroupByMock.mockResolvedValue([
      { userId: 'u1', _sum: { asyncReservedMinutes: 20, fullReservedMinutes: 5 } },
    ]);
    grantGroupByMock.mockResolvedValue([
      { userId: 'u1', _sum: { reservedMinutes: 5 } },
    ]);

    const body = await (await get('run-1')).json();

    expect(body.mismatches[0].inflightMinutes).toBe(30);
    // 无在途的用户显式给 0，前端才好判断
    expect(body.mismatches[1].inflightMinutes).toBe(0);
    // 未结 grant 才算在途
    expect(grantGroupByMock.mock.calls[0][0].where).toMatchObject({ settledAt: null });
  });

  it('无差异时不查在途聚合', async () => {
    runFindUniqueMock.mockResolvedValue({ id: 'run-1', mismatches: [] });

    const res = await get('run-1');

    expect(res.status).toBe(200);
    expect(sessionGroupByMock).not.toHaveBeenCalled();
  });

  it('run 不存在 → 404', async () => {
    runFindUniqueMock.mockResolvedValue(null);
    expect((await get('nope')).status).toBe(404);
  });

  it('安全审计写失败时不返回敏感差异明细', async () => {
    runFindUniqueMock.mockResolvedValue({
      id: 'run-1',
      mismatches: [{ id: 'mm-1', userId: 'u1', driftMinutes: -30 }],
    });
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await get('run-1');
    expect(res.status).toBe(500);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'reconciliation.detail_read',
        target: { type: 'reconciliation_run', id: 'run-1' },
        outcome: 'SUCCESS',
      })
    );
  });
});
