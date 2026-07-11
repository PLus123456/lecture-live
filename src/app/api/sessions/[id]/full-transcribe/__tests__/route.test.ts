import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R4：完整版补全转录触发端点的「预留持有」门禁。
 * 覆盖：额度足够→预留持有 + claim 登记 fullReservedMinutes（成功不释放）；额度不足→402 不 claim；
 * 已在跑（快路径 / claim 事务权威）→释放本次预留；re-trigger 顶替→锁内释放旧预留；notfound→释放+404。
 */

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  transactionMock,
  txQueryRawMock,
  txSessionUpdateMock,
  reserveMock,
  releaseMock,
  getSiteSettingsMock,
  processFullMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  txSessionUpdateMock: vi.fn(),
  reserveMock: vi.fn(),
  releaseMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  processFullMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
// withRequestLogging 直通：POST = 原始 handler，方便直接调用。
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (_name: string, handler: unknown) => handler,
}));
// getBillableMinutes 用真实口径（ceil(ms/60000)）锁死预留分钟。
vi.mock('@/lib/billing', () => ({
  getBillableMinutes: (ms: number) => Math.ceil(ms / 60_000),
}));
vi.mock('@/lib/quota', () => ({
  reserveTranscriptionMinutes: reserveMock,
  releaseTranscriptionMinutes: releaseMock,
}));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/audio/fullTranscribeProcessor', () => ({
  processFullTranscribe: processFullMock,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findUnique: sessionFindUniqueMock },
    // claim 走 FOR UPDATE 事务（$queryRaw 读状态+旧预留 → tx.session.update 置位+登记预留）。
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));
// @/lib/security 用真实实现（assertOwnership 只比对 userId，不带副作用）。

import { POST } from '@/app/api/sessions/[id]/full-transcribe/route';

function makeReq(): Request {
  return new Request('http://localhost/api/sessions/s-1/full-transcribe', {
    method: 'POST',
  });
}

/** $transaction 回调注入的 tx：$queryRaw 返回锁行快照(状态+旧预留)，session.update 置位。 */
function makeTx() {
  return {
    $queryRaw: (...a: unknown[]) => txQueryRawMock(...a),
    session: { update: (...a: unknown[]) => txSessionUpdateMock(...a) },
  };
}

const params = Promise.resolve({ id: 's-1' });

// 一场 10min（durationMs=600000 → billable=10）；倍率 0.8 → est = ceil(10×0.8)=8
function completedSession(over: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    userId: 'user-1',
    status: 'COMPLETED',
    recordingPath: '/user-1/recordings/s-1.webm',
    durationMs: 600_000,
    fullTranscribeStatus: null,
    fullReservedMinutes: 0,
    ...over,
  };
}

