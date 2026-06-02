import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  sessionUpdateMock,
  folderSessionDeleteManyMock,
  shareLinkDeleteManyMock,
  sessionDeleteMock,
  transactionMock,
  chatAttachmentGroupByMock,
  releaseStorageBytesMock,
  loadSessionAudioArtifactMock,
  loadSessionTranscriptBundleMock,
  cancelAsyncUploadMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateMock: vi.fn(),
  folderSessionDeleteManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  sessionDeleteMock: vi.fn(),
  transactionMock: vi.fn(),
  chatAttachmentGroupByMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  loadSessionAudioArtifactMock: vi.fn(),
  loadSessionTranscriptBundleMock: vi.fn(),
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
    },
    folderSession: {
      deleteMany: folderSessionDeleteManyMock,
    },
    shareLink: {
      deleteMany: shareLinkDeleteManyMock,
    },
    // 删 session 时聚合 legacy 对话附件字节以释放配额；默认无附件
    chatAttachment: {
      groupBy: chatAttachmentGroupByMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: releaseStorageBytesMock,
}));

vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionAudioArtifact: loadSessionAudioArtifactMock,
  loadSessionTranscriptBundle: loadSessionTranscriptBundleMock,
}));

vi.mock('@/lib/audio/asyncUploadProcessor', () => ({
  cancelAsyncUpload: cancelAsyncUploadMock,
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
    chatAttachmentGroupByMock.mockResolvedValue([]);
    releaseStorageBytesMock.mockResolvedValue(null);
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

  it('在缺少音频或转录时阻止完成会话', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Lecture',
      status: 'FINALIZING',
      serverStartedAt: new Date('2026-03-27T10:00:00.000Z'),
      serverPausedAt: null,
    });
    loadSessionAudioArtifactMock.mockResolvedValue(null);
    loadSessionTranscriptBundleMock.mockResolvedValue({ segments: [], summaries: [], translations: {} });

    const response = await PATCH(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'PATCH',
        body: { status: 'COMPLETED' },
      }),
      { params }
    );

    expect(response.status).toBe(409);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Cannot complete session before audio is saved',
    });
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

  it('删除会话时按 owner 释放 legacy 对话附件字节', async () => {
    chatAttachmentGroupByMock.mockResolvedValue([
      { userId: 'user-1', _sum: { bytes: BigInt(4096) } },
    ]);

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/sessions/session-1', {
        method: 'DELETE',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(chatAttachmentGroupByMock).toHaveBeenCalledWith({
      by: ['userId'],
      where: { conversation: { sessionId: 'session-1' } },
      _sum: { bytes: true },
    });
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('user-1', 4096);
  });
});
