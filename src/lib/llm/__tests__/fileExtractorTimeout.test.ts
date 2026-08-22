import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L36：DOCX / XLSX / PPTX 的解析此前**没有时长封顶**（只有 PDF 有 withParseTimeout）。
 * loadZipGuarded 只挡「解压后总字节」，挡不住「体积合法但 XML 嵌套极深 / 元素数极多」
 * 的病态文档 —— 那种文档能让 mammoth / exceljs / officeparser 长时间占住 CPU。
 *
 * 这里用替身把三条路径的解析器都换成秒回的桩，只断言**接线**：每条路径都必须经过
 * withParseTimeout，且带上正确的标签。
 */
const { withParseTimeoutMock, loadZipGuardedMock } = vi.hoisted(() => ({
  withParseTimeoutMock: vi.fn(),
  loadZipGuardedMock: vi.fn(),
}));

vi.mock('@/lib/fileParser', () => ({
  withParseTimeout: withParseTimeoutMock,
  loadZipGuarded: loadZipGuardedMock,
  PARSE_TIMEOUT_MS: 30_000,
}));

vi.mock('mammoth', () => ({
  extractRawText: vi.fn(async () => ({ value: 'DOCX_TEXT' })),
}));

vi.mock('exceljs', () => ({
  default: {
    Workbook: class {
      xlsx = { load: async () => undefined };
      eachSheet() {
        /* 无 sheet，输出空串即可 */
      }
    },
  },
}));

vi.mock('officeparser', () => ({
  parseOffice: vi.fn(async () => ({ toText: () => 'PPTX_TEXT' })),
}));

import { extractTextFromBuffer } from '@/lib/llm/fileExtractor';

const MIME_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('fileExtractor（L36 Office 解析必须有时长封顶）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadZipGuardedMock.mockResolvedValue(undefined);
    // 透传：不改变结果，只记录标签
    withParseTimeoutMock.mockImplementation(
      async (task: Promise<unknown>) => task
    );
  });

  it.each([
    [MIME_DOCX, 'DOCX'],
    [MIME_XLSX, 'XLSX'],
    [MIME_PPTX, 'PPTX'],
  ])('%s 的解析经过 withParseTimeout(%s)', async (mime, label) => {
    await extractTextFromBuffer(Buffer.from('fake'), mime);

    expect(withParseTimeoutMock).toHaveBeenCalledTimes(1);
    expect(withParseTimeoutMock.mock.calls[0][1]).toBe(label);
  });

  it('超时会被如实向上抛（不会被当成"抽到空文本"吞掉）', async () => {
    withParseTimeoutMock.mockRejectedValue(
      new Error('DOCX 解析超时（>30s），疑似恶意文档')
    );

    await expect(
      extractTextFromBuffer(Buffer.from('fake'), MIME_DOCX)
    ).rejects.toThrow(/解析超时/);
  });
});
