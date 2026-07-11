import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  sessionUpdateMock,
  sessionCountMock,
  folderSessionDeleteManyMock,
  shareLinkDeleteManyMock,
  sessionDeleteMock,
  transactionMock,
  conversationFindManyMock,
  loadSessionAudioArtifactMock,
  loadSessionTranscriptBundleMock,
  deleteSessionArtifactsMock,
  deleteRecordingDraftMock,
  deleteConversationsCascadeMock,
  cancelAsyncUploadMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateMock: vi.fn(),
  sessionCountMock: vi.fn(),
  folderSessionDeleteManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  sessionDeleteMock: vi.fn(),
  transactionMock: vi.fn(),
  conversationFindManyMock: vi.fn(),
  loadSessionAudioArtifactMock: vi.fn(),
  loadSessionTranscriptBundleMock: vi.fn(),
  deleteSessionArtifactsMock: vi.fn(),
  deleteRecordingDraftMock: vi.fn(),
  deleteConversationsCascadeMock: vi.fn(),
  cancelAsyncUploadMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      update: sessionUpdateMock,
      delete: sessionDeleteMock,
      count: sessionCountMock,
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

vi.mock('@/lib/conversationCascade', () => ({
  deleteConversationsCascade: deleteConversationsCascadeMock,
}));

vi.mock('@/lib/audio/asyncUploadProcessor', () => ({
  cancelAsyncUpload: cancelAsyncUploadMock,
}));

// B1/R4：DELETE 删会话前用 settleAsyncReservation / settleFullReservation 原子结算在途预留。桩为
// no-op，避免它内部自开 prisma.$transaction 干扰本用例对删除级联事务次数的断言。
vi.mock('@/lib/quota', () => ({
  settleAsyncReservation: vi.fn().mockResolvedValue(0),
  settleFullReservation: vi.fn().mockResolvedValue(0),
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
    // B4：并发在途录音计数默认 0（未达上限）；具体 cap 用例单独 override。
    sessionCountMock.mockReset().mockResolvedValue(0);
    conversationFindManyMock.mockReset().mockResolvedValue([]);
    deleteSessionArtifactsMock.mockReset().mockResolvedValue(undefined);
    deleteRecordingDraftMock.mockReset().mockResolvedValue(undefined);
    deleteConversationsCascadeMock.mockReset().mockResolvedValue(0);
    cancelAsyncUploadMock.mockReset().mockResolvedValue(undefined);
    transactionMock.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
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
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('B4：CREATED→RECORDING 且并发在途 < 上限 → 放行（按 RECORDING/PAUSED 计数）', async () => {
    sessionCountMock.mockResolvedValueOnce(2); // 未达上限(3)
    sessionUpdateMock.mockResolvedValueOnce({ id: 'session-1', status: 'RECORDING' });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'RECORDING' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(sessionCountMock).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: { in: ['RECORDING', 'PAUSED'] } },
    });
    expect(sessionUpdateMock).toHaveBeenCalled();
  });

  it('B4：CREATED→RECORDING 但并发在途已达上限 → 409，不写库', async () => {
    sessionCountMock.mockResolvedValueOnce(3); // 已达上限

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'RECORDING' },
      }),
      { params }
    );

    expect(response.status).toBe(409);
    expect(sessionUpdateMock).not.toHaveBeenCalled();
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
    sessionCountMock.mockResolvedValue(99); // 即便很多在途，恢复也放行
    sessionUpdateMock.mockResolvedValueOnce({ id: 'session-1', status: 'RECORDING' });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'RECORDING' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(sessionCountMock).not.toHaveBeenCalled();
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
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('C2: 终态会话拒绝客户端 durationMs（防抹掉存储配额）', async () => {
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

    expect(response.status).toBe(409);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Cannot modify durationMs of a finalized session',
    });
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('C2: 非终态会话拒绝把 durationMs 调低', async () => {
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

    expect(response.status).toBe(409);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'durationMs cannot be lowered',
    });
    expect(sessionUpdateMock).not.toHaveBeenCalled();
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
    sessionUpdateMock.mockResolvedValue({ id: 'session-1', title: 'Renamed' });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { title: 'Renamed' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(sessionUpdateMock).toHaveBeenCalledTimes(1);
    expect(sessionUpdateMock.mock.calls[0][0].data.title).toBe('Renamed');
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
    sessionUpdateMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'FINALIZING',
      serverStartedAt: startedAt,
      serverPausedAt: new Date(),
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
    expect(sessionUpdateMock).toHaveBeenCalledTimes(1);
    const data = sessionUpdateMock.mock.calls[0][0].data;
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
    sessionUpdateMock.mockResolvedValue({ id: 'session-1' });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'FINALIZING' },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    const data = sessionUpdateMock.mock.calls[0][0].data;
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
  });

  it('删除进行中的异步上传 session 时先取消（清本地盘 + Soniox 文件）', async () => {
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
    // 取消必须在删行前发生，且拿到的是同一个 session（cancelAsyncUpload 需要 sonioxFileId）
    expect(cancelAsyncUploadMock).toHaveBeenCalledTimes(1);
    expect(cancelAsyncUploadMock).toHaveBeenCalledWith(liveSession);
    expect(sessionDeleteMock).toHaveBeenCalledWith({ where: { id: 'session-1' } });
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

  it('U8: 删除会话时 legacy 对话经 deleteConversationsCascade 删干净（含 Cloudreve 物理文件 + 释放字节）', async () => {
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
    expect(deleteConversationsCascadeMock).toHaveBeenCalledWith(['conv-1', 'conv-2']);
  });

  it('U8: 无 legacy 对话时不调 deleteConversationsCascade', async () => {
    conversationFindManyMock.mockResolvedValue([]);

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(deleteConversationsCascadeMock).not.toHaveBeenCalled();
  });
});
