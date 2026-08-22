import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMultipartRequest,
  readJson,
} from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  reserveStoredArtifactMock,
  recordReservedStoredArtifactLocationMock,
  settleStoredArtifactMock,
  rollbackStoredArtifactMock,
  markStoredArtifactOrphanMock,
  deleteCloudreveAttachmentFilesMock,
  enforceApiRateLimitMock,
  getSiteSettingsMock,
  uploadMock,
  createCloudreveStorageMock,
  conversationFindUniqueMock,
  chatAttachmentCreateMock,
  chatAttachmentDeleteManyMock,
  chatAttachmentFindManyMock,
  chatAttachmentUpdateManyMock,
  executeRawMock,
  extractTextFromBufferMock,
  isExtractableMimeMock,
  queryRawMock,
  getStoredArtifactMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  reserveStoredArtifactMock: vi.fn(),
  recordReservedStoredArtifactLocationMock: vi.fn(),
  settleStoredArtifactMock: vi.fn(),
  rollbackStoredArtifactMock: vi.fn(),
  markStoredArtifactOrphanMock: vi.fn(),
  deleteCloudreveAttachmentFilesMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  uploadMock: vi.fn(),
  createCloudreveStorageMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  chatAttachmentCreateMock: vi.fn(),
  chatAttachmentDeleteManyMock: vi.fn(),
  chatAttachmentFindManyMock: vi.fn(),
  chatAttachmentUpdateManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  extractTextFromBufferMock: vi.fn(),
  isExtractableMimeMock: vi.fn(),
  queryRawMock: vi.fn(),
  getStoredArtifactMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_STATE: { RESERVED: 'RESERVED', ACTIVE: 'ACTIVE' },
  STORED_ARTIFACT_TYPE: {
    CHAT_RAW: 'chat_raw',
    CHAT_EXTRACTED: 'chat_extracted',
  },
  StoredArtifactQuotaExceededError: class StoredArtifactQuotaExceededError extends Error {},
  reserveStoredArtifact: reserveStoredArtifactMock,
  recordReservedStoredArtifactLocation: recordReservedStoredArtifactLocationMock,
  settleStoredArtifact: settleStoredArtifactMock,
  rollbackStoredArtifact: rollbackStoredArtifactMock,
  markStoredArtifactOrphan: markStoredArtifactOrphanMock,
  settleStoredArtifactInTransaction: settleStoredArtifactMock,
  getStoredArtifactById: getStoredArtifactMock,
}));

vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: deleteCloudreveAttachmentFilesMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: {
      findUnique: conversationFindUniqueMock,
    },
    chatAttachment: {
      create: chatAttachmentCreateMock,
      deleteMany: chatAttachmentDeleteManyMock,
      findMany: chatAttachmentFindManyMock,
      updateMany: chatAttachmentUpdateManyMock,
    },
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
    $transaction: vi.fn(async (callback) =>
      callback({
        chatAttachment: { create: chatAttachmentCreateMock },
        $executeRaw: executeRawMock,
      })
    ),
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
import {
  CHAT_ATTACHMENT_TEXT_MAX_BYTES,
  CHAT_ATTACHMENT_TEXT_MAX_CHARS,
} from '@/lib/llm/chatAttachmentPolicy';
import { DocumentParserError } from '@/lib/documentParserProcess';
import { StoredArtifactQuotaExceededError } from '@/lib/storage/storedArtifactLedger';

