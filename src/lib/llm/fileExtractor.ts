import 'server-only';

import { loadZipGuarded } from '@/lib/fileParser';
import { logger, serializeError } from '@/lib/logger';

const extractLogger = logger.child({ component: 'file-extractor' });

/** 输出文本上限：超过则截断（防止单文档撑爆 LLM context） */
export const MAX_OUTPUT_CHARS = 2_000_000;
export const TRUNCATION_MARKER = '\n\n…[文档过长，已截断]';

/** application/* 类纯文本/代码 MIME 白名单（text/* 走前缀匹配） */
const PLAIN_TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
]);

const MIME_PDF = 'application/pdf';
const MIME_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';
const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export interface ExtractedFile {
  /** 抽取后的纯文本（可能被截断） */
  text: string;
  /** 仅 PDF 提供页数 */
  pages?: number;
  /** 是否触发截断 */
  truncated: boolean;
}

export class UnsupportedMimeError extends Error {
  constructor(public readonly mimeType: string) {
    super(`Unsupported MIME type for text extraction: ${mimeType}`);
    this.name = 'UnsupportedMimeError';
  }
}

function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARKER,
    truncated: true,
  };
}

type OfficeParseFn = (b: Buffer) => Promise<{ toText(): string }>;

/**
 * 统一文件文本抽取入口：根据 MIME 选择解析器，输出纯文本（截断到 MAX_OUTPUT_CHARS）。
 *
 * 设计要点：
 *  - 所有重依赖都用动态 `import()` 加载，避免冷启动加载（也防止 Edge runtime 失败）；
 *  - 未识别 MIME → 抛 UnsupportedMimeError，调用方决定降级或拒绝；
 *  - 输出截断到 200 万字符，避免单文档撑爆 LLM context。
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractedFile> {
  const mt = mimeType.toLowerCase();

  // 先把不支持的 MIME 直接挡掉，避免下面 try 的 catch 把它当成解析失败再处理一次。
  if (!isExtractableMime(mt)) {
    throw new UnsupportedMimeError(mimeType);
  }

  try {
    if (mt === MIME_PDF) {
      // pdf-parse v2：具名导出 PDFParse 类（无 default 导出）。
      // getText({ pageJoiner: '' }) 抽全文；pageJoiner 置空避免注入 "-- N of M --" 页码标记。
      // result.total = 页数（取代 v1 的 numpages）。务必 destroy() 释放底层 pdfjs 资源。
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText({ pageJoiner: '' });
        const { text, truncated } = clamp(result.text || '');
        return { text, pages: result.total, truncated };
      } finally {
        await parser.destroy();
      }
    }

    if (mt === MIME_DOCX) {
      // DOCX 是 ZIP 容器：先做解压炸弹防护再交给 mammoth 解压。
      await loadZipGuarded(buffer);
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      const { text, truncated } = clamp(result.value || '');
      return { text, truncated };
    }

    if (mt === MIME_XLSX || mt === MIME_XLS) {
      // .xlsx 是 ZIP（OOXML）容器：先做解压炸弹防护再交给 exceljs 解压。
      // 注意：exceljs 仅支持 OOXML .xlsx，不支持旧 BIFF 二进制 .xls；遇到真正的 .xls
      // (OLE 复合文档，非 ZIP) loadZipGuarded 会抛 "not a zip" 被外层 catch 记录后向上抛，
      // 调用方按"抽取失败"降级（附件仍入库、仅无抽取文本）。换 xlsx→exceljs 的取舍。
      await loadZipGuarded(buffer);
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      // exceljs 接受 Buffer|ArrayBuffer；用 Uint8Array.from 复制出独立 ArrayBuffer，
      // 规避 @types/node 的 Buffer<ArrayBufferLike> 与库声明 Buffer 的泛型不兼容。
      await wb.xlsx.load(Uint8Array.from(buffer).buffer);
      const parts: string[] = [];
      wb.eachSheet((sheet) => {
        const rows: string[] = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const cells: string[] = [];
          // row.eachCell 跳过空单元格；cell.text 已把公式/富文本/超链接/日期/错误统一成显示文本。
          row.eachCell({ includeEmpty: false }, (cell) => {
            const t = cell.text;
            if (t) cells.push(t);
          });
          if (cells.length > 0) rows.push(cells.join(','));
        });
        parts.push(`# ${sheet.name}\n${rows.join('\n')}`);
      });
      const { text, truncated } = clamp(parts.join('\n\n'));
      return { text, truncated };
    }

    if (mt === MIME_PPTX) {
      // PPTX 是 ZIP 容器：交给 officeparser 前先做解压炸弹防护。
      await loadZipGuarded(buffer);
      // officeparser v7 暴露 `parseOffice(buffer) -> Promise<AST>`，AST 有 `.toText()`。
      // 兼容 CJS 默认导出与 ESM 命名导出。
      const mod = (await import('officeparser')) as {
        parseOffice?: OfficeParseFn;
        default?: { parseOffice?: OfficeParseFn };
      };
      const parseFn = mod.parseOffice ?? mod.default?.parseOffice;
      if (typeof parseFn !== 'function') {
        throw new Error('officeparser.parseOffice not found');
      }
      const ast = await parseFn(buffer);
      const raw = typeof ast?.toText === 'function' ? ast.toText() : '';
      const { text, truncated } = clamp(raw);
      return { text, truncated };
    }

    // 走到这里只能是 text/* 或 PLAIN_TEXT_MIMES 命中（已被上方 isExtractableMime 守卫）。
    const { text, truncated } = clamp(buffer.toString('utf8'));
    return { text, truncated };
  } catch (error) {
    extractLogger.warn(
      { mimeType, error: serializeError(error) },
      'file extraction failed'
    );
    throw error;
  }
}

/** 调用方在校验上传白名单时使用：判断当前 MIME 是否能抽到文本。 */
export function isExtractableMime(mimeType: string): boolean {
  const mt = mimeType.toLowerCase();
  return (
    mt === MIME_PDF ||
    mt === MIME_DOCX ||
    mt === MIME_XLSX ||
    mt === MIME_XLS ||
    mt === MIME_PPTX ||
    mt.startsWith('text/') ||
    PLAIN_TEXT_MIMES.has(mt)
  );
}
