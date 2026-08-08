import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findManyMock,
  transactionMock,
  queryRawMock,
  deleteManyAttachmentMock,
  deleteManyMessageMock,
  deleteManySessionMock,
  deleteManyConversationMock,
  deleteCloudreveAttachmentFilesMock,
  deleteConversationImagesMock,
  releaseUserStorageBytesRawMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  transactionMock: vi.fn(),
  queryRawMock: vi.fn(),
  deleteManyAttachmentMock: vi.fn(),
  deleteManyMessageMock: vi.fn(),
  deleteManySessionMock: vi.fn(),
  deleteManyConversationMock: vi.fn(),
  deleteCloudreveAttachmentFilesMock: vi.fn(),
  deleteConversationImagesMock: vi.fn(),
  releaseUserStorageBytesRawMock: vi.fn(),
}));

/** 事务替身：把 callback 交给一个带 $queryRaw / deleteMany 的 tx client。 */
const txClient = {
  $queryRaw: queryRawMock,
  chatAttachment: { deleteMany: deleteManyAttachmentMock },
  conversationMessage: { deleteMany: deleteManyMessageMock },
  conversationSession: { deleteMany: deleteManySessionMock },
  conversation: { deleteMany: deleteManyConversationMock },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: { findMany: findManyMock },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: deleteCloudreveAttachmentFilesMock,
}));

vi.mock('@/lib/llm/chatImageStorage', () => ({
  deleteConversationImages: deleteConversationImagesMock,
}));

vi.mock('@/lib/chatFileCleanup', () => ({
  releaseUserStorageBytesRaw: releaseUserStorageBytesRawMock,
}));

import { deleteConversationsCascade } from '@/lib/conversationCascade';

describe('deleteConversationsCascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([]);
    transactionMock.mockImplementation((cb: (tx: unknown) => unknown) => cb(txClient));
    deleteManyAttachmentMock.mockResolvedValue({ count: 0 });
    deleteManyMessageMock.mockResolvedValue({ count: 0 });
    deleteManySessionMock.mockResolvedValue({ count: 0 });
    deleteManyConversationMock.mockResolvedValue({ count: 1 });
    deleteCloudreveAttachmentFilesMock.mockResolvedValue(true);
    deleteConversationImagesMock.mockResolvedValue(undefined);
    releaseUserStorageBytesRawMock.mockResolvedValue(undefined);
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

  it('先删物理文件 + 本地图片，再事务内锁行释放配额 + 删 DB', async () => {
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
    queryRawMock.mockResolvedValueOnce([
      { id: 'a1', userId: 'u1', bytes: BigInt(100) },
      { id: 'a2', userId: 'u1', bytes: BigInt(50) },
      { id: 'a3', userId: 'u2', bytes: BigInt(200) },
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
    // 按 owner 聚合释放：u1=150, u2=200，且必须走事务客户端
    expect(releaseUserStorageBytesRawMock).toHaveBeenCalledWith(
      txClient,
      'u1',
      BigInt(150)
    );
    expect(releaseUserStorageBytesRawMock).toHaveBeenCalledWith(
      txClient,
      'u2',
      BigInt(200)
    );
    expect(releaseUserStorageBytesRawMock).toHaveBeenCalledTimes(2);
  });

  it('P5-13：并发删已把行删走（FOR UPDATE 锁到 0 行）→ 一分钱配额都不退', async () => {
    // 事务外快照仍看得到 3 个附件（并发的另一路删除尚未提交时读到的），
    // 但事务内 FOR UPDATE 重读为空 —— 说明另一路已提交并退过款，本路不得再退。
    findManyMock.mockResolvedValueOnce([
      {
        userId: 'u1',
        bytes: BigInt(100),
        cloudrevePath: '/u1/chat-uploads/c1_a.pdf',
        extractedTextPath: null,
      },
    ]);
    queryRawMock.mockResolvedValueOnce([]);

    await deleteConversationsCascade(['c1']);

    expect(releaseUserStorageBytesRawMock).not.toHaveBeenCalled();
  });

  it('无附件时不调用配额释放，但仍删 DB 行', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const n = await deleteConversationsCascade(['c1']);
    expect(n).toBe(1);
    expect(releaseUserStorageBytesRawMock).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
