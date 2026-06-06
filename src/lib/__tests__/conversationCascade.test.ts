import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findManyMock,
  transactionMock,
  deleteManyAttachmentMock,
  deleteManyMessageMock,
  deleteManySessionMock,
  deleteManyConversationMock,
  deleteCloudreveAttachmentFilesMock,
  deleteConversationImagesMock,
  releaseStorageBytesMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  transactionMock: vi.fn(),
  deleteManyAttachmentMock: vi.fn(),
  deleteManyMessageMock: vi.fn(),
  deleteManySessionMock: vi.fn(),
  deleteManyConversationMock: vi.fn(),
  deleteCloudreveAttachmentFilesMock: vi.fn(),
  deleteConversationImagesMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      findMany: findManyMock,
      deleteMany: deleteManyAttachmentMock,
    },
    conversationMessage: { deleteMany: deleteManyMessageMock },
    conversationSession: { deleteMany: deleteManySessionMock },
    conversation: { deleteMany: deleteManyConversationMock },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: deleteCloudreveAttachmentFilesMock,
}));

vi.mock('@/lib/llm/chatImageStorage', () => ({
  deleteConversationImages: deleteConversationImagesMock,
}));

vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: releaseStorageBytesMock,
}));

vi.mock('@/lib/logger', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => noopLogger,
  };
  return {
    logger: noopLogger,
    serializeError: (err: unknown) =>
      err instanceof Error ? { message: err.message } : { message: String(err) },
  };
});

import { deleteConversationsCascade } from '@/lib/conversationCascade';

describe('deleteConversationsCascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    transactionMock.mockResolvedValue([
      { count: 0 },
      { count: 0 },
      { count: 0 },
      { count: 1 },
    ]);
    deleteCloudreveAttachmentFilesMock.mockResolvedValue(true);
    deleteConversationImagesMock.mockResolvedValue(undefined);
    releaseStorageBytesMock.mockResolvedValue(null);
  });

  it('空数组 → 返回 0，不碰 DB / 文件 / 配额', async () => {
    const n = await deleteConversationsCascade([]);
    expect(n).toBe(0);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteCloudreveAttachmentFilesMock).not.toHaveBeenCalled();
  });

  it('去重 conversationId 后执行', async () => {
    await deleteConversationsCascade(['c1', 'c1', 'c2']);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: { in: ['c1', 'c2'] } },
      })
    );
  });

  it('先删物理文件 + 本地图片，再事务删 DB，最后按 owner 聚合释放配额', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        userId: 'u1',
        bytes: BigInt(100),
        cloudrevePath: '/u1/chat-uploads/c1_a.pdf',
        extractedTextPath: '/u1/chat-uploads/c1_a.pdf.txt',
      },
      {
        userId: 'u1',
        bytes: BigInt(50),
        cloudrevePath: '/u1/chat-uploads/c1_b.png',
        extractedTextPath: null,
      },
      {
        userId: 'u2',
        bytes: BigInt(200),
        cloudrevePath: '/u2/chat-uploads/c1_c.docx',
        extractedTextPath: null,
      },
    ]);

    const n = await deleteConversationsCascade(['c1']);

    expect(n).toBe(1);
    // 物理文件删除收到全部附件
    expect(deleteCloudreveAttachmentFilesMock).toHaveBeenCalledTimes(1);
    expect(deleteCloudreveAttachmentFilesMock.mock.calls[0][0]).toHaveLength(3);
    // 本地图片目录逐对话删
    expect(deleteConversationImagesMock).toHaveBeenCalledWith('c1');
    // 单事务删 DB
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // 按 owner 聚合释放：u1=150, u2=200
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('u1', 150);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('u2', 200);
    expect(releaseStorageBytesMock).toHaveBeenCalledTimes(2);
  });

  it('无附件时不调用配额释放，但仍删 DB 行', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const n = await deleteConversationsCascade(['c1']);
    expect(n).toBe(1);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
