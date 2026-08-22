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
  interpretSessionCreateMock,
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
  interpretSessionCreateMock: vi.fn(),
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
  // L30：路由入口现在用它校验 anchorId 形状（畸形值 400），mock 里要给出真值。
  ANCHOR_ID_RE: /^[0-9a-fA-F-]{36}$/,
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
  interpretSessionCreateMock.mockReset().mockResolvedValue({ id: 'is-new' });
  logSystemEventMock.mockReset();
  transactionMock
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        interpretSession: {
          update: interpretSessionUpdateMock,
          // M8：no_record + 有 anchorId 时要在同事务补一行「一次性扣费凭据」。
          create: interpretSessionCreateMock,
        },
      })
    );
});

// L30：anchorId 现在在路由入口按 randomUUID 的形状校验（畸形值 400）。测试夹具改用真 UUID 形状。
const ANCHOR_ID = '11111111-2222-4333-8444-555555555555';

describe('POST interpret/deduct — R1-L2 grants 结算挂钩', () => {
  it('claimed → 事务内 settleStreamGrants({interpretSessionId}) + 扣费', async () => {
    const res = await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));
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
    const res = await POST(req({ durationMs: 0, anchorId: ANCHOR_ID }));
    expect(res.status).toBe(200);
    expect(settleGrantsMock).toHaveBeenCalledTimes(1);
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('already_settled（cron 已兜底）→ 不结算 grants、不扣费', async () => {
    claimMock.mockResolvedValueOnce({ outcome: 'already_settled', sessionId: 'is-1' });
    const res = await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));
    expect(res.status).toBe(200);
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('no_record（无锚点行）→ 不结算 grants（无键可循，留给 usage cron），有 anchorId 时仍扣费', async () => {
    claimMock.mockResolvedValueOnce({ outcome: 'no_record', sessionId: null });
    const res = await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));
    expect(res.status).toBe(200);
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).toHaveBeenCalledWith('user-1', 10, expect.anything());
  });
});

describe('M8 no_record + 有 anchorId：一次性扣费凭据', () => {
  it('扣费的同一事务里补一行 settledAt 已置位的锚点，堵住重复 POST 双扣', async () => {
    // 成因：/start 落 InterpretSession 是 best-effort（DB 一抖只 warn 吞错），可 anchorId 已经
    // 返给客户端了。于是 deduct 走 no_record + 有 anchorId 这条「正常扣费兜底」，而它没有任何
    // 幂等闸（settledAt CAS 的前提是有行可认领，这条路径恰恰没有行）→ 同一 anchorId 重复 POST
    // （前端超时重试/双击）被扣两次。
    claimMock.mockResolvedValueOnce({ outcome: 'no_record', sessionId: null });

    const res = await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));

    expect(res.status).toBe(200);
    expect(interpretSessionCreateMock).toHaveBeenCalledTimes(1);
    const created = interpretSessionCreateMock.mock.calls[0][0].data;
    expect(created).toMatchObject({
      userId: 'user-1',
      anchorId: ANCHOR_ID,
      settledBy: 'deduct_no_record',
      billedMinutes: 10,
    });
    // settledAt 必须**已置位** —— 它就是凭据本身：第二次同 anchorId 的 deduct 会在
    // claimInterpretSessionForDeduct 里按 anchorId 命中它 → already_settled → 跳过扣费。
    expect(created.settledAt).toBeInstanceOf(Date);
  });

  it('本次没扣到钱（billable=0 的空场）也要占住这个 anchorId', async () => {
    // 否则重试时客户端换一个更大的 durationMs 就能把这条降级路径再走一遍。
    claimMock.mockResolvedValueOnce({ outcome: 'no_record', sessionId: null });
    resolveBillableMock.mockReturnValueOnce({
      effectiveMs: 0,
      mismatch: false,
      anchored: true,
    });

    await POST(req({ durationMs: 0, anchorId: ANCHOR_ID }));

    expect(deductMock).not.toHaveBeenCalled();
    expect(interpretSessionCreateMock).toHaveBeenCalledTimes(1);
    expect(interpretSessionCreateMock.mock.calls[0][0].data).toMatchObject({
      anchorId: ANCHOR_ID,
      billedMinutes: 0,
    });
  });

  it('降级路径（不带 anchorId）不建凭据行 —— 无 anchorId 可占，建了反而污染 cron 扫描', async () => {
    claimMock.mockResolvedValueOnce({ outcome: 'no_record', sessionId: null });
    consumeAnchorMock.mockResolvedValueOnce(null);
    resolveBillableMock.mockReturnValueOnce({
      effectiveMs: 60_000,
      mismatch: false,
      anchored: false,
    });

    await POST(req({ durationMs: 60_000 }));

    expect(interpretSessionCreateMock).not.toHaveBeenCalled();
  });
});

describe('L30 请求体校验', () => {
  it('畸形 JSON → 400（旧代码是未捕获异常 500）', async () => {
    const bad = new Request('http://localhost/api/interpret/deduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });

    const res = await POST(bad);

    expect(res.status).toBe(400);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('anchorId 形状不合法 → 400，且绝不改道去走「降级盲认领最旧锚点」', async () => {
    const res = await POST(req({ durationMs: 600_000, anchorId: 'a1' }));

    expect(res.status).toBe(400);
    expect(consumeAnchorMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
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
    expect(deductMock).toHaveBeenCalledWith('user-1', 42, expect.anything());
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

    expect(deductMock).toHaveBeenCalledWith('user-1', 30, expect.anything());
  });

  it('无 anchorId + 实测量超 6h 上限 → 仍封顶（防 Soniox 侧异常大值）', async () => {
    unanchored(1);
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 9 * 60 * 60_000,
    });

    await POST(req({ durationMs: 1 }));

    expect(deductMock).toHaveBeenCalledWith('user-1', 360, expect.anything());
  });

  it('带 anchorId（正常路径）：实测量不参与，仍按锚点口径扣（不改变诚实用户体验）', async () => {
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 42 * 60_000,
    });

    await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));

    expect(deductMock).toHaveBeenCalledWith('user-1', 10, expect.anything());
  });
});

describe('POST interpret/deduct — P6-7 按用户限流', () => {
  it('限流命中 → 透传 429，不认领不结算不扣费', async () => {
    enforceRateLimitMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    );

    const res = await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));

    expect(res.status).toBe(429);
    expect(claimMock).not.toHaveBeenCalled();
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('限流按 user 分桶（scope + key），且在鉴权之后', async () => {
    await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));

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

    const res = await POST(req({ durationMs: 600_000, anchorId: ANCHOR_ID }));

    expect(res.status).toBe(401);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });
});
