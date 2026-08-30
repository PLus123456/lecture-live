import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  cloudreveCreateMock,
  cloudreveOpenStreamMock,
  chatAttachmentFindManyMock,
  chatAttachmentUpdateManyMock,
} = vi.hoisted(() => ({
  cloudreveCreateMock: vi.fn(),
  cloudreveOpenStreamMock: vi.fn(),
  chatAttachmentFindManyMock: vi.fn(),
  chatAttachmentUpdateManyMock: vi.fn(),
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: {
    create: cloudreveCreateMock,
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      findMany: chatAttachmentFindManyMock,
      updateMany: chatAttachmentUpdateManyMock,
    },
  },
}));

import {
  buildAttachmentsSystemMessage,
  concatRecordingReports,
  extractAttachmentImages,
  loadAttachmentsAsSystemBlocks as loadAttachmentsImpl,
  renderReportAsText,
  ATTACHMENT_DOWNLOAD_CONCURRENCY,
  ATTACHMENT_METADATA_PER_FILE_MAX_BYTES,
  ATTACHMENT_SELECTION_MAX_COUNT,
  ATTACHMENT_TEXT_PER_FILE_MAX_CHARS,
  ATTACHMENT_TEXT_TOTAL_MAX_CHARS,
  type AttachmentSystemBlock,
} from '@/lib/llm/chatAttachments';
import {
  __getChatAttachmentAdmissionForTests,
  __resetChatAttachmentAdmissionForTests,
  CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_BYTES,
  CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_DOWNLOADS,
  CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_REQUESTS,
  CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_BYTES,
  CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_DOWNLOADS,
  CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_REQUESTS,
  tryReserveChatAttachmentDownload,
} from '@/lib/llm/chatAttachmentAdmission';
import { CHAT_ATTACHMENT_TEXT_MAX_BYTES } from '@/lib/llm/chatAttachmentPolicy';

async function loadAttachmentsAsSystemBlocks(
  args: Omit<Parameters<typeof loadAttachmentsImpl>[0], 'userId'> & {
    userId?: string;
  }
): Promise<AttachmentSystemBlock[]> {
  const { userId = 'u', ...rest } = args;
  const loaded = await loadAttachmentsImpl({ ...rest, userId });
  try {
    return loaded.blocks;
  } finally {
    loaded.release();
  }
}

describe('renderReportAsText', () => {
  it('returns empty string for null / non-summarizable reports', () => {
    expect(renderReportAsText(null)).toBe('');
    expect(
      renderReportAsText({
        significance: { score: 0, reason: '', isWorthSummarizing: false },
        report: null,
        generatedAt: '',
      })
    ).toBe('');
  });

  it('renders report fields in stable plain-text form', () => {
    const out = renderReportAsText({
      significance: { score: 0.8, reason: '', isWorthSummarizing: true },
      report: {
        title: 'demo',
        topic: 'GraphQL fragments',
        participants: ['Alice', 'Bob'],
        date: '2026-05-22',
        duration: '45m',
        overview: 'A short call.',
        sections: [
          { title: 'Intro', points: ['Hello', 'World'] },
          { title: 'Outro', points: ['Done'] },
        ],
        conclusions: ['Ship it'],
        actionItems: ['Send notes'],
        keyTerms: { graphql: 'a query language' },
      },
      generatedAt: '2026-05-22T00:00:00Z',
    });

    expect(out).toContain('Topic: GraphQL fragments');
    expect(out).toContain('Participants: Alice, Bob');
    expect(out).toContain('Duration: 45m');
    expect(out).toContain('Overview: A short call.');
    expect(out).toContain('- Intro');
    expect(out).toContain('  - Hello');
    expect(out).toContain('Conclusions:');
    expect(out).toContain('- Ship it');
    expect(out).toContain('Action Items:');
    expect(out).toContain('Key Terms:');
    expect(out).toContain('- graphql: a query language');
  });
});

describe('concatRecordingReports', () => {
  it('joins multiple reports with per-recording headers and skips empty ones', () => {
    const out = concatRecordingReports([
      { recordingTitle: 'Lecture A', reportText: 'A summary' },
      { recordingTitle: 'Lecture B', reportText: '' }, // 应被跳过
      { recordingTitle: 'Lecture C', reportText: 'C summary' },
    ]);
    expect(out).toContain('[Recording: Lecture A]');
    expect(out).toContain('A summary');
    expect(out).toContain('[Recording: Lecture C]');
    expect(out).toContain('C summary');
    expect(out).not.toContain('Lecture B');
  });

  it('returns empty string when no reports have content', () => {
    expect(
      concatRecordingReports([
        { recordingTitle: 'A', reportText: '' },
        { recordingTitle: 'B', reportText: '   ' },
      ])
    ).toBe('');
  });
});

