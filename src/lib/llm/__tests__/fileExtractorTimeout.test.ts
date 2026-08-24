import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L36 的继任者。
 *
 * 原始问题：DOCX / XLSX / PPTX 的解析**没有时长封顶**（只有 PDF 有 withParseTimeout），
 * 体积合法但 XML 嵌套极深的病态文档能长时间占住 CPU。当时的修法是给三条 in-process
 * 路径都套上 withParseTimeout。
 *
 * 现在的修法更强：PDF/Office 一律交给**可强杀的子进程**（documentParserProcess），
 * 由它负责堆上限、超时强杀、无网络无秘密的运行时（用例见
 * `src/lib/__tests__/documentParserProcess.test.ts`，其中「kills a child whose event
 * loop is permanently blocked」就是超时封顶本身）。
 *
 * 因此这里要钉住的不变式换成**接线**：这四类文档绝不能退回主进程里解析 ——
 * 一旦有人把 mammoth / exceljs / officeparser / pdf-parse 重新拉回 in-process，
 * 上面那些防线一条都用不上。
 */
const { extractAttachmentDocumentTextMock } = vi.hoisted(() => ({
  extractAttachmentDocumentTextMock: vi.fn(),
}));

vi.mock('@/lib/documentParserProcess', () => ({
  extractAttachmentDocumentText: extractAttachmentDocumentTextMock,
  DocumentParserError: class DocumentParserError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
    }
  },
}));

import { extractTextFromBuffer } from '@/lib/llm/fileExtractor';

const MIME_PDF = 'application/pdf';
const MIME_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('fileExtractor —— 复杂文档一律走可强杀的子进程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractAttachmentDocumentTextMock.mockResolvedValue('TEXT');
  });

  it.each([
    [MIME_PDF, 'PDF'],
    [MIME_DOCX, 'DOCX'],
    [MIME_XLSX, 'XLSX'],
    [MIME_PPTX, 'PPTX'],
  ])('%s（%s）交给 documentParserProcess，而不是在主进程里解析', async (mime) => {
    const text = await extractTextFromBuffer(Buffer.from('fake'), mime);

    expect(extractAttachmentDocumentTextMock).toHaveBeenCalledTimes(1);
    expect(extractAttachmentDocumentTextMock.mock.calls[0][1]).toBe(mime);
    expect(text).toBe('TEXT');
  });

  it('子进程被强杀/超时的错误如实向上抛（不会被当成"抽到空文本"吞掉）', async () => {
    extractAttachmentDocumentTextMock.mockRejectedValue(
      new Error('document parser timed out')
    );

    await expect(
      extractTextFromBuffer(Buffer.from('fake'), MIME_DOCX)
    ).rejects.toThrow(/timed out/);
  });
});
