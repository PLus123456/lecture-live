// src/lib/fileParser.ts
// PDF / DOCX / PPTX / TXT 文件内容提取

import type JSZipType from 'jszip';

/**
 * 解压炸弹（zip bomb）防护上限：OOXML（docx/pptx/xlsx）本质是 ZIP 容器，
 * 一个 ~100KB 的恶意文件可声明解压出数 GB 内容，任意登录用户上传即可 OOM。
 * 在交给真正的解析器解压前，先累加 ZIP 内各 entry 的"未压缩大小"，超阈值直接拒绝。
 */
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200MB

/** 单个 ZIP entry 的元数据里 JSZip 暴露的未压缩大小（内部字段，无公开类型）。 */
interface JSZipEntryInternal {
  _data?: { uncompressedSize?: number };
}

/**
 * 解压炸弹守卫：遍历已 loadAsync 的 ZIP，累加每个 entry 的未压缩大小，
 * 超过 {@link MAX_UNCOMPRESSED_BYTES} 即抛错。
 *
 * 注意：必须在调用任何 `entry.async(...)`（真正解压）之前调用本守卫。
 */
export function assertZipNotBomb(
  zip: JSZipType,
  maxBytes = MAX_UNCOMPRESSED_BYTES
): void {
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const size = (entry as unknown as JSZipEntryInternal)._data
      ?.uncompressedSize;
    if (typeof size === 'number' && Number.isFinite(size)) {
      total += size;
      if (total > maxBytes) {
        throw new Error(
          `Decompressed size exceeds limit (${maxBytes} bytes); refusing to parse (possible zip bomb)`
        );
      }
    }
  }
}

/**
 * 把 buffer 当作 ZIP 加载并做解压炸弹防护，返回已加载的 JSZip 实例。
 * 供 docx/pptx/xlsx 等 OOXML 解析路径在解压前统一调用。
 */
export async function loadZipGuarded(
  buffer: Buffer,
  maxBytes = MAX_UNCOMPRESSED_BYTES
): Promise<JSZipType> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  assertZipNotBomb(zip, maxBytes);
  return zip;
}

export async function extractTextFromFile(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());

  switch (file.type) {
    case 'application/pdf': {
      // pdf-parse v2：具名导出 PDFParse 类（无 default 导出）；
      // getText({ pageJoiner: '' }) 抽全文，pageJoiner 置空避免注入 "-- N of M --" 页码标记。
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText({ pageJoiner: '' });
        return result.text;
      } finally {
        await parser.destroy();
      }
    }

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      // DOCX 是 ZIP 容器：先做解压炸弹防护再交给 mammoth。
      await loadZipGuarded(buffer);
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
      return await extractPptxText(buffer);
    }

    case 'text/plain': {
      return buffer.toString('utf-8');
    }

    default:
      throw new Error(`Unsupported type: ${file.type}`);
  }
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  // PPTX 是 ZIP 文件，解包后读取 ppt/slides/slide*.xml 中的文本。
  // loadZipGuarded 在解压前累加未压缩大小做防护（zip bomb）。
  const zip = await loadZipGuarded(buffer);
  const texts: string[] = [];

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name.match(/ppt\/slides\/slide\d+\.xml$/)) {
      const xml = await entry.async('text');
      // 提取 <a:t> 标签内文本
      const pattern = /<a:t>(.*?)<\/a:t>/g;
      let match: RegExpExecArray | null;
      do {
        match = pattern.exec(xml);
        if (match?.[1]) {
          texts.push(match[1]);
        }
      } while (match);
    }
  }

  return texts.join('\n');
}
