import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R1-L2：deduct 认领成功即结算本场锚点关联的 stream grants（释放 mint 预扣），与实扣同事务；
 * already_settled（cron 已连锚点带 grants 结算）不重复结算。
 */

const {
  verifyAuthMock,
  enforceRateLimitMock,
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
  enforceRateLimitMock: vi.fn(),
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
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
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
  MAX_INTERPRET_DURATION_MS: 6 * 60 * 60_000,
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
  enforceRateLimitMock.mockReset().mockResolvedValue(null);
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
    expect(deductMock).toHaveBeenCalledWith('user-1', 10, expect.anything(), {
      source: 'interpret_deduct',
      referenceId: 'is-1',
    });
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
    expect(deductMock).toHaveBeenCalledWith('user-1', 10, expect.anything(), {
      source: 'interpret_deduct',
      referenceId: 'a1',
    });
  });
});

describe('POST interpret/deduct — P3-8 降级路径（无 anchorId 盲认领最旧会话）', () => {
  /** 无 anchorId：resolveBillableInterpretMs 返回 anchored=false，只能信前端 durationMs。 */
  function unanchored(frontendMs: number) {
    consumeAnchorMock.mockResolvedValueOnce(null);
    resolveBillableMock.mockReturnValueOnce({
      effectiveMs: frontendMs,
      mismatch: false,
      anchored: false,
    });
  }

  it('无 anchorId + {durationMs:1}：按被结算 grants 的实测量兜底扣费，而非 1 分钟', async () => {
    // 攻击：不带 anchorId → 盲认领该用户最旧未结算锚点 → claimed 分支释放该场**全部** mint 预扣，
    // 却只按前端上报的 1ms（ceil → 1 分钟）扣费。实测量是本路径下唯一不可伪造的服务端口径。
    unanchored(1);
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 3,
      releasedMinutes: 45,
      actualMsTotal: 42 * 60_000,
    });

    const res = await POST(req({ durationMs: 1 }));

    expect(res.status).toBe(200);
    expect(deductMock).toHaveBeenCalledWith('user-1', 42, expect.anything(), {
      source: 'interpret_deduct',
      referenceId: 'is-1',
    });
    expect(recordUsageMock).toHaveBeenCalledWith(
      'user-1',
      42,
      42 * 60_000,
      expect.anything()
    );
    expect(interpretSessionUpdateMock).toHaveBeenCalledWith({
      where: { id: 'is-1' },
      data: { billedMinutes: 42 },
    });
    expect(await res.json()).toMatchObject({ deducted: 42 });
  });

  it('无 anchorId 但前端报得比实测多 → 取前端值（实测只作下限，不倒扣用户）', async () => {
    unanchored(30 * 60_000);
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 5 * 60_000,
    });

    await POST(req({ durationMs: 30 * 60_000 }));

    expect(deductMock).toHaveBeenCalledWith('user-1', 30, expect.anything(), {
      source: 'interpret_deduct',
      referenceId: 'is-1',
    });
  });

  it('无 anchorId + 实测量超 6h 上限 → 仍封顶（防 Soniox 侧异常大值）', async () => {
    unanchored(1);
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 9 * 60 * 60_000,
    });

    await POST(req({ durationMs: 1 }));

    expect(deductMock).toHaveBeenCalledWith('user-1', 360, expect.anything(), {
      source: 'interpret_deduct',
      referenceId: 'is-1',
    });
  });

  it('带 anchorId（正常路径）：实测量不参与，仍按锚点口径扣（不改变诚实用户体验）', async () => {
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 42 * 60_000,
    });

    await POST(req({ durationMs: 600_000, anchorId: 'a1' }));

    expect(deductMock).toHaveBeenCalledWith('user-1', 10, expect.anything(), {
      source: 'interpret_deduct',
      referenceId: 'is-1',
    });
  });
});

describe('POST interpret/deduct — P6-7 按用户限流', () => {
  it('限流命中 → 透传 429，不认领不结算不扣费', async () => {
    enforceRateLimitMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    );

    const res = await POST(req({ durationMs: 600_000, anchorId: 'a1' }));

    expect(res.status).toBe(429);
    expect(claimMock).not.toHaveBeenCalled();
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('限流按 user 分桶（scope + key），且在鉴权之后', async () => {
    await POST(req({ durationMs: 600_000, anchorId: 'a1' }));

    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'interpret:deduct:user',
        key: 'user:user-1',
      })
    );
  });

  it('未鉴权 → 401 且不进限流（先鉴权后按 user 分桶）', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);

    const res = await POST(req({ durationMs: 600_000, anchorId: 'a1' }));

    expect(res.status).toBe(401);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });
});
