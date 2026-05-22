import 'server-only';

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
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      const { text, truncated } = clamp(result.text || '');
      return { text, pages: result.numpages, truncated };
    }

    if (mt === MIME_DOCX) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      const { text, truncated } = clamp(result.value || '');
      return { text, truncated };
    }

    if (mt === MIME_XLSX || mt === MIME_XLS) {
      const xlsx = await import('xlsx');
      const wb = xlsx.read(buffer, { type: 'buffer' });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        if (!sheet) continue;
        parts.push(`# ${sheetName}\n${xlsx.utils.sheet_to_csv(sheet)}`);
      }
      const { text, truncated } = clamp(parts.join('\n\n'));
      return { text, truncated };
    }

    if (mt === MIME_PPTX) {
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
