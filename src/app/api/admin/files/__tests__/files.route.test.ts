import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  sessionFindManyMock,
  folderSessionDeleteManyMock,
  shareLinkDeleteManyMock,
  sessionDeleteManyMock,
  chatAttachmentGroupByMock,
  transactionMock,
  releaseStorageBytesMock,
  logActionMock,
  invalidateSessionsApiCacheMock,
  invalidateFoldersApiCacheMock,
  invalidateShareLinksApiCacheMock,
  cancelAsyncUploadMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  sessionFindManyMock: vi.fn(),
  folderSessionDeleteManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  sessionDeleteManyMock: vi.fn(),
  chatAttachmentGroupByMock: vi.fn(),
  transactionMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  logActionMock: vi.fn(),
  invalidateSessionsApiCacheMock: vi.fn(),
  invalidateFoldersApiCacheMock: vi.fn(),
  invalidateShareLinksApiCacheMock: vi.fn(),
  cancelAsyncUploadMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: logActionMock,
}));

vi.mock('@/lib/apiResponseCache', () => ({
  invalidateSessionsApiCache: invalidateSessionsApiCacheMock,
  invalidateFoldersApiCache: invalidateFoldersApiCacheMock,
  invalidateShareLinksApiCache: invalidateShareLinksApiCacheMock,
}));

vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: releaseStorageBytesMock,
  // B1/R4：批量删会话前用 settleAsyncReservation / settleFullReservation 原子结算在途预留。桩为 no-op。
  settleAsyncReservation: vi.fn().mockResolvedValue(0),
  settleFullReservation: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/audio/asyncUploadProcessor', () => ({
  cancelAsyncUpload: cancelAsyncUploadMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findMany: sessionFindManyMock,
      deleteMany: sessionDeleteManyMock,
    },
    folderSession: {
      deleteMany: folderSessionDeleteManyMock,
    },
    shareLink: {
      deleteMany: shareLinkDeleteManyMock,
    },
    chatAttachment: {
      groupBy: chatAttachmentGroupByMock,
    },
    $transaction: transactionMock,
  },
}));

import { DELETE } from '@/app/api/admin/files/route';

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  displayName: 'Admin',
};

beforeEach(() => {
  requireAdminAccessMock.mockReset().mockResolvedValue({ user: adminUser, response: null });
  sessionFindManyMock.mockReset();
  folderSessionDeleteManyMock.mockReset().mockResolvedValue({ count: 0 });
  shareLinkDeleteManyMock.mockReset().mockResolvedValue({ count: 0 });
  sessionDeleteManyMock.mockReset().mockResolvedValue({ count: 1 });
  chatAttachmentGroupByMock.mockReset().mockResolvedValue([]);
  transactionMock
    .mockReset()
    .mockImplementation(async (operations: unknown[]) => Promise.all(operations));
  releaseStorageBytesMock.mockReset().mockResolvedValue(null);
  cancelAsyncUploadMock.mockReset().mockResolvedValue(undefined);
  logActionMock.mockReset();
  invalidateSessionsApiCacheMock.mockReset().mockResolvedValue(undefined);
  invalidateFoldersApiCacheMock.mockReset().mockResolvedValue(undefined);
  invalidateShareLinksApiCacheMock.mockReset().mockResolvedValue(undefined);
});

function deleteReq(ids: string[]): Request {
  return createJsonRequest('http://localhost:3000/api/admin/files', {
    method: 'DELETE',
    body: { ids },
  });
}

describe('DELETE /api/admin/files — 释放附件字节', () => {
  it('删除前聚合受影响附件字节、删除后逐用户 release', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 's1', userId: 'u1', title: 'A' },
      { id: 's2', userId: 'u2', title: 'B' },
    ]);
    chatAttachmentGroupByMock.mockResolvedValue([
      { userId: 'u1', _sum: { bytes: BigInt(1000) } },
      { userId: 'u2', _sum: { bytes: BigInt(2500) } },
    ]);

    const res = await DELETE(deleteReq(['s1', 's2']));

    expect(res.status).toBe(200);
    await expect(readJson<{ deleted: number }>(res)).resolves.toEqual({ deleted: 2 });

    // 聚合范围必须按受影响 session 的 legacy 对话
    expect(chatAttachmentGroupByMock).toHaveBeenCalledWith({
      by: ['userId'],
      where: { conversation: { sessionId: { in: ['s1', 's2'] } } },
      _sum: { bytes: true },
    });

    // 删除事务先发生，再释放字节
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(releaseStorageBytesMock).toHaveBeenCalledTimes(2);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('u1', 1000);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('u2', 2500);
  });

  it('P1-16：批量删进行中异步上传 → cancelAsyncUpload 拿到 region + transcriptionId 做区域感知清理', async () => {
    sessionFindManyMock.mockResolvedValue([
      {
        id: 's1',
        userId: 'u1',
        title: 'A',
        asyncTranscribeStatus: 'transcribing',
        sonioxFileId: 'sf-1',
        sonioxTranscriptionId: 'st-1',
        sonioxRegion: 'eu',
      },
    ]);

    const res = await DELETE(deleteReq(['s1']));

    expect(res.status).toBe(200);
    // select 必须带 sonioxRegion + sonioxTranscriptionId，否则 cancelAsyncUpload 落回默认 region、
    // 跨 region 任务删错区资源致孤儿，且整段跳过删 transcription。
    const selectArg = sessionFindManyMock.mock.calls[0][0].select;
    expect(selectArg).toMatchObject({
      sonioxRegion: true,
      sonioxTranscriptionId: true,
    });
    expect(cancelAsyncUploadMock).toHaveBeenCalledTimes(1);
    expect(cancelAsyncUploadMock.mock.calls[0][0]).toMatchObject({
      id: 's1',
      sonioxFileId: 'sf-1',
      sonioxTranscriptionId: 'st-1',
      sonioxRegion: 'eu',
    });
  });

  it('无 legacy 附件时不调用 release', async () => {
    sessionFindManyMock.mockResolvedValue([{ id: 's1', userId: 'u1', title: 'A' }]);
    chatAttachmentGroupByMock.mockResolvedValue([]);

    const res = await DELETE(deleteReq(['s1']));

    expect(res.status).toBe(200);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('某用户聚合字节为 0/null 时跳过该用户的 release', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 's1', userId: 'u1', title: 'A' },
      { id: 's2', userId: 'u2', title: 'B' },
    ]);
    chatAttachmentGroupByMock.mockResolvedValue([
      { userId: 'u1', _sum: { bytes: BigInt(0) } },
      { userId: 'u2', _sum: { bytes: null } },
    ]);

    const res = await DELETE(deleteReq(['s1', 's2']));

    expect(res.status).toBe(200);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });
});
