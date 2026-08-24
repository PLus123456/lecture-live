// src/lib/fileParser.ts
// PDF / DOCX / PPTX / TXT 文件内容提取

import type JSZipType from 'jszip';
import {
  extractKeywordDocumentText,
  type DocumentParserError,
} from '@/lib/documentParserProcess';
import {
  inspectDocumentArchive,
  ZIP_LIMITS,
} from '../../scripts/document-archive-preflight.mjs';

/**
 * 解压炸弹（zip bomb）防护上限：OOXML（docx/pptx/xlsx）本质是 ZIP 容器，
 * 一个 ~100KB 的恶意文件可声明解压出数 GB 内容，任意登录用户上传即可 OOM。
 * 在交给真正的解析器解压前，先累加 ZIP 内各 entry 的"未压缩大小"，超阈值直接拒绝。
 */
export const MAX_UNCOMPRESSED_BYTES = ZIP_LIMITS.maxUncompressedBytes;

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
 * ZIP 条目数上限。「几百万个 1 字节条目」同样能在**不触发字节上限**的前提下
 * 把解析耗尽（每个条目都要建 worker、走一遍 inflate 流水线）。
 */
export const MAX_ZIP_ENTRIES = 10_000;

/**
 * 第一道（廉价）守卫：遍历已 loadAsync 的 ZIP，累加每个 entry **声明的**未压缩大小。
 *
 * ⚠️ M27：这只是**声明值**（来自中央目录），JSZip 在 `loadAsync` 阶段既不解压也不校验
 * 它与实际流一致 —— `compressedObject.js:37` 那句 `data_length !== uncompressedSize`
 * 的校验发生在 **inflate 结束之后**，那时内存尖峰已经发生。所以攻击者构造「声明几 KB、
 * 实际解出数十 GB」的 docx/pptx/xlsx 就能整个绕过本守卫。
 *
 * 真正的守卫是 {@link assertZipInflationWithinLimit}（流式累计**实际**输出字节）。
 * 本函数保留为便宜的前置过滤：诚实的大文件在这里就被挡掉，不必白解压一遍。
 */
export function assertZipNotBomb(
  zip: JSZipType,
  maxBytes = MAX_UNCOMPRESSED_BYTES
): void {
  let total = 0;
  let entries = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    entries += 1;
    if (entries > MAX_ZIP_ENTRIES) {
      throw new Error(
        `Archive has too many entries (>${MAX_ZIP_ENTRIES}); refusing to parse (possible zip bomb)`
      );
    }
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

/** JSZip 的 StreamHelper（无公开类型）。 */
interface JSZipStreamHelper {
  on(
    event: 'data' | 'error' | 'end',
    handler: (payload?: unknown) => void
  ): JSZipStreamHelper;
  resume(): JSZipStreamHelper;
  pause(): JSZipStreamHelper;
}

interface JSZipEntryStreamable {
  internalStream(type: string): JSZipStreamHelper;
}

/**
 * M27 真守卫：**流式解压**每个 entry，累计**实际**输出字节数，超过上限立即中止。
 *
 * 为什么必须自己先解一遍：下游解析器（mammoth / officeparser）各自会重新 unzip，
 * 我们没有办法在它们内部插入计量点。所以这里先用受控的方式把整包过一遍——
 * 一旦累计输出越线就 `pause()` 停掉 worker 并抛错，下游根本拿不到这个 buffer。
 * 代价是合法文档会被多解压一次，但总量被 maxBytes 硬封顶（默认 200MiB），可接受。
 *
 * 用 `internalStream('uint8array')` 而不是 `async('text')`：后者会把整个 entry
 * 累积成一个字符串再返回，越线时内存已经吃掉了。
 */
export async function assertZipInflationWithinLimit(
  zip: JSZipType,
  maxBytes = MAX_UNCOMPRESSED_BYTES
): Promise<void> {
  let total = 0;

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;

    await new Promise<void>((resolve, reject) => {
      const stream = (
        entry as unknown as JSZipEntryStreamable
      ).internalStream('uint8array');

      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        try {
          // 暂停 worker：后续 tick 不再 inflate，膨胀就此打住
          stream.pause();
        } catch {
          // 忽略：已结束的流 pause 可能抛
        }
        if (error) reject(error);
        else resolve();
      };

      stream
        .on('data', (chunk?: unknown) => {
          const length = (chunk as { length?: number } | undefined)?.length ?? 0;
          total += length;
          if (total > maxBytes) {
            settle(
              new Error(
                `Decompressed size exceeds limit (${maxBytes} bytes); refusing to parse (possible zip bomb)`
              )
            );
          }
        })
        .on('error', (err?: unknown) => {
          settle(err instanceof Error ? err : new Error(String(err)));
        })
        .on('end', () => settle())
        .resume();
    });
  }
}

/**
 * 把 buffer 当作 ZIP 加载并做解压炸弹防护，返回已加载的 JSZip 实例。
 * 供 docx/pptx/xlsx 等 OOXML 解析路径在解压前统一调用。
 *
 * 两道守卫缺一不可：先按**声明值**廉价过滤，再按**实际解压字节**兜底（见 M27 注释）。
 */
export async function loadZipGuarded(
  buffer: Buffer,
  maxBytes = MAX_UNCOMPRESSED_BYTES
): Promise<JSZipType> {
  // 关键顺序：先扫描原始中央目录，再让 JSZip 建立 entry 对象。旧实现反过来，
  // entry 爆炸会在守卫运行前就耗尽共享 Web 进程。
  inspectDocumentArchive(buffer, {
    limits: { maxUncompressedBytes: maxBytes },
  });
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  assertZipNotBomb(zip, maxBytes);
  await assertZipInflationWithinLimit(zip, maxBytes);
  return zip;
}

export interface FileParserOptions {
  signal?: AbortSignal;
}

export async function extractTextFromFile(
  file: File,
  options: FileParserOptions = {}
): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());

  switch (file.type) {
    case 'application/pdf':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return extractKeywordDocumentText(buffer, file.type, options);

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

export type { DocumentParserError };
