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

    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      5,
      expect.anything()
    );
  });

  it('B2：客户端把 estimatedDurationMs 压到 1ms 骗门禁 → 仍按文件大小 floor 预留（堵少报绕过）', async () => {
    // 300MB 有损音频（floor = ceil(300/2.5) = 120），声明 1ms → max(1, 120)=120
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

    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      120,
      expect.anything()
    );
  });

  it('B1 re-init：claim 事务在锁内读到旧预留(12) → 同一事务释放它，净预留=本次', async () => {
    // 锁行快照：failed 态、残留旧预留 12
    txQueryRawMock.mockResolvedValueOnce([
      { asyncTranscribeStatus: 'failed', asyncReservedMinutes: 12 },
    ]);

    await POST(makeReq(validBody()), { params }); // 30MB mp3 → 本次预留 ceil(30/2.5)=12

    // 在同一 claim 事务内先释放旧预留 12、再 reserve 本次 12；两步与 Session 登记同进同退。
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      12,
      expect.anything()
    );
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      12,
      expect.anything()
    );
  });

  it('P5-19：无声明时长时 floor 按「格式码率上限」折算（有损音频 2.5MB/min）→ 30MB = 12 分钟', async () => {
    // 旧口径按「典型码率」1MB/min → 30 分钟，是真实时长的上界而非下界，无损/高码率文件必然误拒。
    await POST(makeReq(validBody()), { params });
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      12,
      expect.anything()
    );
  });

  it('P5-19：视频 floor 按 150MB/min 上限折算 → 50MB = 1 分钟（下界，不是估计值）', async () => {
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
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      1,
      expect.anything()
    );
  });

  it('P5-19（核心）：无损 WAV 声明真实 5 分钟 → 预留 5，不再被 size floor 顶成误 403', async () => {
    // 5 分钟 44.1kHz/16bit 立体声 WAV ≈ 50MB。旧口径 floor = ceil(50/1) = 50 分钟 → 额度只剩 10 分钟
    // 的诚实用户直接 403（U22 的真正成因：只补客户端字段修不掉）。新口径 floor = ceil(50/36) = 2，
    // 取 max(声明 5, 2) = 5。
    await POST(
      makeReq(
        validBody({
          originalFileName: 'lecture.wav',
          originalMimeType: 'audio/wav',
          originalSize: 50 * 1024 * 1024,
          totalChunks: 3,
          estimatedDurationMs: 5 * 60_000,
        })
      ),
      { params }
    );
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      5,
      expect.anything()
    );
  });

  it('initAsyncUpload 抛错 → 同一代际、同一事务退回 failed 并释放本次预留', async () => {
    initAsyncUploadMock.mockRejectedValueOnce(new Error('disk full'));
    txQueryRawMock
      .mockReset()
      .mockResolvedValueOnce([
        {
          asyncTranscribeStatus: null,
          asyncTranscribeStartedAt: null,
          asyncReservedMinutes: 0,
        },
      ])
      .mockImplementationOnce(async () => {
        const claimStartedAt = txSessionUpdateMock.mock.calls[0][0].data
          .asyncTranscribeStartedAt as Date;
        return [
          {
            userId: 'user-1',
            asyncTranscribeStatus: 'uploading_chunks',
            asyncTranscribeStartedAt: claimStartedAt,
            asyncReservedMinutes: 12,
          },
        ];
      });

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(500);
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      12,
      expect.anything()
    );
    expect(txSessionUpdateMock).toHaveBeenLastCalledWith({
      where: { id: 's-1' },
      data: {
        asyncTranscribeStatus: 'failed',
        asyncTranscribeError: 'init failed',
        asyncReservedMinutes: 0,
      },
    });
    expect(settleAsyncReservationMock).not.toHaveBeenCalled();
  });

  it('SEC-030：旧 init 写盘失败不能释放随后 re-init 的新代际预留', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstInit = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    initAsyncUploadMock
      .mockImplementationOnce(() => firstInit)
      .mockResolvedValueOnce({
        totalChunks: 2,
        chunkSize: CHUNK_SIZE,
        receivedSeqs: [],
      });

    const row: {
      userId: string;
      asyncTranscribeStatus: string | null;
      asyncTranscribeStartedAt: Date | null;
      asyncReservedMinutes: number;
    } = {
      userId: 'user-1',
      asyncTranscribeStatus: null,
      asyncTranscribeStartedAt: null,
      asyncReservedMinutes: 0,
    };
    txQueryRawMock.mockImplementation(async () => [{ ...row }]);
    txSessionUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if ('asyncTranscribeStatus' in data) {
        row.asyncTranscribeStatus = data.asyncTranscribeStatus as string;
      }
      if ('asyncTranscribeStartedAt' in data) {
        row.asyncTranscribeStartedAt = data.asyncTranscribeStartedAt as Date;
      }
      if ('asyncReservedMinutes' in data) {
        row.asyncReservedMinutes = data.asyncReservedMinutes as number;
      }
    });

    const oldRequest = POST(makeReq(validBody()), { params });
    await vi.waitFor(() => expect(initAsyncUploadMock).toHaveBeenCalledTimes(1));
    const oldGeneration = row.asyncTranscribeStartedAt;

    const replacement = await POST(makeReq(validBody()), { params });
    expect(replacement.status).toBe(200);
    const replacementGeneration = row.asyncTranscribeStartedAt;
    expect(replacementGeneration?.getTime()).toBeGreaterThan(
      oldGeneration?.getTime() ?? 0
    );

    rejectFirst(new Error('old disk write failed'));
    const failedOldRequest = await oldRequest;

    expect(failedOldRequest.status).toBe(500);
    expect(row).toMatchObject({
      asyncTranscribeStatus: 'uploading_chunks',
      asyncTranscribeStartedAt: replacementGeneration,
      asyncReservedMinutes: 12,
    });
    // 唯一一次 release 是 replacement claim 顶替旧预留；旧失败清理不得再释放新预留。
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledTimes(1);
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      12,
      expect.anything()
    );
    expect(txSessionUpdateMock).toHaveBeenCalledTimes(2);
    expect(settleAsyncReservationMock).not.toHaveBeenCalled();
  });

  it('U42 状态机守卫：会话已在跑（claim 事务读到非允许态）→ 409，且从未预留', async () => {
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
    // 状态检查发生在同一事务的 reserve 之前，不需要事后补偿，也没有登记缝隙。
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
    expect(releaseTranscriptionMinutesMock).not.toHaveBeenCalled();
  });

  it('SEC-030：re-init 新额度不足时抛出并回滚“释放旧预留”，旧 Session 不被覆盖', async () => {
    txQueryRawMock.mockResolvedValueOnce([
      { asyncTranscribeStatus: 'failed', asyncReservedMinutes: 12 },
    ]);
    reserveTranscriptionMinutesMock.mockResolvedValueOnce(false);
    let rolledBack = false;
    transactionMock.mockImplementationOnce(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        try {
          return await cb(makeTx());
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }
    );

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(403);
    expect(rolledBack).toBe(true);
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledWith(
      'user-1',
      12,
      expect.anything()
    );
    expect(txSessionUpdateMock).not.toHaveBeenCalled();
    expect(initAsyncUploadMock).not.toHaveBeenCalled();
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
