import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M5 回归：DELETE /api/chat-uploads/[id] 必须拒绝删除「已关闭（endedAt 非空）对话」的附件，
 * 否则会真实删 Cloudreve 文件 + DB 行，破坏只读语义（UI 也已隐藏入口，这里是服务端兜底）。
 */

const {
  verifyAuthMock,
  attachmentFindUniqueMock,
  attachmentDeleteMock,
  releaseStorageBytesMock,
  loadCloudreveContextMock,
  deleteCloudreveFileMock,
  findBillableStoredArtifactsByOwnerMock,
  markStoredArtifactOrphanMock,
  releaseStoredArtifactMock,
  transactionMock,
  executeRawMock,
  markStoredArtifactsDeletePendingInTransactionMock,
  assertStoredArtifactBackfillCompleteMock,
  assertStoredArtifactReferencesCoveredMock,
  areStoredArtifactDeleteIntentsDurableMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  attachmentFindUniqueMock: vi.fn(),
  attachmentDeleteMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  loadCloudreveContextMock: vi.fn(),
  deleteCloudreveFileMock: vi.fn(),
  findBillableStoredArtifactsByOwnerMock: vi.fn(),
  markStoredArtifactOrphanMock: vi.fn(),
  releaseStoredArtifactMock: vi.fn(),
  transactionMock: vi.fn(),
  executeRawMock: vi.fn(),
  markStoredArtifactsDeletePendingInTransactionMock: vi.fn(),
  assertStoredArtifactBackfillCompleteMock: vi.fn(),
  assertStoredArtifactReferencesCoveredMock: vi.fn(),
  areStoredArtifactDeleteIntentsDurableMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      findUnique: attachmentFindUniqueMock,
      delete: attachmentDeleteMock,
    },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/quota', () => ({ releaseStorageBytes: releaseStorageBytesMock }));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  loadCloudreveContext: loadCloudreveContextMock,
  deleteCloudreveFile: deleteCloudreveFileMock,
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_TYPE: { CHAT_EXTRACTED: 'chat_extracted' },
  assertStoredArtifactBackfillComplete:
    assertStoredArtifactBackfillCompleteMock,
  assertStoredArtifactReferencesCovered:
    assertStoredArtifactReferencesCoveredMock,
  areStoredArtifactDeleteIntentsDurable:
    areStoredArtifactDeleteIntentsDurableMock,
  findBillableStoredArtifactsByOwner:
    findBillableStoredArtifactsByOwnerMock,
  markStoredArtifactsDeletePendingInTransaction:
    markStoredArtifactsDeletePendingInTransactionMock,
  markStoredArtifactOrphan: markStoredArtifactOrphanMock,
  releaseStoredArtifact: releaseStoredArtifactMock,
}));

import { DELETE } from '@/app/api/chat-uploads/[id]/route';

function del(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/chat-uploads/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  ];
}

const OPEN_ATTACHMENT = {
  id: 'att-1',
  userId: 'user-1',
  bytes: BigInt(42),
  cloudrevePath: '/u/att-1',
  extractedTextPath: null,
  conversation: { endedAt: null },
};

describe('DELETE /api/chat-uploads/[id] — 只读对话守卫（M5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    attachmentDeleteMock.mockResolvedValue({});
    releaseStorageBytesMock.mockResolvedValue(undefined);
    loadCloudreveContextMock.mockResolvedValue(null);
    findBillableStoredArtifactsByOwnerMock.mockResolvedValue([]);
    markStoredArtifactOrphanMock.mockResolvedValue(undefined);
    releaseStoredArtifactMock.mockResolvedValue(true);
    executeRawMock.mockResolvedValue(1);
    markStoredArtifactsDeletePendingInTransactionMock.mockResolvedValue([]);
    assertStoredArtifactBackfillCompleteMock.mockResolvedValue(undefined);
    assertStoredArtifactReferencesCoveredMock.mockReturnValue(undefined);
    areStoredArtifactDeleteIntentsDurableMock.mockResolvedValue(true);
    transactionMock.mockImplementation(
      async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          chatAttachment: { delete: attachmentDeleteMock },
          $executeRaw: executeRawMock,
        })
    );
  });

  it('对话已关闭（endedAt 非空）→ 409，且不删文件/DB 行', async () => {
    attachmentFindUniqueMock.mockResolvedValue({
      ...OPEN_ATTACHMENT,
      conversation: { endedAt: new Date() },
    });

    const res = await DELETE(...del('att-1'));
    expect(res.status).toBe(409);
    expect(attachmentDeleteMock).not.toHaveBeenCalled();
    expect(deleteCloudreveFileMock).not.toHaveBeenCalled();
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('对话未关闭 + 本人拥有 → 正常删除', async () => {
    attachmentFindUniqueMock.mockResolvedValue(OPEN_ATTACHMENT);

    const res = await DELETE(...del('att-1'));
    expect(res.status).toBe(200);
    expect(attachmentDeleteMock).toHaveBeenCalledWith({ where: { id: 'att-1' } });
  });

  it('非本人且非 ADMIN → 403（不受 endedAt 影响的既有校验）', async () => {
    attachmentFindUniqueMock.mockResolvedValue({
      ...OPEN_ATTACHMENT,
      userId: 'someone-else',
    });

    const res = await DELETE(...del('att-1'));
    expect(res.status).toBe(403);
    expect(attachmentDeleteMock).not.toHaveBeenCalled();
  });

  it('owner/DELETE_PENDING 事务失败且 owner 仍在时不删物理文件', async () => {
    attachmentFindUniqueMock.mockResolvedValue(OPEN_ATTACHMENT);
    transactionMock.mockRejectedValueOnce(new Error('db down'));

    const res = await DELETE(...del('att-1'));

    expect(res.status).toBe(500);
    expect(deleteCloudreveFileMock).not.toHaveBeenCalled();
    expect(releaseStoredArtifactMock).not.toHaveBeenCalled();
  });

  it('物理删除失败时保留 DELETE_PENDING 收费行，绝不提前 release', async () => {
    attachmentFindUniqueMock.mockResolvedValue(OPEN_ATTACHMENT);
    findBillableStoredArtifactsByOwnerMock.mockResolvedValueOnce([
      {
        id: 'artifact-1',
        artifactType: 'chat_raw',
        reference: OPEN_ATTACHMENT.cloudrevePath,
      },
    ]);
    markStoredArtifactsDeletePendingInTransactionMock.mockResolvedValueOnce([
      { id: 'artifact-1' },
    ]);
    loadCloudreveContextMock.mockResolvedValueOnce({
      baseUrl: 'https://storage.test',
      accessToken: 'token',
    });
    deleteCloudreveFileMock.mockResolvedValueOnce(false);

    const res = await DELETE(...del('att-1'));

    expect(res.status).toBe(200);
    expect(markStoredArtifactsDeletePendingInTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      ['artifact-1']
    );
    expect(deleteCloudreveFileMock).toHaveBeenCalled();
    expect(releaseStoredArtifactMock).not.toHaveBeenCalled();
  });
});
