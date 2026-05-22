import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  cloudreveCreateMock,
  cloudreveDownloadMock,
  chatAttachmentFindManyMock,
  chatAttachmentUpdateManyMock,
} = vi.hoisted(() => ({
  cloudreveCreateMock: vi.fn(),
  cloudreveDownloadMock: vi.fn(),
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
  loadAttachmentsAsSystemBlocks,
  renderReportAsText,
  ATTACHMENT_TEXT_PER_FILE_MAX_CHARS,
  ATTACHMENT_TEXT_TOTAL_MAX_CHARS,
  type AttachmentSystemBlock,
} from '@/lib/llm/chatAttachments';

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
    chatAttachmentFindManyMock.mockReset();
    chatAttachmentUpdateManyMock.mockReset();
    chatAttachmentUpdateManyMock.mockResolvedValue({ count: 0 });
    cloudreveCreateMock.mockReset();
    cloudreveDownloadMock.mockReset();
    cloudreveCreateMock.mockResolvedValue({
      downloadByRemotePath: cloudreveDownloadMock,
    });
  });

  it('returns [] without DB query when no rows found', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([]);
    const out = await loadAttachmentsAsSystemBlocks({
      conversationId: 'c1',
    });
    expect(out).toEqual([]);
  });

  it('filters by attachmentIds when provided', async () => {
    chatAttachmentFindManyMock.mockResolvedValue([]);
    await loadAttachmentsAsSystemBlocks({
      conversationId: 'c1',
      attachmentIds: ['x1', 'x2'],
    });
    expect(chatAttachmentFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'c1', id: { in: ['x1', 'x2'] } },
      })
    );
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
      },
      {
        id: 'a2', // 同一 cloudrevePath 的另一条 — 应被过滤
        kind: 'document',
        fileName: 'foo.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/foo.pdf',
        extractedTextPath: '/u/chat-uploads/c/foo.txt',
        userId: 'u',
      },
    ]);
    cloudreveDownloadMock.mockResolvedValueOnce(Buffer.from('FOO_TEXT'));

    const out = await loadAttachmentsAsSystemBlocks({ conversationId: 'c' });
    expect(out).toHaveLength(1);
    expect(cloudreveDownloadMock).toHaveBeenCalledTimes(1);
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
      },
    ]);
    cloudreveDownloadMock.mockResolvedValueOnce(Buffer.from('PNGBYTES'));

    const out = await loadAttachmentsAsSystemBlocks({ conversationId: 'c' });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('image');
    expect(out[0].imageData).toBe(Buffer.from('PNGBYTES').toString('base64'));
    expect(out[0].imageMediaType).toBe('image/png');
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
      },
    ]);
    cloudreveDownloadMock.mockResolvedValueOnce(Buffer.from(big));

    const out = await loadAttachmentsAsSystemBlocks({ conversationId: 'c' });
    expect(out[0].text!.length).toBeLessThan(big.length);
    expect(out[0].text!).toContain('truncated');
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
      },
      {
        id: 'a2',
        kind: 'document',
        fileName: 'fail.pdf',
        mimeType: 'application/pdf',
        cloudrevePath: '/u/chat-uploads/c/fail.pdf',
        extractedTextPath: '/u/chat-uploads/c/fail.txt',
        userId: 'u',
      },
    ]);
    cloudreveDownloadMock
      .mockResolvedValueOnce(Buffer.from('OK_TEXT'))
      .mockRejectedValueOnce(new Error('Cloudreve 500'));

    const out = await loadAttachmentsAsSystemBlocks({ conversationId: 'c' });
    expect(out).toHaveLength(1);
    expect(out[0].fileName).toBe('ok.pdf');
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
      },
    ]);
    cloudreveCreateMock.mockRejectedValueOnce(new Error('not configured'));

    const out = await loadAttachmentsAsSystemBlocks({ conversationId: 'c' });
    expect(out).toEqual([]);
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
      },
    ]);
    cloudreveDownloadMock.mockResolvedValueOnce(Buffer.from('TXT'));

    const out = await loadAttachmentsAsSystemBlocks({ conversationId: 'c' });
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