describe('POST /api/chat-uploads', () => {
  beforeEach(() => {
    let reservationSequence = 0;
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'PRO',
    });
    reserveStoredArtifactMock.mockImplementation(
      async (input: { artifactType: string; expectedBytes: number }) => ({
        id: `artifact-${input.artifactType}-${++reservationSequence}`,
        userId: 'user-1',
        logicalKey: `logical-${input.artifactType}`,
        expectedBytes: BigInt(input.expectedBytes),
        state: 'RESERVED',
        reservationKey: `reservation-${reservationSequence}`,
      })
    );
    recordReservedStoredArtifactLocationMock.mockResolvedValue(undefined);
    settleStoredArtifactMock.mockResolvedValue({ artifact: {}, previous: null });
    rollbackStoredArtifactMock.mockResolvedValue(true);
    markStoredArtifactOrphanMock.mockResolvedValue(undefined);
    queryRawMock.mockResolvedValue([]);
    getStoredArtifactMock.mockResolvedValue({ state: 'RESERVED' });
    deleteCloudreveAttachmentFilesMock.mockResolvedValue(true);
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
    chatAttachmentDeleteManyMock.mockResolvedValue({ count: 1 });
    executeRawMock.mockResolvedValue(1);
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
      llmUsable: boolean;
      llmUnavailableReason: string | null;
    }>(response);
    expect(body.attachmentId).toEqual(expect.any(String));
    expect(body.kind).toBe('text');
    expect(body.fileName).toBe('notes.txt');
    expect(body.extractedTextPreview).toBe('extracted body');
    expect(body.llmUsable).toBe(true);
    expect(body.llmUnavailableReason).toBeNull();

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

    // 原文件和提取文本各有唯一账本预留，不再另改 User 计数。
    expect(reserveStoredArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversationId: 'conv-1',
        artifactType: 'chat_raw',
        expectedBytes: 11,
      })
    );
    expect(reserveStoredArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactType: 'chat_extracted',
        expectedBytes: Buffer.byteLength('extracted body'),
      })
    );
  });

  it('persists only the bounded LLM extract even when parser output is much larger', async () => {
    extractTextFromBufferMock.mockResolvedValueOnce({
      text: '文'.repeat(CHAT_ATTACHMENT_TEXT_MAX_CHARS + 100),
      truncated: false,
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const extractedUpload = uploadMock.mock.calls[1]?.[3] as Buffer;
    expect(extractedUpload).toBeInstanceOf(Buffer);
    expect(extractedUpload.byteLength).toBeLessThanOrEqual(
      CHAT_ATTACHMENT_TEXT_MAX_BYTES
    );
    expect(extractedUpload.toString('utf8')).toContain(
      'truncated due to size limit'
    );
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
    const body = await readJson<{
      kind: string;
      extractedTextPreview: string | null;
      llmUsable: boolean;
    }>(response);
    expect(body.kind).toBe('image');
    expect(body.extractedTextPreview).toBeNull();
    expect(body.llmUsable).toBe(true);
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
    const body = await readJson<{
      kind: string;
      extractedTextPreview: string | null;
      llmUsable: boolean;
      llmUnavailableReason: string | null;
    }>(response);
    expect(body.kind).toBe('document');
    expect(body.extractedTextPreview).toBeNull();
    expect(body.llmUsable).toBe(false);
    expect(body.llmUnavailableReason).toBe('extracted_text_unavailable');
    // 仅原文件被上传（extraction 失败 → 没有 .txt 上传）
    expect(uploadMock).toHaveBeenCalledTimes(1);

    const createArgs = chatAttachmentCreateMock.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.extractedTextPath).toBeNull();
  });

  it('解析子进程取消后立即 499，且不预留、不上传、不落库', async () => {
    extractTextFromBufferMock.mockRejectedValueOnce(
      new DocumentParserError('cancelled', 'cancelled')
    );
    const response = await POST(
      makeRequest({
        fileName: 'cancelled.pdf',
        contents: new Uint8Array([1, 2, 3, 4]),
        type: 'application/pdf',
      })
    );

    expect(response.status).toBe(499);
    expect(reserveStoredArtifactMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(chatAttachmentCreateMock).not.toHaveBeenCalled();
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
    const request = makeRequest({
      fileName: 'big.bin',
      contents: bigPayload,
      type: 'text/plain',
    });
    request.headers.set('content-length', String(3 * 1024 * 1024));
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('chunked/缺 Content-Length 的超限 multipart 仍按实际流字节 413', async () => {
    getSiteSettingsMock.mockResolvedValueOnce({ chat_files_max_upload_mb: 1 });
    // Parsing is never reached: the actual streamed bytes cross the cap first.
    // Use a raw network-like stream instead of undici's FormData encoder, whose
    // older Node implementation emits an unrelated enqueue-after-cancel error.
    const encoded = new Uint8Array(2 * 1024 * 1024 + 32);
    const headers = new Headers({
      'content-type': 'multipart/form-data; boundary=bounded-test',
    });
    const chunked = {
      url: 'http://localhost:3000/api/chat-uploads',
      method: 'POST',
      headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
    } as Request;

    const response = await POST(chunked);

    expect(response.status).toBe(413);
    expect(conversationFindUniqueMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('原文件账本预留超限 → 403，不上传', async () => {
    reserveStoredArtifactMock.mockRejectedValueOnce(
      new StoredArtifactQuotaExceededError()
    );
    const response = await POST(makeRequest());
    expect(response.status).toBe(403);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('预留成功但写 ChatAttachment 失败 → 500，且回滚两个账本预留', async () => {
    chatAttachmentCreateMock.mockRejectedValueOnce(new Error('db down'));
    const response = await POST(makeRequest());
    expect(response.status).toBe(500);
    const reservationIds = reserveStoredArtifactMock.mock.results.map(
      (result) => result.value
    );
    const resolvedReservations = await Promise.all(reservationIds);
    expect(rollbackStoredArtifactMock).toHaveBeenCalledWith(
      resolvedReservations[0]?.id
    );
    expect(rollbackStoredArtifactMock).toHaveBeenCalledWith(
      resolvedReservations[1]?.id
    );
  });

  it('附件行写入后账本发布失败 → 事务失败且删除文件、回滚两个预留', async () => {
    settleStoredArtifactMock.mockRejectedValueOnce(new Error('settle failed'));

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(chatAttachmentCreateMock).toHaveBeenCalledTimes(1);
    // 事务已回滚且 readback 证明 owner 不存在，不需要再做危险的盲删 owner。
    expect(chatAttachmentDeleteManyMock).not.toHaveBeenCalled();
    expect(deleteCloudreveAttachmentFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        cloudrevePath: expect.stringContaining('/conv-1_notes.txt'),
        extractedTextPath: expect.stringContaining(
          '/conv-1_notes.txt.extracted.txt'
        ),
      }),
    ]);

    const resolvedReservations = await Promise.all(
      reserveStoredArtifactMock.mock.results.map((result) => result.value)
    );
    expect(rollbackStoredArtifactMock).toHaveBeenCalledWith(
      resolvedReservations[0]?.id
    );
    expect(rollbackStoredArtifactMock).toHaveBeenCalledWith(
      resolvedReservations[1]?.id
    );
  });

  it('事务 ACK 丢失但 owner+两条 ledger readback 已提交时按成功返回且不删文件', async () => {
    settleStoredArtifactMock.mockRejectedValueOnce(new Error('commit ACK lost'));
    queryRawMock.mockImplementation(async () => {
      const data = chatAttachmentCreateMock.mock.calls[0]?.[0]?.data;
      const rawReservation = await reserveStoredArtifactMock.mock.results[0].value;
      return [
        {
          storedArtifactId: rawReservation.id,
          source: 'UPLOAD',
          cloudrevePath: data.cloudrevePath,
          extractedTextPath: data.extractedTextPath,
        },
      ];
    });
    getStoredArtifactMock.mockImplementation(async (artifactId: string) => {
      const locationCall = recordReservedStoredArtifactLocationMock.mock.calls.find(
        (call) => call[0] === artifactId
      );
      return { state: 'ACTIVE', reference: locationCall?.[1]?.reference };
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(deleteCloudreveAttachmentFilesMock).not.toHaveBeenCalled();
    expect(rollbackStoredArtifactMock).not.toHaveBeenCalled();
  });

  it('未知 MIME → 415，且在任何账本预留或物理写入前拒绝', async () => {
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
    expect(reserveStoredArtifactMock).not.toHaveBeenCalled();
    expect(rollbackStoredArtifactMock).not.toHaveBeenCalled();
  });

  it('超长文件名被截断，使 fileName / cloudrevePath / extractedTextPath 均 ≤191（U32）', async () => {
    // 250 字符的 base + .pdf → sanitize 后 254 字符，远超 191。
    const longName = `${'a'.repeat(250)}.pdf`;
    const response = await POST(
      makeRequest({
        fileName: longName,
        contents: new Uint8Array([1, 2, 3, 4]),
        type: 'application/pdf',
      })
    );
    expect(response.status).toBe(200);

    // 传给 Cloudreve 的 composedFileName = `${conversationId}_${safeFileName}`；
    // 其对应 remotePath /user-1/chat-uploads/<composed>(.extracted.txt) 必须 ≤191。
    const composed = uploadMock.mock.calls[0]?.[2] as string;
    const remotePath = `/user-1/chat-uploads/${composed}`;
    expect(remotePath.length).toBeLessThanOrEqual(191);
    expect(`${remotePath}.extracted.txt`.length).toBeLessThanOrEqual(191);

    // 落库的 fileName 本身也要 ≤191，且保留 .pdf 扩展名。
    const createArgs = chatAttachmentCreateMock.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    const savedFileName = createArgs.data.fileName as string;
    expect(savedFileName.length).toBeLessThanOrEqual(191);
    expect(savedFileName.endsWith('.pdf')).toBe(true);
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
        extractedTextPath: null,
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
      attachments: Array<{
        id: string;
        bytes: number;
        fileName: string;
        llmUsable: boolean;
        llmUnavailableReason: string | null;
      }>;
    }>(response);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.bytes).toBe(11);
    expect(body.attachments[0]?.fileName).toBe('a.txt');
    expect(body.attachments[0]?.llmUsable).toBe(true);
    expect(body.attachments[0]?.llmUnavailableReason).toBeNull();
    expect(chatAttachmentUpdateManyMock).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1', source: 'UPLOAD' },
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
