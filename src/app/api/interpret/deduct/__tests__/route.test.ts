import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R1-L2：deduct 认领成功即结算本场锚点关联的 stream grants（释放 mint 预扣），与实扣同事务；
 * already_settled（cron 已连锚点带 grants 结算）不重复结算。
 */

const {
  verifyAuthMock,
  claimMock,
  settleGrantsMock,
  deductMock,
  recordUsageMock,
  getSnapshotMock,
  consumeAnchorMock,
  resolveBillableMock,
  transactionMock,
  interpretSessionUpdateMock,
  logSystemEventMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  claimMock: vi.fn(),
  settleGrantsMock: vi.fn(),
  deductMock: vi.fn(),
  recordUsageMock: vi.fn(),
  getSnapshotMock: vi.fn(),
  consumeAnchorMock: vi.fn(),
  resolveBillableMock: vi.fn(),
  transactionMock: vi.fn(),
  interpretSessionUpdateMock: vi.fn(),
  logSystemEventMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));
vi.mock('@/lib/quota', () => ({
  deductTranscriptionMinutes: deductMock,
  recordInterpretUsage: recordUsageMock,
  getQuotaSnapshot: getSnapshotMock,
}));
vi.mock('@/lib/interpret/session', () => ({
  claimInterpretSessionForDeduct: claimMock,
}));
vi.mock('@/lib/soniox/streamGrant', () => ({
  settleStreamGrants: settleGrantsMock,
}));
vi.mock('@/lib/billing', () => ({
  getBillableMinutes: (ms: number) => Math.ceil(ms / 60_000),
}));
vi.mock('@/lib/auditLog', () => ({ logSystemEvent: logSystemEventMock }));
vi.mock('@/lib/interpret/anchor', () => ({
  consumeInterpretAnchor: consumeAnchorMock,
  resolveBillableInterpretMs: resolveBillableMock,
}));

import { POST } from '@/app/api/interpret/deduct/route';

function req(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/interpret/deduct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  verifyAuthMock.mockReset().mockResolvedValue({ id: 'user-1' });
  consumeAnchorMock.mockReset().mockResolvedValue(Date.now() - 10 * 60_000);
  resolveBillableMock.mockReset().mockReturnValue({
    effectiveMs: 10 * 60_000,
    mismatch: false,
    anchored: true,
  });
  claimMock.mockReset().mockResolvedValue({ outcome: 'claimed', sessionId: 'is-1' });
  settleGrantsMock
    .mockReset()
    .mockResolvedValue({ settledCount: 1, releasedMinutes: 15, actualMsTotal: 0 });
  deductMock.mockReset().mockResolvedValue({ role: 'FREE' });
  recordUsageMock.mockReset().mockResolvedValue(undefined);
  getSnapshotMock.mockReset().mockResolvedValue({ role: 'FREE' });
  interpretSessionUpdateMock.mockReset().mockResolvedValue(undefined);
  logSystemEventMock.mockReset();
  transactionMock
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ interpretSession: { update: interpretSessionUpdateMock } })
    );
});

describe('POST interpret/deduct — R1-L2 grants 结算挂钩', () => {
  it('claimed → 事务内 settleStreamGrants({interpretSessionId}) + 扣费', async () => {
    const res = await POST(req({ durationMs: 600_000, anchorId: 'a1' }));
    expect(res.status).toBe(200);
    expect(settleGrantsMock).toHaveBeenCalledWith(
      { interpretSessionId: 'is-1' },
      'interpret_deduct',
      expect.anything()
    );
    expect(deductMock).toHaveBeenCalledWith('user-1', 10, expect.anything());
  });

  it('claimed 但 billable=0（空场）→ 仍结算 grants 释放预扣，跳过扣费', async () => {
    resolveBillableMock.mockReturnValueOnce({
      effectiveMs: 0,
      mismatch: false,
      anchored: true,
    });
    const res = await POST(req({ durationMs: 0, anchorId: 'a1' }));
    expect(res.status).toBe(200);
    expect(settleGrantsMock).toHaveBeenCalledTimes(1);
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('already_settled（cron 已兜底）→ 不结算 grants、不扣费', async () => {
    claimMock.mockResolvedValueOnce({ outcome: 'already_settled', sessionId: 'is-1' });
    const res = await POST(req({ durationMs: 600_000, anchorId: 'a1' }));
    expect(res.status).toBe(200);
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('no_record（无锚点行）→ 不结算 grants（无键可循，留给 usage cron），有 anchorId 时仍扣费', async () => {
    claimMock.mockResolvedValueOnce({ outcome: 'no_record', sessionId: null });
    const res = await POST(req({ durationMs: 600_000, anchorId: 'a1' }));
    expect(res.status).toBe(200);
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).toHaveBeenCalledWith('user-1', 10, expect.anything());
  });
});
