// src/lib/fileParser.ts
// PDF / DOCX / PPTX / TXT 文件内容提取

import type JSZipType from 'jszip';

/**
 * 解压炸弹（zip bomb）防护上限：OOXML（docx/pptx/xlsx）本质是 ZIP 容器，
 * 一个 ~100KB 的恶意文件可声明解压出数 GB 内容，任意登录用户上传即可 OOM。
 * 在交给真正的解析器解压前，先累加 ZIP 内各 entry 的"未压缩大小"，超阈值直接拒绝。
 */
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200MB

/**
 * 解析超时上限（ms）。DOCX/PPTX/XLSX 有 ZIP 解压炸弹防护，但 PDF 经底层 pdfjs 解析，
 * 恶意/病态 PDF 可让解析长时间占满 CPU/内存。上传大小本身受 chat_files_max_upload_mb
 * 限制，这里再给解析时长封顶兜底。pdfjs 在 await 点让出事件循环，故超时多数情况可生效。
 */
export const PARSE_TIMEOUT_MS = 30_000;

/** 给一个解析 Promise 加超时；超时即 reject（不影响底层 destroy 在 finally 释放资源）。 */
export function withParseTimeout<T>(
  task: Promise<T>,
  label: string,
  timeoutMs = PARSE_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} 解析超时（>${Math.round(timeoutMs / 1000)}s），疑似恶意文档`
        )
      );
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

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
        // 安全：对解析时长封顶，防恶意 PDF 占满 CPU/内存致 DoS。
        const result = (await withParseTimeout(
          parser.getText({ pageJoiner: '' }),
          'PDF'
        )) as { text?: string };
        return result.text ?? '';
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

/**
 * PPTX 单次提取的累计文本上限（字符）。唯一消费者 extract-keywords 拿到后就截到 400k，
 * 这里的上限纯粹是资源闸：4M 字符 ≈ 8MB JS 字符串，正常演示文稿差着好几个数量级。
 */
export const MAX_PPTX_TEXT_CHARS = 4_000_000;

async function extractPptxText(buffer: Buffer): Promise<string> {
  // storage-parser#71：给整个 PPTX 提取套解析超时（此前只有 PDF 分支有）。正则改成线性之后
  // 这条是兜底 —— 幻灯片之间有 await 让出点，超时能真正生效。
  return withParseTimeout(extractPptxTextUnbounded(buffer), 'PPTX');
}

async function extractPptxTextUnbounded(buffer: Buffer): Promise<string> {
  // PPTX 是 ZIP 文件，解包后读取 ppt/slides/slide*.xml 中的文本。
  // loadZipGuarded 在解压前累加未压缩大小做防护（zip bomb）。
  const zip = await loadZipGuarded(buffer);
  const texts: string[] = [];
  let totalChars = 0;

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name.match(/ppt\/slides\/slide\d+\.xml$/)) {
      const xml = await entry.async('text');
      // 提取 <a:t> 标签内文本。
      //
      // storage-parser#71：原来的 `(.*?)` 对**未闭合**的 <a:t> 呈二次复杂度 —— exec 对每个能
      // 匹配 '<a:t>' 的起点都要向后扫描整个后缀去找 '</a:t>'，全部失败才返回 null，且 `.` 默认
      // 不匹配换行，攻击者只要不放换行就能让每次扫描跑满整串。实测 '<a:t>' 重复填充：
      // 100KB→480ms、200KB→1.9s、400KB→7.7s、800KB→31.6s（长度翻倍耗时翻四倍）。而
      // loadZipGuarded 允许 200MiB 声明未压缩量、这种高度重复的内容压缩比极高，几百 KB 的上传
      // 就能解出数十 MB 的 slide XML —— 一个请求把一个 CPU 核钉死数小时。
      // 换成 `[^<]*`：字符类在遇到第一个 '<' 即停，跨所有起点的总扫描量退化为 O(L)（同一载荷
      // 800KB 只要 0.6ms）。合法 OOXML 的文本内容里 '<' 必须转义成 '&lt;'，语义不变。
      const pattern = /<a:t>([^<]*)<\/a:t>/g;
      let match: RegExpExecArray | null;
      do {
        match = pattern.exec(xml);
        if (match?.[1]) {
          texts.push(match[1]);
          totalChars += match[1].length;
          if (totalChars >= MAX_PPTX_TEXT_CHARS) {
            return texts.join('\n').slice(0, MAX_PPTX_TEXT_CHARS);
          }
        }
      } while (match);
    }
  }

  return texts.join('\n');
}
