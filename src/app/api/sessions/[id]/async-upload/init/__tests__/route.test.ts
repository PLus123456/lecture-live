import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  enforceRateLimitMock,
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  transactionMock,
  txQueryRawMock,
  txSessionUpdateMock,
  reserveTranscriptionMinutesMock,
  releaseTranscriptionMinutesMock,
  settleAsyncReservationMock,
  reserveStorageMinutesMock,
  initAsyncUploadMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  txSessionUpdateMock: vi.fn(),
  reserveTranscriptionMinutesMock: vi.fn(),
  releaseTranscriptionMinutesMock: vi.fn(),
  settleAsyncReservationMock: vi.fn(),
  reserveStorageMinutesMock: vi.fn(),
  initAsyncUploadMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      updateMany: sessionUpdateManyMock, // init-catch 退回 failed 用
    },
    // B1：claim 改为 FOR UPDATE 事务（$queryRaw 读状态+旧预留 → tx.session.update 置位+登记预留）
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));

vi.mock('@/lib/quota', () => ({
  reserveTranscriptionMinutes: reserveTranscriptionMinutesMock,
  releaseTranscriptionMinutes: releaseTranscriptionMinutesMock,
  settleAsyncReservation: settleAsyncReservationMock,
  reserveStorageMinutes: reserveStorageMinutesMock,
}));

vi.mock('@/lib/audio/asyncUploadChunkPersistence', () => ({
  initAsyncUpload: initAsyncUploadMock,
}));

import { POST } from '@/app/api/sessions/[id]/async-upload/init/route';

const CHUNK_SIZE = 20 * 1024 * 1024;

function makeReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/sessions/s-1/async-upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(extra: Record<string, unknown> = {}) {
  return {
    originalFileName: 'lecture.mp3',
    originalMimeType: 'audio/mpeg',
    originalSize: 30 * 1024 * 1024,
    totalChunks: 2,
    chunkSize: CHUNK_SIZE,
    ...extra,
  };
}

/** $transaction 回调注入的 tx：$queryRaw 返回锁行快照(状态+旧预留)，session.update 置位。 */
function makeTx() {
  return {
    $queryRaw: (...a: unknown[]) => txQueryRawMock(...a),
    session: { update: (...a: unknown[]) => txSessionUpdateMock(...a) },
  };
}

const params = Promise.resolve({ id: 's-1' });

