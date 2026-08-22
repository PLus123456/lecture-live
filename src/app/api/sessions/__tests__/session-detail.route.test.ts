import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  sessionUpdateMock,
  sessionUpdateManyMock,
  txQueryRawMock,
  txSessionUpdateManyMock,
  settleAsyncReservationMock,
  settleFullReservationMock,
  userFindUniqueMock,
  folderSessionDeleteManyMock,
  shareLinkDeleteManyMock,
  sessionDeleteMock,
  transactionMock,
  conversationFindManyMock,
  loadSessionAudioArtifactMock,
  loadSessionTranscriptBundleMock,
  deleteSessionArtifactsMock,
  deleteRecordingDraftMock,
  deleteTranscriptDraftMock,
  prepareConversationsCascadeMock,
  deletePreparedConversationsInTransactionMock,
  completePreparedConversationCascadeMock,
  cancelAsyncUploadMock,
  resolveMaxConcurrentMock,
  findBillableStoredArtifactsByOwnerMock,
  markStoredArtifactsDeletePendingInTransactionMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  txSessionUpdateManyMock: vi.fn(),
  settleAsyncReservationMock: vi.fn(),
  settleFullReservationMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  folderSessionDeleteManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  sessionDeleteMock: vi.fn(),
  transactionMock: vi.fn(),
  conversationFindManyMock: vi.fn(),
  loadSessionAudioArtifactMock: vi.fn(),
  loadSessionTranscriptBundleMock: vi.fn(),
  deleteSessionArtifactsMock: vi.fn(),
  deleteRecordingDraftMock: vi.fn(),
  deleteTranscriptDraftMock: vi.fn(),
  prepareConversationsCascadeMock: vi.fn(),
  deletePreparedConversationsInTransactionMock: vi.fn(),
  completePreparedConversationCascadeMock: vi.fn(),
  cancelAsyncUploadMock: vi.fn(),
  resolveMaxConcurrentMock: vi.fn(),
  findBillableStoredArtifactsByOwnerMock: vi.fn(),
  markStoredArtifactsDeletePendingInTransactionMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

// P5-15 附带：PATCH 加了宽松的按用户限流。单测里恒放行（限流本身有独立单测）。
vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      update: sessionUpdateMock,
      updateMany: sessionUpdateManyMock,
      delete: sessionDeleteMock,
    },
    // B4：并发上限校验前会取一次 owner.customGroupId 以解析用户组 cap。
    user: {
      findUnique: userFindUniqueMock,
    },
    folderSession: {
      deleteMany: folderSessionDeleteManyMock,
    },
    shareLink: {
      deleteMany: shareLinkDeleteManyMock,
    },
    // 删 session 时收集 legacy 对话 id 走 deleteConversationsCascade；默认无对话
    conversation: {
      findMany: conversationFindManyMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionAudioArtifact: loadSessionAudioArtifactMock,
  loadSessionTranscriptBundle: loadSessionTranscriptBundleMock,
  deleteSessionArtifacts: deleteSessionArtifactsMock,
}));

vi.mock('@/lib/recordingDraftPersistence', () => ({
  deleteRecordingDraft: deleteRecordingDraftMock,
}));
vi.mock('@/lib/transcriptDraftPersistence', () => ({
  deleteTranscriptDraft: deleteTranscriptDraftMock,
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  findBillableStoredArtifactsByOwner: findBillableStoredArtifactsByOwnerMock,
  markStoredArtifactsDeletePendingInTransaction:
    markStoredArtifactsDeletePendingInTransactionMock,
}));

vi.mock('@/lib/conversationCascade', () => ({
  prepareConversationsCascade: prepareConversationsCascadeMock,
  deletePreparedConversationsInTransaction:
    deletePreparedConversationsInTransactionMock,
  completePreparedConversationCascade:
    completePreparedConversationCascadeMock,
}));

vi.mock('@/lib/audio/asyncUploadProcessor', () => ({
  cancelAsyncUpload: cancelAsyncUploadMock,
}));