describe('buildAttachmentsSystemMessage', () => {
  it('returns empty string when only image blocks are present', () => {
    const blocks: AttachmentSystemBlock[] = [
      {
        attachmentId: 'a1',
        kind: 'image',
        fileName: 'pic.png',
        imageData: 'AAA',
        imageMediaType: 'image/png',
      },
    ];
    expect(buildAttachmentsSystemMessage(blocks)).toBe('');
  });

  it('emits per-file header for documents and text', () => {
    const out = buildAttachmentsSystemMessage([
      { attachmentId: 'a1', kind: 'document', fileName: 'spec.pdf', text: 'PDF_CONTENT' },
      { attachmentId: 'a2', kind: 'text', fileName: 'notes.md', text: 'MD_CONTENT' },
    ]);
    expect(out).toContain('[附件: spec.pdf]\nPDF_CONTENT');
    expect(out).toContain('[附件: notes.md]\nMD_CONTENT');
  });

  it('truncates total text injection to ATTACHMENT_TEXT_TOTAL_MAX_CHARS and adds marker', () => {
    const longText = 'x'.repeat(ATTACHMENT_TEXT_TOTAL_MAX_CHARS + 1000);
    const out = buildAttachmentsSystemMessage([
      { attachmentId: 'a1', kind: 'document', fileName: 'big.pdf', text: longText },
    ]);
    // body 应 ≤ MAX_TOTAL（包含 header），marker 之外
    expect(out).toContain('truncated due to size limit');
    // body 部分不会超出
    expect(out.length).toBeLessThan(
      ATTACHMENT_TEXT_TOTAL_MAX_CHARS + 200 /* marker + tolerance */
    );
  });

  it('skips later docs entirely when running out of budget after first', () => {
    const firstBody = 'a'.repeat(ATTACHMENT_TEXT_TOTAL_MAX_CHARS - 100);
    const out = buildAttachmentsSystemMessage([
      { attachmentId: 'a1', kind: 'document', fileName: 'big1.pdf', text: firstBody },
      { attachmentId: 'a2', kind: 'document', fileName: 'extra.pdf', text: 'never seen' },
    ]);
    expect(out).toContain('big1.pdf');
    expect(out).not.toContain('extra.pdf');
    expect(out).toContain('truncated');
  });
});

describe('extractAttachmentImages', () => {
  it('returns only image kinds with both imageData + mediaType', () => {
    const out = extractAttachmentImages([
      {
        attachmentId: 'a1',
        kind: 'image',
        fileName: 'a.png',
        imageData: 'IMG1',
        imageMediaType: 'image/png',
      },
      // 图片但缺数据 → 跳过
      { attachmentId: 'a2', kind: 'image', fileName: 'b.png' },
      // 文档 → 跳过
      { attachmentId: 'a3', kind: 'document', fileName: 'c.pdf', text: 'doc' },
      {
        attachmentId: 'a4',
        kind: 'image',
        fileName: 'd.jpg',
        imageData: 'IMG4',
        imageMediaType: 'image/jpeg',
      },
    ]);
    expect(out).toEqual([
      { mediaType: 'image/png', data: 'IMG1' },
      { mediaType: 'image/jpeg', data: 'IMG4' },
    ]);
  });
});