describe('POST async-upload/init — 原子配额预留门禁', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset();
    enforceRateLimitMock.mockReset();
    sessionFindUniqueMock.mockReset();
    sessionUpdateManyMock.mockReset();
    transactionMock.mockReset();
    txQueryRawMock.mockReset();
    txSessionUpdateMock.mockReset();
    reserveTranscriptionMinutesMock.mockReset();
    releaseTranscriptionMinutesMock.mockReset();
    settleAsyncReservationMock.mockReset();
    reserveStorageMinutesMock.mockReset();
    initAsyncUploadMock.mockReset();
    // P1-13：默认存储门禁放行（个别用例覆盖为超限）。
    reserveStorageMinutesMock.mockResolvedValue({ ok: true, remaining: 999 });

    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'FREE' });
    enforceRateLimitMock.mockResolvedValue(null);
    sessionFindUniqueMock.mockResolvedValue({
      id: 's-1',
      userId: 'user-1',
      asyncTranscribeStatus: null,
      asyncReservedMinutes: 0,
    });
    // 默认 claim 事务：执行回调并注入 tx；$queryRaw 默认返回可 claim 的空态、无旧预留。
    transactionMock.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx())
    );
    txQueryRawMock.mockResolvedValue([
      { asyncTranscribeStatus: null, asyncReservedMinutes: 0 },
    ]);
    txSessionUpdateMock.mockResolvedValue(undefined);
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });
    reserveTranscriptionMinutesMock.mockResolvedValue(true);
    releaseTranscriptionMinutesMock.mockResolvedValue(undefined);
    settleAsyncReservationMock.mockResolvedValue(0);
    initAsyncUploadMock.mockResolvedValue({
      totalChunks: 2,
      chunkSize: CHUNK_SIZE,
      receivedSeqs: [],
    });
  });

  it('B1：额度足够 → 预留成功后持有到 finalize（成功不释放）+ claim 事务登记 asyncReservedMinutes', async () => {
    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledTimes(1);
    expect(initAsyncUploadMock).toHaveBeenCalledTimes(1);
    // 成功路径不释放（预留持有到 finalize/cancel/删除/回收）；无旧预留 → 不 release。
    expect(releaseTranscriptionMinutesMock).not.toHaveBeenCalled();
    // claim 事务把本次预留额写入 asyncReservedMinutes（= reserve 的分钟）
    const [, reservedMinutes] = reserveTranscriptionMinutesMock.mock.calls[0];
    expect(txSessionUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          asyncTranscribeStatus: 'uploading_chunks',
          asyncReservedMinutes: reservedMinutes,
        }),
      })
    );
  });

  it('额度不足：reserve 返回 false → 403，不初始化、不释放', async () => {
    reserveTranscriptionMinutesMock.mockResolvedValueOnce(false);

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(403);
    expect(initAsyncUploadMock).not.toHaveBeenCalled();
    expect(releaseTranscriptionMinutesMock).not.toHaveBeenCalled();
  });

  it('B2：门禁取 max(声明, 大小估算) —— 小文件声明时长更大时用声明值', async () => {
    // 2MB 音频（size floor = ceil(2/1)=2），声明 5 分钟 → max(5, 2)=5
    await POST(
      makeReq(
        validBody({
          originalSize: 2 * 1024 * 1024,
          totalChunks: 1,
          estimatedDurationMs: 5 * 60_000,
        })
      ),
      { params }
    );

    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 5);
  });

  it('B2：客户端把 estimatedDurationMs 压到 1ms 骗门禁 → 仍按文件大小 floor 预留（堵少报绕过）', async () => {
    // 300MB 音频（size floor = 300），声明 1ms → max(ceil(1/60000)=1, 300)=300
    await POST(
      makeReq(
        validBody({
          originalSize: 300 * 1024 * 1024,
          totalChunks: 15,
          estimatedDurationMs: 1,
        })
      ),
      { params }
    );

    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 300);
  });

  it('B1 re-init：claim 事务在锁内读到旧预留(12) → 同一事务释放它，净预留=本次', async () => {
    // 锁行快照：failed 态、残留旧预留 12
    txQueryRawMock.mockResolvedValueOnce([
      { asyncTranscribeStatus: 'failed', asyncReservedMinutes: 12 },
    ]);

    await POST(makeReq(validBody()), { params }); // 30MB → 本次预留 30

    // 本次 reserve 30；在 claim 事务内释放旧预留 12（第三参为事务 tx）
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 30);
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      12,
      expect.anything()
    );
  });

  it('无声明时长：按文件大小粗估（音频 ~1MB/min）→ 30MB ≈ 30 分钟', async () => {
    await POST(makeReq(validBody()), { params });
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 30);
  });

  it('视频无声明时长：按 ~5MB/min 粗估 → 50MB ≈ 10 分钟', async () => {
    await POST(
      makeReq(
        validBody({
          originalMimeType: 'video/mp4',
          originalSize: 50 * 1024 * 1024,
          totalChunks: 3,
        })
      ),
      { params }
    );
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 10);
  });

  it('initAsyncUpload 抛错 → 500，退回 failed + settleAsyncReservation 原子结算本次预留', async () => {
    initAsyncUploadMock.mockRejectedValueOnce(new Error('disk full'));

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(500);
    // 结算走 settleAsyncReservation（原子读列释放），而非按快照裸减
    expect(settleAsyncReservationMock).toHaveBeenCalledTimes(1);
    expect(settleAsyncReservationMock).toHaveBeenCalledWith('s-1');
  });

  it('U42 状态机守卫：会话已在跑（claim 事务读到非允许态）→ 409，不写 manifest，撤销本次预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({
      id: 's-1',
      userId: 'user-1',
      asyncTranscribeStatus: 'transcribing',
      asyncReservedMinutes: 0,
    });
    txQueryRawMock.mockResolvedValueOnce([
      { asyncTranscribeStatus: 'transcribing', asyncReservedMinutes: 0 },
    ]);

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(409);
    expect(initAsyncUploadMock).not.toHaveBeenCalled();
    // 撤销本次预留（reserve 已发生）：release 一次，30 分钟
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 30);
  });

  it('P0-6：会话已收尾(COMPLETED)→409 session_finalized，绝不预留/建 manifest（防覆盖最终录音）', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({
      id: 's-1',
      userId: 'user-1',
      status: 'COMPLETED',
      asyncTranscribeStatus: null,
      asyncReservedMinutes: 0,
    });

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe('session_finalized');
    // 终态即拒：在任何配额预留 / claim / 写盘之前短路，绝不触发 async 产物写盘覆盖 recordingPath。
    expect(reserveStorageMinutesMock).not.toHaveBeenCalled();
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(initAsyncUploadMock).not.toHaveBeenCalled();
  });

  it('P0-6：会话已归档(ARCHIVED)同样 409 拒绝', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({
      id: 's-1',
      userId: 'user-1',
      status: 'ARCHIVED',
      asyncTranscribeStatus: null,
      asyncReservedMinutes: 0,
    });

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(409);
    expect(initAsyncUploadMock).not.toHaveBeenCalled();
  });

  it('未授权 → 401，不触碰配额', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody()), { params });
    expect(res.status).toBe(401);
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
  });

  it('非本人 session → 403，不预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({ id: 's-1', userId: 'someone-else' });
    const res = await POST(makeReq(validBody()), { params });
    expect(res.status).toBe(403);
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
  });

  it('非 audio/video MIME → 400，不预留', async () => {
    const res = await POST(
      makeReq(validBody({ originalMimeType: 'application/zip' })),
      { params }
    );
    expect(res.status).toBe(400);
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
  });
});
