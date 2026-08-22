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
        id: 'a1',
        userId: 'u1',
        bytes: BigInt(100),
        cloudrevePath: '/u1/chat-uploads/c1_a.pdf',
        extractedTextPath: '/u1/chat-uploads/c1_a.pdf.txt',
      },
      {
        id: 'a2',
        userId: 'u1',
        bytes: BigInt(50),
        cloudrevePath: '/u1/chat-uploads/c1_b.png',
        extractedTextPath: null,
      },
      {
        id: 'a3',
        userId: 'u2',
        bytes: BigInt(200),
        cloudrevePath: '/u2/chat-uploads/c1_c.docx',
        extractedTextPath: null,
      },
    ]);
    queryRawMock.mockResolvedValueOnce([
      {
        id: 'a1',
        userId: 'u1',
        bytes: BigInt(100),
        cloudrevePath: '/u1/chat-uploads/c1_a.pdf',
        extractedTextPath: '/u1/chat-uploads/c1_a.pdf.txt',
      },
      {
        id: 'a2',
        userId: 'u1',
        bytes: BigInt(50),
        cloudrevePath: '/u1/chat-uploads/c1_b.png',
        extractedTextPath: null,
      },
      {
        id: 'a3',
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
        id: 'a1',
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

/**
 * M28 窗口 1：事务外快照之后、事务之前插入同一对话的新附件。
 *
 * 步骤 4 删的是 `deleteMany({ conversationId })` —— 范围谓词，会把这些新行一并删掉，
 * 而步骤 2 的物理删除只拿到了快照，从没见过它们的 cloudrevePath。行一删路径永久丢失，
 * 兜底 cron 也再扫不到 → Cloudreve 上的原文件 + .extracted.txt 成永久孤儿。
 *
 * 这一组测试刻意用**能区分"提交前/提交后"的事务替身**：$transaction 替身在 await 完
 * callback 之后才往事件流里写 'tx:commit'，物理删除替身写 'delete:<paths>'。
 * 只断言"补删被调用过"是抓不住把补删写进事务里的错误实现的 —— 必须断言顺序。
 */
describe('deleteConversationsCascade —— M28 窗口 1（快照外新增行）', () => {
  let events: string[];

  const SNAPSHOT_ROW = {
    id: 'a1',
    userId: 'u1',
    bytes: BigInt(100),
    cloudrevePath: '/u1/chat-uploads/c1_old.pdf',
    extractedTextPath: '/u1/chat-uploads/c1_old.pdf.extracted.txt',
  };
  /** 快照之后才插入的新附件：文件已经传完 Cloudreve，行马上会被 deleteMany 带走。 */
  const RACE_ROW = {
    id: 'a2',
    userId: 'u1',
    bytes: BigInt(70),
    cloudrevePath: '/u1/chat-uploads/c1_raced.png',
    extractedTextPath: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];

    findManyMock.mockResolvedValue([SNAPSHOT_ROW]);
    // 事务内 FOR UPDATE 看到的是"真正会被删掉的那批行" = 快照行 + 竞态新增行
    queryRawMock.mockResolvedValue([SNAPSHOT_ROW, RACE_ROW]);

    deleteManyAttachmentMock.mockResolvedValue({ count: 2 });
    deleteManyMessageMock.mockResolvedValue({ count: 0 });
    deleteManySessionMock.mockResolvedValue({ count: 0 });
    deleteManyConversationMock.mockResolvedValue({ count: 1 });
    deleteConversationImagesMock.mockResolvedValue(undefined);
    releaseUserStorageBytesRawMock.mockResolvedValue(undefined);

    deleteCloudreveAttachmentFilesMock.mockImplementation(
      async (rows: Array<{ cloudrevePath: string }>) => {
        events.push(`delete:${rows.map((r) => r.cloudrevePath).join('|')}`);
        return true;
      }
    );

    // 关键：'tx:commit' 只在 callback 成功 await 完之后才写入。
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      events.push('tx:begin');
      const result = await cb(txClient);
      events.push('tx:commit');
      return result;
    });
  });

  it('竞态新增行的物理文件会被补删，且补删发生在事务提交之后', async () => {
    await deleteConversationsCascade(['c1']);

    // 两次物理删除：步骤 2 按快照，步骤 5 按"锁到但不在快照里"的差集。
    expect(deleteCloudreveAttachmentFilesMock).toHaveBeenCalledTimes(2);

    const supplemental = deleteCloudreveAttachmentFilesMock.mock
      .calls[1][0] as Array<{ cloudrevePath: string; extractedTextPath: string | null }>;
    // 只补删差集，不重复删已经删过的快照行。
    expect(supplemental).toEqual([
      {
        cloudrevePath: RACE_ROW.cloudrevePath,
        extractedTextPath: null,
      },
    ]);

    // 顺序：快照删 → 开事务 → 提交 → 补删。补删若写在事务里，这个断言会挂。
    expect(events).toEqual([
      `delete:${SNAPSHOT_ROW.cloudrevePath}`,
      'tx:begin',
      'tx:commit',
      `delete:${RACE_ROW.cloudrevePath}`,
    ]);
  });

  it('事务回滚 → 一个字节都不补删（行还在，文件就必须还在）', async () => {
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      events.push('tx:begin');
      await cb(txClient);
      // 走到提交这一步才失败：callback 里的差集已经算出来了，
      // 但事务没提交 → 那些行根本没被删掉，补删就是在制造悬垂引用。
      events.push('tx:rollback');
      throw new Error('deadlock; transaction rolled back');
    });

    await expect(deleteConversationsCascade(['c1'])).rejects.toThrow(/rolled back/);

    // 只有步骤 2 的快照删除发生过，补删一次都没有。
    expect(deleteCloudreveAttachmentFilesMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      `delete:${SNAPSHOT_ROW.cloudrevePath}`,
      'tx:begin',
      'tx:rollback',
    ]);
  });

  it('没有竞态新增行时不额外发起物理删除（不做无谓的第二次调用）', async () => {
    queryRawMock.mockResolvedValue([SNAPSHOT_ROW]);

    await deleteConversationsCascade(['c1']);

    expect(deleteCloudreveAttachmentFilesMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      `delete:${SNAPSHOT_ROW.cloudrevePath}`,
      'tx:begin',
      'tx:commit',
    ]);
  });

  it('锁定行的路径来自事务内重查，而非事务外快照（钉住 SELECT 必须带上两列路径）', async () => {
    await deleteConversationsCascade(['c1']);

    const sql = String(queryRawMock.mock.calls[0][0]?.strings ?? queryRawMock.mock.calls[0][0]);
    expect(sql).toContain('cloudrevePath');
    expect(sql).toContain('extractedTextPath');
    expect(sql).toContain('FOR UPDATE');
  });
});
