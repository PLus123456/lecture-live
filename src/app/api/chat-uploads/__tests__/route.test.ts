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
    // L61：远程名是 `${conversationId}_${12位随机hex}_${safeFileName}`（随机段防同名互删）
    const composed = uploadMock.mock.calls[0]?.[2] as string;
    expect(composed).toMatch(/^conv-1_[0-9a-f]{12}_notes\.txt$/);
    expect(uploadMock.mock.calls[1]?.[2]).toBe(`${composed}.extracted.txt`);

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

  it('未知 MIME → 415，且回滚已预留的字节配额（U5）', async () => {
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
    // U5：415 退出口也要 releaseStorageBytes，避免泄漏 reserveStorageBytes 已预留的字节。
    // 3 字节内容 → 预留 3、回滚 3。
    expect(reserveStorageBytesMock).toHaveBeenCalledWith('user-1', 3);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('user-1', 3);
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

  /* ────────────────────────────────────────────────────────────────
     L61：远程文件名必须唯一 —— 同对话重传同名文件不得共用 cloudrevePath
     （共用的后果：DELETE 任一行会物理删掉另一行还在用的那个文件）
     ──────────────────────────────────────────────────────────────── */
  it('L61：同对话上传两次同名文件 → 两个不同的远程路径', async () => {
    const first = await POST(makeRequest({ fileName: 'report.pdf', type: 'application/pdf' }));
    const second = await POST(makeRequest({ fileName: 'report.pdf', type: 'application/pdf' }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // 两次原文件上传用的远程名（.extracted.txt 是派生的，第 0/2 次调用是原文件）
    const firstComposed = uploadMock.mock.calls[0]?.[2] as string;
    const secondComposed = uploadMock.mock.calls[2]?.[2] as string;
    expect(firstComposed).not.toBe(secondComposed);

    // 落库的 cloudrevePath 同样必须不同 —— 这才是 DELETE 真正拿去删文件的那个值。
    const paths = chatAttachmentCreateMock.mock.calls.map(
      (call) => (call[0] as { data: { cloudrevePath: string } }).data.cloudrevePath
    );
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);

    // 用户可见的 fileName 列不受影响，仍是原始名。
    const names = chatAttachmentCreateMock.mock.calls.map(
      (call) => (call[0] as { data: { fileName: string } }).data.fileName
    );
    expect(names).toEqual(['report.pdf', 'report.pdf']);
  });

  it('L61：加了随机段之后，三列仍然全部 ≤191（U32 上限重新核对）', async () => {
    // 用超长 userId / conversationId / 文件名一起顶到最紧的情况。
    const longUserId = 'u'.repeat(30);
    verifyAuthMock.mockResolvedValue({
      id: longUserId,
      email: 'alice@example.com',
      role: 'PRO',
    });
    conversationFindUniqueMock.mockResolvedValue({
      userId: longUserId,
      endedAt: null,
    });
    uploadMock.mockImplementation(
      async (_uid: string, _cat: string, fileName: string) =>
        `/${longUserId}/chat-uploads/${fileName}`
    );
    const response = await POST(
      makeRequest({
        conversationId: 'c'.repeat(30),
        fileName: `${'n'.repeat(240)}.pdf`,
        contents: new Uint8Array([1, 2, 3, 4]),
        type: 'application/pdf',
      })
    );
    expect(response.status).toBe(200);

    const composed = uploadMock.mock.calls[0]?.[2] as string;
    const remotePath = `/${longUserId}/chat-uploads/${composed}`;
    expect(remotePath.length).toBeLessThanOrEqual(191);
    expect(`${remotePath}.extracted.txt`.length).toBeLessThanOrEqual(191);

    const createArgs = chatAttachmentCreateMock.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect((createArgs.data.fileName as string).length).toBeLessThanOrEqual(191);
    expect((createArgs.data.cloudrevePath as string).length).toBeLessThanOrEqual(191);
    expect((createArgs.data.extractedTextPath as string).length).toBeLessThanOrEqual(191);
  });

  /* ────────────────────────────────────────────────────────────────
     M29：无 content-length（chunked）的超大 body 必须被流式上限拦下
     ──────────────────────────────────────────────────────────────── */
  it('M29：chunked 超大 body → 413，且不读完全部分块、不预留配额', async () => {
    getSiteSettingsMock.mockResolvedValue({ chat_files_max_upload_mb: 1 });

    let pulled = 0;
    const CHUNKS = 500; // 500 × 64KB ≈ 32MB，远超 1MB+1MB 的闸门
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= CHUNKS) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const req = new Request('http://localhost:3000/api/chat-uploads', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'multipart/form-data; boundary=----zzz' },
      // @ts-expect-error duplex 是流式 body 的必填项，TS lib 尚未收录
      duplex: 'half',
    });
    // 前提复刻：这个请求确实没有 content-length，旧预检算出来就是 0。
    expect(req.headers.get('content-length')).toBeNull();

    const response = await POST(req);

    expect(response.status).toBe(413);
    expect(reserveStorageBytesMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    // 断流生效：没有把 32MB 全部拉进内存。
    expect(pulled).toBeLessThan(CHUNKS / 2);
  });

  /* ────────────────────────────────────────────────────────────────
     L60：`file` 是普通字符串字段时不得 500
     ──────────────────────────────────────────────────────────────── */
  it('L60：file 字段是字符串 → 400（旧代码在 arrayBuffer() 抛 TypeError，且不在 try 内 → 500）', async () => {
    const form = new FormData();
    form.set('conversationId', 'conv-1');
    form.set('file', 'not-a-file'); // 普通文本字段，不是文件
    const req = new Request('http://localhost:3000/api/chat-uploads', {
      method: 'POST',
      body: form,
    });

    const response = await POST(req);

    expect(response.status).toBe(400);
    // 两道大小检查此前都被绕过，配额与上传都不该发生。
    expect(reserveStorageBytesMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(chatAttachmentCreateMock).not.toHaveBeenCalled();
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

  it('L65：列表不得回传内部 cloudrevePath', async () => {
    const req = new Request(
      'http://localhost:3000/api/chat-uploads?conversationId=conv-1'
    );
    const response = await GET(req);
    const body = await readJson<{ attachments: Array<Record<string, unknown>> }>(
      response
    );
    expect(body.attachments[0]).not.toHaveProperty('cloudrevePath');
    // select 里也不该出现（不查就不会泄）
    const selectArg = chatAttachmentFindManyMock.mock.calls[0]?.[0] as {
      select: Record<string, unknown>;
    };
    expect(selectArg.select).not.toHaveProperty('cloudrevePath');
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