describe('POST full-transcribe — R4 预留持有门禁', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset();
    sessionFindUniqueMock.mockReset();
    transactionMock.mockReset();
    txQueryRawMock.mockReset();
    txSessionUpdateMock.mockReset();
    reserveMock.mockReset();
    releaseMock.mockReset();
    getSiteSettingsMock.mockReset();
    processFullMock.mockReset();

    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'FREE' });
    sessionFindUniqueMock.mockResolvedValue(completedSession());
    getSiteSettingsMock.mockResolvedValue({ async_upload_billing_multiplier: 0.8 });
    reserveMock.mockResolvedValue(true);
    releaseMock.mockResolvedValue(undefined);
    processFullMock.mockResolvedValue(undefined);
    // 默认 claim 事务：执行回调并注入 tx；$queryRaw 默认返回可 claim 的空态、无旧预留。
    transactionMock.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx())
    );
    txQueryRawMock.mockResolvedValue([
      { fullTranscribeStatus: null, fullReservedMinutes: 0 },
    ]);
    txSessionUpdateMock.mockResolvedValue(undefined);
  });

  it('额度足够 → 预留持有(成功不释放) + claim 登记 fullReservedMinutes=est(8)', async () => {
    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; estimatedMinutes: number };
    expect(json.status).toBe('pending');
    expect(json.estimatedMinutes).toBe(8);

    // 预留一次 8 分钟；成功路径不释放（持有到 finalize/删除/回收）；无旧预留 → 不 release。
    expect(reserveMock).toHaveBeenCalledWith('user-1', 8);
    expect(releaseMock).not.toHaveBeenCalled();
    // claim 事务把本次预留额写入 fullReservedMinutes + 置 pending。
    expect(txSessionUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's-1' },
        data: expect.objectContaining({
          fullTranscribeStatus: 'pending',
          fullReservedMinutes: 8,
        }),
      })
    );
    // fire-and-forget 后台处理已触发。
    expect(processFullMock).toHaveBeenCalledWith('s-1');
  });

  it('额度不足：reserve→false → 402，不进 claim 事务、不释放、不触发后台', async () => {
    reserveMock.mockResolvedValueOnce(false);

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(402);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(processFullMock).not.toHaveBeenCalled();
  });

  it('快路径 already_running（findUnique 读到活动态）→ 200，根本不预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce(
      completedSession({ fullTranscribeStatus: 'transcribing' })
    );

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { alreadyRunning: boolean };
    expect(json.alreadyRunning).toBe(true);
    // 未预留、未进 claim 事务。
    expect(reserveMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('权威 already_running（claim 事务锁内读到活动态，并发触发抢先）→ 释放本次预留(8) + 200', async () => {
    // 快路径 snapshot 为 null（放行），但锁内读到并发已置 pending。
    sessionFindUniqueMock
      .mockResolvedValueOnce(completedSession())
      .mockResolvedValueOnce({ fullTranscribeStatus: 'pending' }); // latest 查询
    txQueryRawMock.mockResolvedValueOnce([
      { fullTranscribeStatus: 'pending', fullReservedMinutes: 0 },
    ]);

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { alreadyRunning: boolean };
    expect(json.alreadyRunning).toBe(true);
    // 预留已发生 → 撤销本次预留 8；绝不写 fullReservedMinutes、不触发后台。
    expect(reserveMock).toHaveBeenCalledWith('user-1', 8);
    expect(releaseMock).toHaveBeenCalledWith('user-1', 8);
    expect(txSessionUpdateMock).not.toHaveBeenCalled();
    expect(processFullMock).not.toHaveBeenCalled();
  });

  it('re-trigger 顶替：claim 事务锁内读到旧预留(5) → 同一事务释放它，净预留=本次(8)', async () => {
    // 快路径 snapshot：failed 态（放行），锁内读到残留旧预留 5。
    sessionFindUniqueMock.mockResolvedValueOnce(
      completedSession({ fullTranscribeStatus: 'failed', fullReservedMinutes: 5 })
    );
    txQueryRawMock.mockResolvedValueOnce([
      { fullTranscribeStatus: 'failed', fullReservedMinutes: 5 },
    ]);

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    // 本次 reserve 8；在 claim 事务内释放旧预留 5（第三参为事务 tx）。
    expect(reserveMock).toHaveBeenCalledWith('user-1', 8);
    expect(releaseMock).toHaveBeenCalledWith('user-1', 5, expect.anything());
    // 新预留登记为 8（顶替旧值）。
    expect(txSessionUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fullReservedMinutes: 8 }),
      })
    );
  });

  it('claim 事务锁内行不存在（并发删除）→ 释放本次预留(8) + 404', async () => {
    txQueryRawMock.mockResolvedValueOnce([]);

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(404);
    expect(releaseMock).toHaveBeenCalledWith('user-1', 8);
    expect(processFullMock).not.toHaveBeenCalled();
  });

  it('会话未收尾（status=RECORDING）→ 409，不预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce(
      completedSession({ status: 'RECORDING' })
    );
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(409);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('无录音（recordingPath 空）→ 409，不预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce(
      completedSession({ recordingPath: null })
    );
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(409);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('未授权 → 401，不触碰配额', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(401);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('非本人 session → 403，不预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce(
      completedSession({ userId: 'someone-else' })
    );
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(403);
    expect(reserveMock).not.toHaveBeenCalled();
  });
});
