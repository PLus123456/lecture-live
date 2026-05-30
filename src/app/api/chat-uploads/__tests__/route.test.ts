import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMultipartRequest,
  readJson,
} from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  reserveStorageBytesMock,
  releaseStorageBytesMock,
  enforceApiRateLimitMock,
  getSiteSettingsMock,
  uploadMock,
  createCloudreveStorageMock,
  conversationFindUniqueMock,
  chatAttachmentCreateMock,
  chatAttachmentFindManyMock,
  chatAttachmentUpdateManyMock,
  extractTextFromBufferMock,
  isExtractableMimeMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  reserveStorageBytesMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  uploadMock: vi.fn(),
  createCloudreveStorageMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  chatAttachmentCreateMock: vi.fn(),
  chatAttachmentFindManyMock: vi.fn(),
  chatAttachmentUpdateManyMock: vi.fn(),
  extractTextFromBufferMock: vi.fn(),
  isExtractableMimeMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/quota', () => ({
  reserveStorageBytes: reserveStorageBytesMock,
  releaseStorageBytes: releaseStorageBytesMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: {
      findUnique: conversationFindUniqueMock,
    },
    chatAttachment: {
      create: chatAttachmentCreateMock,
      findMany: chatAttachmentFindManyMock,
      updateMany: chatAttachmentUpdateManyMock,
    },
  },
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceApiRateLimit: enforceApiRateLimitMock,
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: {
    create: createCloudreveStorageMock,
  },
}));

vi.mock('@/lib/llm/fileExtractor', () => ({
  extractTextFromBuffer: extractTextFromBufferMock,
  isExtractableMime: isExtractableMimeMock,
}));

// pino logger 噪音屏蔽（用与 chatFilesCleanupJob 测试同款 noop）
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

import { POST, GET } from '@/app/api/chat-uploads/route';