describe('loadAttachmentsAsSystemBlocks', () => {
  beforeEach(() => {
    __resetChatAttachmentAdmissionForTests();
    chatAttachmentFindManyMock.mockReset();
    chatAttachmentUpdateManyMock.mockReset();
    chatAttachmentUpdateManyMock.mockResolvedValue({ count: 0 });
    cloudreveCreateMock.mockReset();
    cloudreveOpenStreamMock.mockReset();
    cloudreveCreateMock.mockResolvedValue({
      openDownloadStream: cloudreveOpenStreamMock,
    });
  });

  function responseFrom(data: string): Response {
    const bytes = new TextEncoder().encode(data);
    return new Response(bytes, {
      headers: { 'content-length': String(bytes.byteLength) },
    });
  }

  function row(
    id: string,
    overrides: Partial<{
      kind: string;
      fileName: string;
      mimeType: string;
      cloudrevePath: string;
      extractedTextPath: string | null;
      userId: string;
      bytes: bigint;
    }> = {}
  ) {
    return {
      id,
      kind: 'document',
      fileName: `${id}.pdf`,
      mimeType: 'application/pdf',
      cloudrevePath: `/u/chat-uploads/c/${id}.pdf`,
      extractedTextPath: `/u/chat-uploads/c/${id}.txt`,
      userId: 'u',
      bytes: BigInt(128),
      ...overrides,
    };
  }

  it.each([
    ['missing', undefined],
    ['empty', []],
  ])('%s attachmentIds means zero loading', async (_label, attachmentIds) => {
    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c1',
      attachmentIds,
    });

    expect(out).toEqual([]);
    expect(chatAttachmentFindManyMock).not.toHaveBeenCalled();
    expect(cloudreveCreateMock).not.toHaveBeenCalled();
    expect(cloudreveOpenStreamMock).not.toHaveBeenCalled();
  });

  it('queries only normalized, explicit attachmentIds', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([]);
    await loadAttachmentsAsSystemBlocks({
      conversationId: 'c1',
      attachmentIds: [' x1 ', 'x2', 'x1'],
    });
    expect(chatAttachmentFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId: 'c1',
          userId: 'u',
          source: 'UPLOAD',
          id: { in: ['x1', 'x2'] },
        },
      })
    );
  });

  it('rejects too many explicit IDs before querying the database', async () => {
    await expect(
      loadAttachmentsAsSystemBlocks({
        conversationId: 'c1',
        attachmentIds: Array.from(
          { length: ATTACHMENT_SELECTION_MAX_COUNT + 1 },
          (_, index) => `a-${index}`
        ),
      })
    ).rejects.toThrow(
      `Too many attachmentIds (max ${ATTACHMENT_SELECTION_MAX_COUNT})`
    );
    expect(chatAttachmentFindManyMock).not.toHaveBeenCalled();
    expect(cloudreveCreateMock).not.toHaveBeenCalled();
  });

  it('dedups by cloudrevePath (same file referenced twice)', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      {
        id: 'a1',
        kind: 'document',
        fileName: 'foo.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/foo.pdf',
        extractedTextPath: '/u/chat-uploads/c/foo.txt',
        userId: 'u',
        bytes: BigInt(128),
      },
      {
        id: 'a2', // 同一 cloudrevePath 的另一条 — 应被过滤
        kind: 'document',
        fileName: 'foo.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/foo.pdf',
        extractedTextPath: '/u/chat-uploads/c/foo.txt',
        userId: 'u',
        bytes: BigInt(128),
      },
    ]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom('FOO_TEXT'));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['a1', 'a2'],
    });
    expect(out).toHaveLength(1);
    expect(cloudreveOpenStreamMock).toHaveBeenCalledTimes(1);
    expect(out[0].kind).toBe('document');
    expect(out[0].text).toBe('FOO_TEXT');
  });

  it('reads images as base64 (kind=image)', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      {
        id: 'a1',
        kind: 'image',
        fileName: 'pic.png',
        mimeType: 'image/png',
        cloudrevePath: '/u/chat-uploads/c/pic.png',
        extractedTextPath: null,
        userId: 'u',
        bytes: BigInt(128),
      },
    ]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom('PNGBYTES'));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['a1'],
      allowImages: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('image');
    expect(out[0].imageData).toBe(Buffer.from('PNGBYTES').toString('base64'));
    expect(out[0].imageMediaType).toBe('image/png');
  });

  it('does not admit or download image rows for a text-only model', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      row('image', {
        kind: 'image',
        bytes: BigInt(ATTACHMENT_METADATA_PER_FILE_MAX_BYTES + 1),
        cloudrevePath: '/u/chat-uploads/c/image.png',
        extractedTextPath: null,
      }),
      row('doc'),
    ]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom('DOC_TEXT'));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['image', 'doc'],
      allowImages: false,
    });

    expect(out).toEqual([
      expect.objectContaining({ attachmentId: 'doc', text: 'DOC_TEXT' }),
    ]);
    expect(cloudreveOpenStreamMock).toHaveBeenCalledTimes(1);
    expect(cloudreveOpenStreamMock).toHaveBeenCalledWith(
      '/u/chat-uploads/c/doc.txt',
      {
        expectedUserId: 'u',
        range: `bytes=0-${CHAT_ATTACHMENT_TEXT_MAX_BYTES - 1}`,
      }
    );
  });

  it('rejects per-file metadata over budget before creating storage client', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      row('large', {
        kind: 'image',
        extractedTextPath: null,
        bytes: BigInt(ATTACHMENT_METADATA_PER_FILE_MAX_BYTES + 1),
      }),
    ]);

    await expect(
      loadAttachmentsAsSystemBlocks({
        conversationId: 'c',
        attachmentIds: ['large'],
        allowImages: true,
      })
    ).rejects.toThrow('Attachment metadata per-file byte budget exceeded');
    expect(cloudreveCreateMock).not.toHaveBeenCalled();
    expect(cloudreveOpenStreamMock).not.toHaveBeenCalled();
  });

  it('rejects aggregate metadata over budget without any download', async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      row(`a${index}`, {
        kind: 'image',
        extractedTextPath: null,
        bytes: BigInt(ATTACHMENT_METADATA_PER_FILE_MAX_BYTES),
      })
    );
    chatAttachmentFindManyMock.mockResolvedValue(rows);

    await expect(
      loadAttachmentsAsSystemBlocks({
        conversationId: 'c',
        attachmentIds: rows.map(({ id }) => id),
        allowImages: true,
      })
    ).rejects.toThrow('Attachment metadata total byte budget exceeded');
    expect(cloudreveCreateMock).not.toHaveBeenCalled();
    expect(cloudreveOpenStreamMock).not.toHaveBeenCalled();
  });

  it('allows a large original document when only its bounded extracted text is read', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      row('large-doc', { bytes: BigInt(50 * 1024 * 1024) }),
    ]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom('SAFE_EXTRACT'));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['large-doc'],
    });

    expect(out[0]).toEqual(
      expect.objectContaining({ attachmentId: 'large-doc', text: 'SAFE_EXTRACT' })
    );
    expect(cloudreveOpenStreamMock).toHaveBeenCalledWith(
      '/u/chat-uploads/c/large-doc.txt',
      {
        expectedUserId: 'u',
        range: `bytes=0-${CHAT_ATTACHMENT_TEXT_MAX_BYTES - 1}`,
      }
    );
  });

  it('rejects a document with no extracted text before any remote read', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      row('raw-pdf', { extractedTextPath: null }),
    ]);

    await expect(
      loadAttachmentsAsSystemBlocks({
        conversationId: 'c',
        attachmentIds: ['raw-pdf'],
      })
    ).rejects.toThrow(
      'Attachment is not available for LLM (extracted_text_unavailable)'
    );
    expect(cloudreveCreateMock).not.toHaveBeenCalled();
    expect(cloudreveOpenStreamMock).not.toHaveBeenCalled();
  });

  it('rejects when the actual response stream exceeds its byte limit', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      row('lying-metadata', {
        kind: 'text',
        fileName: 'lying.txt',
        mimeType: 'text/plain',
        extractedTextPath: null,
        bytes: BigInt(1),
      }),
    ]);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      })
    );
    cloudreveOpenStreamMock.mockResolvedValueOnce(response);

    await expect(
      loadAttachmentsAsSystemBlocks({
        conversationId: 'c',
        attachmentIds: ['lying-metadata'],
      })
    ).rejects.toThrow('Attachment download byte budget exceeded');
    expect(chatAttachmentUpdateManyMock).not.toHaveBeenCalled();
    expect(__getChatAttachmentAdmissionForTests()).toMatchObject({
      requests: 0,
      downloads: 0,
      bytes: 0,
    });
  });

  it('reads only a bounded prefix of a legacy oversized extracted-text artifact', async () => {
    const legacyExtracted = 'x'.repeat(CHAT_ATTACHMENT_TEXT_MAX_BYTES + 100);
    chatAttachmentFindManyMock.mockResolvedValue([
      row('legacy-large-extract', { bytes: BigInt(50 * 1024 * 1024) }),
    ]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom(legacyExtracted));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['legacy-large-extract'],
    });

    expect(out[0].text).toContain('truncated due to size limit');
    expect(out[0].text).toHaveLength(ATTACHMENT_TEXT_PER_FILE_MAX_CHARS);
    expect(cloudreveOpenStreamMock).toHaveBeenCalledWith(
      '/u/chat-uploads/c/legacy-large-extract.txt',
      {
        expectedUserId: 'u',
        range: `bytes=0-${CHAT_ATTACHMENT_TEXT_MAX_BYTES - 1}`,
      }
    );
  });

  it('truncates per-file extracted text at ATTACHMENT_TEXT_PER_FILE_MAX_CHARS', async () => {
    const big = 'y'.repeat(ATTACHMENT_TEXT_PER_FILE_MAX_CHARS + 5000);
    chatAttachmentFindManyMock.mockResolvedValue([
      {
        id: 'a1',
        kind: 'document',
        fileName: 'big.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/big.pdf',
        extractedTextPath: '/u/chat-uploads/c/big.txt',
        userId: 'u',
        bytes: BigInt(128),
      },
    ]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom(big));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['a1'],
    });
    expect(out[0].text!.length).toBeLessThan(big.length);
    expect(out[0].text!).toContain('truncated');
  });

  it('preserves a legal small multi-byte UTF-8 text attachment', async () => {
    const text = '安全预算🙂多字节内容'.repeat(64);
    chatAttachmentFindManyMock.mockResolvedValue([row('utf8')]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom(text));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['utf8'],
    });

    expect(out).toEqual([
      expect.objectContaining({ attachmentId: 'utf8', text }),
    ]);
  });

  it('skips one failing attachment without failing the whole batch', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      {
        id: 'a1',
        kind: 'document',
        fileName: 'ok.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/ok.pdf',
        extractedTextPath: '/u/chat-uploads/c/ok.txt',
        userId: 'u',
        bytes: BigInt(128),
      },
      {
        id: 'a2',
        kind: 'document',
        fileName: 'fail.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/fail.pdf',
        extractedTextPath: '/u/chat-uploads/c/fail.txt',
        userId: 'u',
        bytes: BigInt(128),
      },
    ]);
    cloudreveOpenStreamMock
      .mockResolvedValueOnce(responseFrom('OK_TEXT'))
      .mockRejectedValueOnce(new Error('Cloudreve 500'));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['a1', 'a2'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].fileName).toBe('ok.pdf');
  });

  it('uses a small bounded worker pool for legal selected attachments', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(`a${index}`));
    chatAttachmentFindManyMock.mockResolvedValue(rows);
    let active = 0;
    let maxActive = 0;
    cloudreveOpenStreamMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return responseFrom('ok');
    });

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: rows.map(({ id }) => id),
    });

    expect(out).toHaveLength(rows.length);
    expect(maxActive).toBe(ATTACHMENT_DOWNLOAD_CONCURRENCY);
  });

  it('keeps a successful attachment lease until the caller explicitly releases it', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([row('held-after-download')]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom('held text'));

    const loaded = await loadAttachmentsImpl({
      conversationId: 'held-after-download',
      userId: 'held-user',
      attachmentIds: ['held-after-download'],
    });

    expect(loaded.blocks).toHaveLength(1);
    expect(__getChatAttachmentAdmissionForTests().requests).toBe(1);
    loaded.release();
    loaded.release();
    expect(__getChatAttachmentAdmissionForTests()).toMatchObject({
      requests: 0,
      downloads: 0,
      bytes: 0,
    });
  });

  it('rejects a third conversation for the same user without queueing, then releases in finally', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([row('held')]);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started = 0;
    let allStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    cloudreveOpenStreamMock.mockImplementation(async () => {
      started += 1;
      if (started === CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_REQUESTS) allStarted();
      await blocked;
      return responseFrom('ok');
    });

    const held = Array.from(
      { length: CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_REQUESTS },
      (_, index) =>
        loadAttachmentsAsSystemBlocks({
          conversationId: `held-${index}`,
          userId: 'same-user',
          attachmentIds: ['held'],
        })
    );
    await startedPromise;

    await expect(
      loadAttachmentsAsSystemBlocks({
        conversationId: 'overflow',
        userId: 'same-user',
        attachmentIds: ['held'],
      })
    ).rejects.toThrow('Attachment processing capacity is busy; retry later');
    expect(cloudreveOpenStreamMock).toHaveBeenCalledTimes(
      CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_REQUESTS
    );
    expect(__getChatAttachmentAdmissionForTests().requests).toBe(
      CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_REQUESTS
    );

    unblock();
    await Promise.all(held);
    expect(__getChatAttachmentAdmissionForTests()).toMatchObject({
      requests: 0,
      downloads: 0,
      bytes: 0,
    });
  });

  it('applies the process-global request barrier across distinct users', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([row('held')]);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started = 0;
    let allStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    cloudreveOpenStreamMock.mockImplementation(async () => {
      started += 1;
      if (started === CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_REQUESTS) {
        allStarted();
      }
      await blocked;
      return responseFrom('ok');
    });

    const held = Array.from(
      { length: CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_REQUESTS },
      (_, index) =>
        loadAttachmentsAsSystemBlocks({
          conversationId: `global-${index}`,
          userId: `user-${index}`,
          attachmentIds: ['held'],
        })
    );
    await startedPromise;

    await expect(
      loadAttachmentsAsSystemBlocks({
        conversationId: 'global-overflow',
        userId: 'one-more-user',
        attachmentIds: ['held'],
      })
    ).rejects.toThrow('Attachment processing capacity is busy; retry later');
    expect(cloudreveOpenStreamMock).toHaveBeenCalledTimes(
      CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_REQUESTS
    );

    unblock();
    await Promise.all(held);
    expect(__getChatAttachmentAdmissionForTests().requests).toBe(0);
  });

  it('atomically enforces and idempotently releases per-user and global byte reservations', () => {
    const userRelease = tryReserveChatAttachmentDownload(
      'byte-user',
      CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_BYTES - 1
    );
    expect(userRelease).not.toBeNull();
    expect(tryReserveChatAttachmentDownload('byte-user', 2)).toBeNull();
    userRelease?.();
    userRelease?.();

    const globalChunk = Math.floor(
      CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_BYTES / 3
    );
    const first = tryReserveChatAttachmentDownload('global-a', globalChunk);
    const second = tryReserveChatAttachmentDownload('global-b', globalChunk);
    const remaining =
      CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_BYTES - globalChunk * 2;
    const third = tryReserveChatAttachmentDownload('global-c', remaining);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(tryReserveChatAttachmentDownload('global-d', 1)).toBeNull();

    first?.();
    second?.();
    third?.();
    expect(__getChatAttachmentAdmissionForTests()).toMatchObject({
      requests: 0,
      downloads: 0,
      bytes: 0,
    });
  });

  it('reserves actual worker slots per user and process, not just request count', () => {
    const perUser = tryReserveChatAttachmentDownload(
      'slot-user',
      1,
      CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_DOWNLOADS
    );
    expect(perUser).not.toBeNull();
    expect(
      tryReserveChatAttachmentDownload('slot-user', 1, 1)
    ).toBeNull();
    perUser?.();

    const halfGlobal = CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_DOWNLOADS / 2;
    const first = tryReserveChatAttachmentDownload('slot-a', 1, halfGlobal);
    const second = tryReserveChatAttachmentDownload('slot-b', 1, halfGlobal);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(tryReserveChatAttachmentDownload('slot-c', 1, 1)).toBeNull();
    first?.();
    second?.();
  });

  it('returns [] silently when Cloudreve is not configured', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      {
        id: 'a1',
        kind: 'document',
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/doc.pdf',
        extractedTextPath: '/u/chat-uploads/c/doc.txt',
        userId: 'u',
        bytes: BigInt(128),
      },
    ]);
    cloudreveCreateMock.mockRejectedValueOnce(new Error('not configured'));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['a1'],
    });
    expect(out).toEqual([]);
    expect(__getChatAttachmentAdmissionForTests()).toMatchObject({
      requests: 0,
      downloads: 0,
      bytes: 0,
    });
  });

  it('updates lastAccessedAt for usable blocks (fire-and-forget)', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([
      {
        id: 'a1',
        kind: 'document',
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/doc.pdf',
        extractedTextPath: '/u/chat-uploads/c/doc.txt',
        userId: 'u',
        bytes: BigInt(128),
      },
    ]);
    cloudreveOpenStreamMock.mockResolvedValueOnce(responseFrom('TXT'));

    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c',
      attachmentIds: ['a1'],
    });
    expect(out).toHaveLength(1);

    // updateMany 是 fire-and-forget 的，给一拍 microtask 让它跑起来
    await Promise.resolve();
    await Promise.resolve();

    expect(chatAttachmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['a1'] } },
        data: expect.objectContaining({ lastAccessedAt: expect.any(Date) }),
      })
    );
  });
});