// B1/R4：DELETE 删会话前用 settleAsyncReservation / settleFullReservation 原子结算在途预留。桩为
// no-op，避免它内部自开 prisma.$transaction 干扰本用例对删除级联事务次数的断言。
// P5-8：结算失败必须拒删，故要能让桩 reject。
vi.mock('@/lib/quota', () => ({
  settleAsyncReservation: settleAsyncReservationMock,
  settleFullReservation: settleFullReservationMock,
}));

// B4：并发上限由用户组解析。桩返回固定 3，让这些用例的数值假设（<3 放行 / =3 拒）稳定，
// 与「按 role/组解析真实上限」的逻辑解耦（该逻辑由 userRoles 单测覆盖）。
vi.mock('@/lib/userRoles', () => ({
  resolveUserMaxConcurrentSessions: resolveMaxConcurrentMock,
}));

import { DELETE, GET, PATCH } from '@/app/api/sessions/[id]/route';

const params = Promise.resolve({ id: 'session-1' });

describe('session detail route', () => {
  beforeEach(() => {
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'ADMIN',
    });
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'CREATED',
      serverStartedAt: null,
      serverPausedAt: null,
    });
    folderSessionDeleteManyMock.mockResolvedValue({ count: 1 });
    shareLinkDeleteManyMock.mockResolvedValue({ count: 1 });
    sessionDeleteMock.mockResolvedValue({ id: 'session-1' });
    // P5-15：并发计数改为事务内的 `SELECT ... FOR UPDATE`（锁定读），默认无在途录音。
    txQueryRawMock.mockReset().mockResolvedValue([]);
    txSessionUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });
    settleAsyncReservationMock.mockReset().mockResolvedValue(0);
    settleFullReservationMock.mockReset().mockResolvedValue(0);
    // B4：owner.customGroupId 默认 null（走系统角色 cap）；组 cap 桩默认 3（与旧硬编码上限一致）。
    userFindUniqueMock.mockReset().mockResolvedValue({ customGroupId: null });
    resolveMaxConcurrentMock.mockReset().mockResolvedValue(3);
    // P0-6：PATCH 走 updateMany CAS（where 带期望旧 status）；默认命中 1 行（无并发改动）。
    sessionUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });
    conversationFindManyMock.mockReset().mockResolvedValue([]);
    deleteSessionArtifactsMock.mockReset().mockResolvedValue(undefined);
    deleteRecordingDraftMock.mockReset().mockResolvedValue(undefined);
    deleteTranscriptDraftMock.mockReset().mockResolvedValue(undefined);
    prepareConversationsCascadeMock.mockReset().mockImplementation(async (ids) => ({
      ids,
      attachments: [],
      ledgerRows: [],
    }));
    deletePreparedConversationsInTransactionMock
      .mockReset()
      .mockResolvedValue(0);
    completePreparedConversationCascadeMock
      .mockReset()
      .mockResolvedValue(true);
    cancelAsyncUploadMock.mockReset().mockResolvedValue(undefined);
    findBillableStoredArtifactsByOwnerMock.mockReset().mockResolvedValue([]);
    markStoredArtifactsDeletePendingInTransactionMock
      .mockReset()
      .mockResolvedValue([]);
    // $transaction 有两种调用形态：DELETE 传操作数组；PATCH 的并发闸传回调（注入 tx）。
    transactionMock.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)({
            $queryRaw: (...a: unknown[]) => txQueryRawMock(...a),
            session: {
              updateMany: (...a: unknown[]) => txSessionUpdateManyMock(...a),
              delete: (...a: unknown[]) => sessionDeleteMock(...a),
            },
            folderSession: {
              deleteMany: (...a: unknown[]) => folderSessionDeleteManyMock(...a),
            },
            shareLink: {
              deleteMany: (...a: unknown[]) => shareLinkDeleteManyMock(...a),
            },
          })
        : Promise.all(arg as unknown[])
    );
  });

  it('返回当前用户拥有的会话详情', async () => {
    const response = await GET(
      createJsonRequest('http://localhost:3000/api/sessions/session-1'),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, unknown>>(response)).resolves.toEqual(
      expect.objectContaining({
        id: 'session-1',
        title: 'Lecture',
        status: 'CREATED',
      })
    );
  });

  it('拒绝非法状态流转', async () => {
    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'COMPLETED' },
      }),
      { params }
    );

    expect(response.status).toBe(400);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Invalid status transition: CREATED → COMPLETED',
    });
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('B4/P5-15：CREATED→RECORDING 且并发在途 < 上限 → 放行，且计数与写库在同一事务内', async () => {
    txQueryRawMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]); // 2 条在途，未达上限(3)

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'RECORDING' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    // P5-15：计数必须是事务内的锁定读（FOR UPDATE），否则两个并发请求各自读到快照都放行。
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txQueryRawMock).toHaveBeenCalledTimes(1);
    const sql = String(txQueryRawMock.mock.calls[0][0]);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/RECORDING/);
    expect(sql).toMatch(/PAUSED/);
    // 状态迁移写库也在同一事务内（tx.session.updateMany），而不是事务外的 prisma.session.updateMany。
    expect(txSessionUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(txSessionUpdateManyMock.mock.calls[0][0].where).toEqual({
      id: 'session-1',
      status: 'CREATED',
    });
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('B4/P5-15：CREATED→RECORDING 但并发在途已达上限 → 409，事务内不写库', async () => {
    txQueryRawMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); // 已达上限

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'RECORDING' },
      }),
      { params }
    );

    expect(response.status).toBe(409);
    expect(txSessionUpdateManyMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('P0-6：PATCH 走期望旧 status 的 CAS，并发改动致 0 行 → 409 + 最新状态', async () => {
    sessionFindUniqueMock.mockReset();
    // 首次加载读到 RECORDING（快照），最终读回已被并发 finalize 推到 COMPLETED。
    sessionFindUniqueMock
      .mockResolvedValueOnce({
        id: 'session-1',
        userId: 'user-1',
        title: 'Lecture',
        status: 'RECORDING',
        serverStartedAt: new Date('2026-03-27T10:00:00.000Z'),
        serverPausedAt: null,
        serverPausedMs: 0,
      })
      .mockResolvedValueOnce({
        id: 'session-1',
        userId: 'user-1',
        status: 'COMPLETED',
      });
    // CAS where{status:RECORDING} 落空：并发已改状态。
    sessionUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'PAUSED' },
      }),
      { params }
    );

    expect(response.status).toBe(409);
    await expect(readJson<Record<string, unknown>>(response)).resolves.toEqual({
      error: 'Session was modified concurrently',
      currentStatus: 'COMPLETED',
    });
    // CAS where 必须带期望旧 status（防裸 update 把终态回退）。
    expect(sessionUpdateManyMock.mock.calls[0][0].where).toEqual({
      id: 'session-1',
      status: 'RECORDING',
    });
  });

  it('B4：PAUSED→RECORDING（恢复暂停）不受并发上限限制（不计数）', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({
      id: 'session-1',
      userId: 'user-1',
      title: 'L',
      status: 'PAUSED',
      serverStartedAt: new Date('2026-07-11T00:00:00.000Z'),
      serverPausedAt: null,
    });
    // 即便很多在途，恢复暂停也放行 —— 根本不进并发闸事务。
    txQueryRawMock.mockResolvedValue(Array.from({ length: 99 }, (_, i) => ({ id: `s${i}` })));

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'RECORDING' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(txQueryRawMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('C4: PATCH 无法把 FINALIZING 推到 COMPLETED（只能经 finalize 端点）', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'FINALIZING',
      serverStartedAt: new Date('2026-03-27T10:00:00.000Z'),
      serverPausedAt: null,
    });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'COMPLETED' },
      }),
      { params }
    );

    expect(response.status).toBe(400);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Invalid status transition: FINALIZING → COMPLETED',
    });
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  // C2 的两道旧守卫（终态拒改 / 已有值不可下调）已被整体拒收取代：durationMs 是服务端
  // 收尾路径的专属字段，PATCH 一律 400。下面三条覆盖旧守卫想堵的两种载荷 + session-persist#151
  // 那条它们堵不住的（首次写入极小正值）。
  it('C2: 终态会话的 durationMs:0（抹掉已消耗存储配额）→ 400', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'COMPLETED',
      serverStartedAt: null,
      serverPausedAt: null,
      durationMs: 7_200_000,
    });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { durationMs: 0 },
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('C2: 非终态会话把 durationMs 调低 → 400', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'RECORDING',
      serverStartedAt: new Date('2026-03-27T10:00:00.000Z'),
      serverPausedAt: null,
      durationMs: 60_000,
    });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { durationMs: 0 },
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('session-persist#151: 新建会话首次写入极小正 durationMs → 400（旧的两道守卫都放行）', async () => {
    // 旧守卫：非终态 ✅、1 ≥ 当前 0 ✅ —— 于是 1ms 落库，随后直传数小时录音时 /audio 的
    // `durationMs <= 0` ffprobe 兜底条件永远为假，1ms 一路带到 /full-transcribe 的计价口径：
    // ceil(getBillableMinutes(1) × 0.8) = 1 分钟额度换数小时 Soniox 转录。
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'CREATED',
      serverStartedAt: null,
      serverPausedAt: null,
      durationMs: 0,
    });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { durationMs: 1 },
      }),
      { params }
    );

    expect(response.status).toBe(400);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error:
        'durationMs is server-managed and cannot be set via PATCH; it is written by the finalize/audio-save paths',
    });
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('允许在终态会话上重命名（title PATCH 不受 durationMs 守卫影响）', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'COMPLETED',
      serverStartedAt: null,
      serverPausedAt: null,
      durationMs: 7_200_000,
    });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { title: 'Renamed' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(sessionUpdateManyMock).toHaveBeenCalledTimes(1);
    // CAS where 带期望旧 status（COMPLETED），仍允许改标题。
    expect(sessionUpdateManyMock.mock.calls[0][0].where).toEqual({
      id: 'session-1',
      status: 'COMPLETED',
    });
    expect(sessionUpdateManyMock.mock.calls[0][0].data.title).toBe('Renamed');
  });

  it('PATCH status=FINALIZING 时记录录音结束时间到 serverPausedAt', async () => {
    const startedAt = new Date('2026-03-27T10:00:00.000Z');
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'RECORDING',
      serverStartedAt: startedAt,
      serverPausedAt: null,
      serverPausedMs: 0,
    });

    const before = Date.now();
    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'FINALIZING' },
      }),
      { params }
    );
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(sessionUpdateManyMock).toHaveBeenCalledTimes(1);
    const data = sessionUpdateManyMock.mock.calls[0][0].data;
    expect(data.status).toBe('FINALIZING');
    expect(data.serverPausedAt).toBeInstanceOf(Date);
    const pausedAtMs = (data.serverPausedAt as Date).getTime();
    expect(pausedAtMs).toBeGreaterThanOrEqual(before);
    expect(pausedAtMs).toBeLessThanOrEqual(after);
  });

  it('PATCH status=FINALIZING 从 PAUSED 转入时会累加挂起的暂停时长', async () => {
    const startedAt = new Date('2026-03-27T10:00:00.000Z');
    const pausedAt = new Date(Date.now() - 30_000); // 30s ago
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'PAUSED',
      serverStartedAt: startedAt,
      serverPausedAt: pausedAt,
      serverPausedMs: 0,
    });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'FINALIZING' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    const data = sessionUpdateManyMock.mock.calls[0][0].data;
    expect(data.status).toBe('FINALIZING');
    expect(data.serverPausedAt).toBeInstanceOf(Date);
    // 挂起的 ~30s 暂停时长应被累加到 serverPausedMs
    expect(data.serverPausedMs).toEqual(
      expect.objectContaining({ increment: expect.any(Number) })
    );
    expect(data.serverPausedMs.increment).toBeGreaterThanOrEqual(29_000);
    expect(data.serverPausedMs.increment).toBeLessThanOrEqual(31_000);
  });

  it('删除会话时会清理关联表记录', async () => {
    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, boolean>>(response)).resolves.toEqual({
      success: true,
    });
    expect(folderSessionDeleteManyMock).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' },
    });
    expect(shareLinkDeleteManyMock).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' },
    });
    expect(sessionDeleteMock).toHaveBeenCalledWith({
      where: { id: 'session-1' },
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // U4：删行前 best-effort 物理清理产物 + 录音草稿目录
    expect(deleteSessionArtifactsMock).toHaveBeenCalledTimes(1);
    expect(deleteRecordingDraftMock).toHaveBeenCalledTimes(1);
    expect(deleteTranscriptDraftMock).toHaveBeenCalledTimes(1);
  });

  it('删除进行中的异步上传 session 时提交 owner 删除后再取消外部任务', async () => {
    const liveSession = {
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'CREATED',
      serverStartedAt: null,
      serverPausedAt: null,
      asyncTranscribeStatus: 'transcribing',
      sonioxFileId: 'sf-123',
    };
    sessionFindUniqueMock.mockResolvedValue(liveSession);

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    // 先提交 owner/ledger 脱钩，之后再取消外部任务；避免数据库失败时先删物理资源。
    expect(cancelAsyncUploadMock).toHaveBeenCalledTimes(1);
    expect(cancelAsyncUploadMock).toHaveBeenCalledWith(liveSession);
    expect(sessionDeleteMock).toHaveBeenCalledWith({ where: { id: 'session-1' } });
    expect(sessionDeleteMock.mock.invocationCallOrder[0]).toBeLessThan(
      cancelAsyncUploadMock.mock.invocationCallOrder[0]
    );
  });

  it.each([['completed'], ['failed'], ['canceled'], [null]])(
    '删除已收尾(%s)的 session 时不触发异步上传取消',
    async (status) => {
      sessionFindUniqueMock.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        title: 'Lecture',
        status: 'COMPLETED',
        serverStartedAt: null,
        serverPausedAt: null,
        asyncTranscribeStatus: status,
        sonioxFileId: null,
      });

      const response = await DELETE(
        createJsonRequest('http://localhost:3000/api/sessions/session-1', {
          method: 'DELETE',
        }),
        { params }
      );

      expect(response.status).toBe(200);
      expect(cancelAsyncUploadMock).not.toHaveBeenCalled();
    }
  );

  it('P5-8：在途预留结算失败 → 500 拒删，绝不删行（预留是行上的列，删了就成谁也够不到的孤儿）', async () => {
    settleAsyncReservationMock.mockRejectedValueOnce(new Error('db down'));

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(500);
    // 旧实现 .catch(()=>undefined) 吞掉后照常删行 → 预留永久占着 transcriptionMinutesUsed，
    // 兜底 cron 只扫存活行、永远扫不到；持池用户还会被 computePoolOwed 多扣池子。
    expect(sessionDeleteMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteSessionArtifactsMock).not.toHaveBeenCalled();
  });

  it('P5-8：完整版预留结算失败同样拒删', async () => {
    settleFullReservationMock.mockRejectedValueOnce(new Error('db down'));

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(500);
    expect(sessionDeleteMock).not.toHaveBeenCalled();
  });

  it('U8: legacy 对话与 session 在同一事务脱钩，提交后才清物理文件', async () => {
    conversationFindManyMock.mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]);

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(conversationFindManyMock).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' },
      select: { id: true },
    });
    expect(prepareConversationsCascadeMock).toHaveBeenCalledWith([
      'conv-1',
      'conv-2',
    ]);
    expect(deletePreparedConversationsInTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ids: ['conv-1', 'conv-2'] })
    );
    expect(completePreparedConversationCascadeMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['conv-1', 'conv-2'] })
    );
  });

  it('session/legacy owner 事务失败时不触发任何提交后物理清理', async () => {
    conversationFindManyMock.mockResolvedValue([{ id: 'conv-1' }]);
    transactionMock.mockRejectedValueOnce(new Error('transaction failed'));

    await expect(
      DELETE(
        createJsonRequest('http://localhost:3000/api/sessions/session-1', {
          method: 'DELETE',
        }),
        { params }
      )
    ).rejects.toThrow('transaction failed');

    expect(completePreparedConversationCascadeMock).not.toHaveBeenCalled();
    expect(deleteSessionArtifactsMock).not.toHaveBeenCalled();
    expect(deleteRecordingDraftMock).not.toHaveBeenCalled();
    expect(deleteTranscriptDraftMock).not.toHaveBeenCalled();
  });

  it('U8: 无 legacy 对话时准备空计划，不触碰任何物理引用', async () => {
    conversationFindManyMock.mockResolvedValue([]);

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(prepareConversationsCascadeMock).toHaveBeenCalledWith([]);
    expect(completePreparedConversationCascadeMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [] })
    );
  });
});