describe('POST /api/chat-uploads', () => {
  beforeEach(() => {
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'PRO',
    });
    reserveStorageBytesMock.mockResolvedValue(true);
    releaseStorageBytesMock.mockResolvedValue(null);
    enforceApiRateLimitMock.mockResolvedValue(null);
    getSiteSettingsMock.mockResolvedValue({ chat_files_max_upload_mb: 100 });
    // 默认 conversation 归属当前用户（Conversation.userId）
    conversationFindUniqueMock.mockResolvedValue({
      userId: 'user-1',
      endedAt: null,
    });
    createCloudreveStorageMock.mockResolvedValue({
      upload: uploadMock,
    });
    uploadMock.mockImplementation(
      async (_uid: string, _cat: string, fileName: string) =>
        `/user-1/chat-uploads/${fileName}`
    );
    chatAttachmentCreateMock.mockResolvedValue({ id: 'att-1' });
    // 默认所有 MIME 都被 isExtractableMime 报告为可抽 (text/plain 走前缀匹配也会进 fileExtractor)
    isExtractableMimeMock.mockImplementation((mt: string) => {
      const lower = mt.toLowerCase();
      return (
        lower.startsWith('text/') ||
        lower === 'application/pdf' ||
        lower === 'application/json'
      );
    });
    extractTextFromBufferMock.mockResolvedValue({
      text: 'extracted body',
      truncated: false,
    });
  });

  function makeRequest(opts?: {
    fileName?: string;
    contents?: string | Uint8Array;
    type?: string;
    conversationId?: string;
  }) {
    return createMultipartRequest(
      'http://localhost:3000/api/chat-uploads',
      { conversationId: opts?.conversationId ?? 'conv-1' },
      {
        fieldName: 'file',
        fileName: opts?.fileName ?? 'notes.txt',
        contents: opts?.contents ?? 'hello world',
        type: opts?.type ?? 'text/plain',
      }
    );
  }

  it('upload text/plain → kind=text，写 ChatAttachment，扣配额，回 preview', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);

    const body = await readJson<{
      attachmentId: string;
      cloudrevePath: string;
      kind: string;
      bytes: number;
      extractedTextPreview: string | null;
      fileName: string;
    }>(response);
    expect(body.attachmentId).toBe('att-1');
    expect(body.kind).toBe('text');
    expect(body.fileName).toBe('notes.txt');
    expect(body.extractedTextPreview).toBe('extracted body');

    // 上传两次：原文件 + 抽出的 .txt
    expect(uploadMock).toHaveBeenCalledTimes(2);
    // 第一次上传 fileName 应该是 ${conversationId}_${safeFileName}
    expect(uploadMock.mock.calls[0]?.[2]).toBe('conv-1_notes.txt');
    expect(uploadMock.mock.calls[1]?.[2]).toBe('conv-1_notes.txt.extracted.txt');

    // ChatAttachment.create 调用参数
    expect(chatAttachmentCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = chatAttachmentCreateMock.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.conversationId).toBe('conv-1');
    expect(createArgs.data.userId).toBe('user-1');
    expect(createArgs.data.kind).toBe('text');
    expect(createArgs.data.fileName).toBe('notes.txt');
    expect(createArgs.data.extractedTextPath).toBeTruthy();

    // 预留配额（bytes 等于 file.size = 'hello world'.length = 11）
    expect(reserveStorageBytesMock).toHaveBeenCalledWith('user-1', 11);
  });

  it('upload image/png → kind=image，不调用 extractTextFromBuffer', async () => {
    const response = await POST(
      makeRequest({
        fileName: 'pic.png',
        contents: new Uint8Array([1, 2, 3]),
        type: 'image/png',
      })
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ kind: string; extractedTextPreview: string | null }>(
      response
    );
    expect(body.kind).toBe('image');
    expect(body.extractedTextPreview).toBeNull();
    expect(extractTextFromBufferMock).not.toHaveBeenCalled();
    // 只上传一次（无副 .txt）
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('上传 PDF → kind=document，extractTextFromBuffer 抛错时仍创建 attachment（extractedTextPath=null）', async () => {
    extractTextFromBufferMock.mockRejectedValueOnce(new Error('corrupted pdf'));
    const response = await POST(
      makeRequest({
        fileName: 'doc.pdf',
        contents: new Uint8Array([1, 2, 3, 4]),
        type: 'application/pdf',
      })
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ kind: string; extractedTextPreview: string | null }>(
      response
    );
    expect(body.kind).toBe('document');
    expect(body.extractedTextPreview).toBeNull();
    // 仅原文件被上传（extraction 失败 → 没有 .txt 上传）
    expect(uploadMock).toHaveBeenCalledTimes(1);

    const createArgs = chatAttachmentCreateMock.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.extractedTextPath).toBeNull();
  });

  it('未登录返回 401', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
  });

  it('rate limit 触发时返回 rateLimit 提供的响应', async () => {
    const rlResp = new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
    });
    enforceApiRateLimitMock.mockResolvedValueOnce(rlResp);
    const response = await POST(makeRequest());
    expect(response.status).toBe(429);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('conversation 不存在 → 404', async () => {
    conversationFindUniqueMock.mockResolvedValueOnce(null);
    const response = await POST(makeRequest());
    expect(response.status).toBe(404);
  });

  it('conversation 归属其他用户 → 403', async () => {
    conversationFindUniqueMock.mockResolvedValueOnce({
      userId: 'user-2',
      endedAt: null,
    });
    const response = await POST(makeRequest());
    expect(response.status).toBe(403);
  });

  it('global conversation（userId 命中本人）允许上传', async () => {
    conversationFindUniqueMock.mockResolvedValueOnce({
      userId: 'user-1',
      endedAt: null,
    });
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
  });

  it('无主孤儿对话（userId=null）→ 403（orphan 宽进已收紧）', async () => {
    conversationFindUniqueMock.mockResolvedValueOnce({
      userId: null,
      endedAt: null,
    });
    const response = await POST(makeRequest());
    expect(response.status).toBe(403);
  });

  it('文件超过 chat_files_max_upload_mb → 413', async () => {
    // 设 max=1MB, 上传 2MB 文件 → 拒绝
    getSiteSettingsMock.mockResolvedValueOnce({ chat_files_max_upload_mb: 1 });
    const bigPayload = new Uint8Array(2 * 1024 * 1024); // 2MB
    const response = await POST(
      makeRequest({
        fileName: 'big.bin',
        contents: bigPayload,
        type: 'text/plain',
      })
    );
    expect(response.status).toBe(413);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('配额超限（reserveStorageBytes 返回 false）→ 403，不上传', async () => {
    reserveStorageBytesMock.mockResolvedValueOnce(false);
    const response = await POST(makeRequest());
    expect(response.status).toBe(403);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('预留成功但写 ChatAttachment 失败 → 500，且回滚已预留的字节配额', async () => {
    chatAttachmentCreateMock.mockRejectedValueOnce(new Error('db down'));
    const response = await POST(makeRequest());
    expect(response.status).toBe(500);
    // 先预留、后回滚，bytes 一致（'hello world' = 11）
    expect(reserveStorageBytesMock).toHaveBeenCalledWith('user-1', 11);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('user-1', 11);
  });

  it('未知 MIME → 415', async () => {
    isExtractableMimeMock.mockReturnValueOnce(false);
    const response = await POST(
      makeRequest({
        fileName: 'binary.bin',
        contents: new Uint8Array([0, 1, 2]),
        type: 'application/x-foobar',
      })
    );
    expect(response.status).toBe(415);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('空 conversationId → 400', async () => {
    const response = await POST(
      createMultipartRequest(
        'http://localhost:3000/api/chat-uploads',
        { conversationId: '' },
        {
          fieldName: 'file',
          fileName: 'x.txt',
          contents: 'hi',
          type: 'text/plain',
        }
      )
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/chat-uploads?conversationId=...', () => {
  beforeEach(() => {
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'PRO',
    });
    conversationFindUniqueMock.mockResolvedValue({
      userId: 'user-1',
      endedAt: null,
    });
    chatAttachmentFindManyMock.mockResolvedValue([
      {
        id: 'att-1',
        fileName: 'a.txt',
        mimeType: 'text/plain',
        kind: 'text',
        bytes: BigInt(11),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        cloudrevePath: '/user-1/chat-uploads/conv-1_a.txt',
      },
    ]);
    chatAttachmentUpdateManyMock.mockResolvedValue({ count: 1 });
  });

  it('返回 conversation 的附件列表 + 触发 lastAccessedAt 更新', async () => {
    const req = new Request(
      'http://localhost:3000/api/chat-uploads?conversationId=conv-1'
    );
    const response = await GET(req);
    expect(response.status).toBe(200);
    const body = await readJson<{
      attachments: Array<{ id: string; bytes: number; fileName: string }>;
    }>(response);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.bytes).toBe(11);
    expect(body.attachments[0]?.fileName).toBe('a.txt');
    expect(chatAttachmentUpdateManyMock).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1' },
      data: { lastAccessedAt: expect.any(Date) },
    });
  });

  it('缺 conversationId → 400', async () => {
    const req = new Request('http://localhost:3000/api/chat-uploads');
    const response = await GET(req);
    expect(response.status).toBe(400);
  });

  it('conversation 不存在 → 404', async () => {
    conversationFindUniqueMock.mockResolvedValueOnce(null);
    const req = new Request(
      'http://localhost:3000/api/chat-uploads?conversationId=nope'
    );
    const response = await GET(req);
    expect(response.status).toBe(404);
  });

  it('conversation 归属他人 → 403', async () => {
    conversationFindUniqueMock.mockResolvedValueOnce({
      userId: 'user-2',
      endedAt: null,
    });
    const req = new Request(
      'http://localhost:3000/api/chat-uploads?conversationId=conv-2'
    );
    const response = await GET(req);
    expect(response.status).toBe(403);
  });

  it('零附件时不调用 updateMany', async () => {
    chatAttachmentFindManyMock.mockResolvedValueOnce([]);
    const req = new Request(
      'http://localhost:3000/api/chat-uploads?conversationId=conv-1'
    );
    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(chatAttachmentUpdateManyMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const req = new Request(
      'http://localhost:3000/api/chat-uploads?conversationId=conv-1'
    );
    const response = await GET(req);
    expect(response.status).toBe(401);
  });
});
