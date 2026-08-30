import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { logger } from '@/lib/logger';
import {
  inspectDocumentArchive,
  UnsafeDocumentArchiveError,
} from '../../scripts/document-archive-preflight.mjs';

export const DOCUMENT_PARSE_TIMEOUT_MS = 30_000;
// 解析子进程的堆上限。256MB 会打死**正常文档**：实测 10 万段落的 276KB .docx
// 与 20 万行的 6.3MB .xlsx 都直接 SIGABRT（reached heap limit）。这类文件以前在
// Next 进程里按默认堆解析、超出只截断到 MAX_OUTPUT_CHARS，不会失败。
// 1GB 仍然把爆炸半径限制在单个可终止的子进程内，同时给真实讲义留出余量。
export const DOCUMENT_PARSER_MAX_OLD_SPACE_MB = 1024;
// 对齐 chat_files_max_upload_mb 的默认值（100MB）。低于上传上限时，65–100MB 的
// 附件能传上去却静默拿不到抽取文本 —— 用户看不到任何提示，只是「AI 读不到这份文件」。
// 文档翻译另有 translation_doc_max_mb=30 的更严限制，不受此影响。
export const DOCUMENT_PARSER_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const DOCUMENT_PARSER_MAX_CONCURRENCY = 2;
export const DOCUMENT_PARSER_MAX_QUEUED_BYTES = 128 * 1024 * 1024;
export const DOCUMENT_PARSER_MAX_QUEUE_ITEMS = 16;
export const DOCUMENT_PARSER_QUEUE_TIMEOUT_MS = 10_000;

const MAX_RESULT_BYTES = 32 * 1024 * 1024;
// 只保留子进程 stderr 的尾部用于诊断，不再拿它当终止条件。
const MAX_STDERR_TAIL_BYTES = 64 * 1024;

const MIME_PDF = 'application/pdf';
const MIME_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';
const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const OOXML_REQUIRED_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  [MIME_DOCX]: ['[Content_Types].xml', 'word/document.xml'],
  [MIME_XLSX]: ['[Content_Types].xml', 'xl/workbook.xml'],
  [MIME_PPTX]: ['[Content_Types].xml', 'ppt/presentation.xml'],
};

// Static resolution keeps the independent worker's package closure visible to
// Next output-file tracing even though the worker imports it in another process.
export const DOCUMENT_PARSER_RUNTIME_DEPENDENCIES = Object.freeze([
  require.resolve('jszip'),
  require.resolve('mammoth'),
  require.resolve('exceljs'),
  require.resolve('officeparser'),
  require.resolve('pdf-parse'),
]);

type ParserOperation = 'keyword-text' | 'attachment-text' | 'pdf-info';

export type DocumentParserErrorCode =
  | 'archive_limit'
  | 'invalid_archive'
  | 'invalid_document'
  | 'unsupported_type'
  | 'input_limit'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'worker_failed';

export class DocumentParserError extends Error {
  constructor(
    message: string,
    readonly code: DocumentParserErrorCode
  ) {
    super(message);
    this.name = 'DocumentParserError';
  }
}

interface ParserOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test-only fixture override; production callers never pass this. */
  workerPath?: string;
  /** Test-only lower heap ceiling; values above the production ceiling are rejected. */
  maxOldSpaceMb?: number;
}

interface PendingSlot {
  bytes: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let activeParsers = 0;
let queuedBytes = 0;
const pendingSlots: PendingSlot[] = [];

function cancelledError(): DocumentParserError {
  return new DocumentParserError('Document parsing was cancelled', 'cancelled');
}

function releaseParserSlot(): void {
  activeParsers = Math.max(0, activeParsers - 1);
  while (pendingSlots.length > 0 && activeParsers < DOCUMENT_PARSER_MAX_CONCURRENCY) {
    const pending = pendingSlots.shift()!;
    queuedBytes = Math.max(0, queuedBytes - pending.bytes);
    clearTimeout(pending.timer);
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
    if (pending.signal?.aborted) {
      pending.reject(cancelledError());
      continue;
    }
    activeParsers += 1;
    pending.resolve(releaseParserSlot);
  }
}

function acquireParserSlot(bytes: number, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  if (activeParsers < DOCUMENT_PARSER_MAX_CONCURRENCY) {
    activeParsers += 1;
    return Promise.resolve(releaseParserSlot);
  }
  if (
    pendingSlots.length >= DOCUMENT_PARSER_MAX_QUEUE_ITEMS ||
    queuedBytes + bytes > DOCUMENT_PARSER_MAX_QUEUED_BYTES
  ) {
    return Promise.reject(
      new DocumentParserError('Document parser is busy', 'busy')
    );
  }

  return new Promise((resolve, reject) => {
    const pending = {} as PendingSlot;
    const removePending = (): boolean => {
      const index = pendingSlots.indexOf(pending);
      if (index < 0) return false;
      pendingSlots.splice(index, 1);
      queuedBytes = Math.max(0, queuedBytes - bytes);
      return true;
    };
    const onAbort = (): void => {
      if (!removePending()) return;
      clearTimeout(pending.timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      if (!removePending()) return;
      signal?.removeEventListener('abort', onAbort);
      reject(new DocumentParserError('Document parser queue is full', 'busy'));
    }, DOCUMENT_PARSER_QUEUE_TIMEOUT_MS);
    timer.unref?.();

    Object.assign(pending, { bytes, resolve, reject, signal, onAbort, timer });
    queuedBytes += bytes;
    pendingSlots.push(pending);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function terminateChild(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall through to the direct child handle when the process group already exited.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // close/error will settle the runner.
  }
}

function resolveRuntimePaths(workerOverride?: string): {
  workerPath: string;
  preloadPath: string;
  archivePreflightPath: string;
  nodeModulePaths: string[];
} {
  const root = process.cwd();
  const workerPath =
    workerOverride ?? path.join(root, 'scripts', 'document-parser-worker.mjs');
  const preloadPath = path.join(root, 'scripts', 'document-parser-network-deny.cjs');
  const archivePreflightPath = path.join(
    root,
    'scripts',
    'document-archive-preflight.mjs'
  );
  const nodeModules = path.join(root, 'node_modules');
  const realNodeModules = realpathSync(nodeModules);
  return {
    workerPath,
    preloadPath,
    archivePreflightPath,
    nodeModulePaths:
      realNodeModules === nodeModules ? [nodeModules] : [nodeModules, realNodeModules],
  };
}

function parserExecArgs(
  operation: ParserOperation,
  mimeType: string,
  paths: ReturnType<typeof resolveRuntimePaths>,
  maxOldSpaceMb: number
): string[] {
  const args = [
    `--max-old-space-size=${maxOldSpaceMb}`,
    '--permission',
    `--allow-fs-read=${paths.workerPath}`,
    `--allow-fs-read=${paths.preloadPath}`,
    `--allow-fs-read=${paths.archivePreflightPath}`,
    ...paths.nodeModulePaths.map((entry) => `--allow-fs-read=${entry}`),
    '--require',
    paths.preloadPath,
  ];

  // pdfjs uses @napi-rs/canvas to install DOMMatrix even for text/info parsing;
  // keep addon permission limited to operations that load pdfjs/officeparser.
  if (
    mimeType === MIME_PDF ||
    (mimeType === MIME_PPTX && operation === 'attachment-text')
  ) {
    args.push('--allow-addons');
  }
  args.push(paths.workerPath, operation, mimeType);
  return args;
}

function normalizeWorkerResponse(
  raw: Buffer,
  operation: ParserOperation
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new DocumentParserError('Document parser returned invalid data', 'worker_failed');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DocumentParserError('Document parser returned invalid data', 'worker_failed');
  }
  const response = parsed as {
    ok?: unknown;
    value?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (response.ok !== true) {
    const allowed = new Set<DocumentParserErrorCode>([
      'archive_limit',
      'invalid_archive',
      'invalid_document',
      'unsupported_type',
    ]);
    const code =
      typeof response.error?.code === 'string' &&
      allowed.has(response.error.code as DocumentParserErrorCode)
        ? (response.error.code as DocumentParserErrorCode)
        : 'worker_failed';
    const message =
      typeof response.error?.message === 'string' && response.error.message.length <= 512
        ? response.error.message
        : 'Document parsing failed';
    throw new DocumentParserError(message, code);
  }

  const value = response.value as {
    text?: unknown;
    pages?: unknown;
    truncated?: unknown;
  };
  if (!value || typeof value !== 'object') {
    throw new DocumentParserError('Document parser returned invalid data', 'worker_failed');
  }
  if (operation === 'pdf-info') {
    if (!Number.isSafeInteger(value.pages) || Number(value.pages) < 0) {
      throw new DocumentParserError('Document parser returned invalid data', 'worker_failed');
    }
    return { pages: Number(value.pages) };
  }
  if (typeof value.text !== 'string' || value.text.length > 4_100_000) {
    throw new DocumentParserError('Document parser returned invalid data', 'worker_failed');
  }
  return {
    text: value.text,
    ...(typeof value.pages === 'number' && Number.isSafeInteger(value.pages)
      ? { pages: value.pages }
      : {}),
    ...(operation === 'attachment-text'
      ? { truncated: value.truncated === true }
      : {}),
  };
}

/** @internal Exported for focused termination/permission tests. */
export async function runRestrictedDocumentParser(
  operation: ParserOperation,
  buffer: Buffer,
  mimeType: string,
  options: ParserOptions = {}
): Promise<unknown> {
  if (buffer.byteLength <= 0 || buffer.byteLength > DOCUMENT_PARSER_MAX_INPUT_BYTES) {
    throw new DocumentParserError(
      `Document exceeds parser input limit (${DOCUMENT_PARSER_MAX_INPUT_BYTES} bytes)`,
      'input_limit'
    );
  }
  const timeoutMs = options.timeoutMs ?? DOCUMENT_PARSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new DocumentParserError('Invalid document parser timeout', 'worker_failed');
  }
  const maxOldSpaceMb = options.maxOldSpaceMb ?? DOCUMENT_PARSER_MAX_OLD_SPACE_MB;
  if (
    !Number.isSafeInteger(maxOldSpaceMb) ||
    maxOldSpaceMb < 16 ||
    maxOldSpaceMb > DOCUMENT_PARSER_MAX_OLD_SPACE_MB
  ) {
    throw new DocumentParserError('Invalid document parser heap limit', 'worker_failed');
  }

  const release = await acquireParserSlot(buffer.byteLength, options.signal);
  try {
    if (options.signal?.aborted) throw cancelledError();
    const paths = resolveRuntimePaths(options.workerPath);
    const child = spawn(
      process.execPath,
      parserExecArgs(operation, mimeType, paths, maxOldSpaceMb),
      {
        cwd: process.cwd(),
        detached: process.platform !== 'win32',
        env: {
          NODE_ENV: process.env.NODE_ENV ?? 'production',
          LANG: process.env.LANG ?? 'C.UTF-8',
          LC_ALL: process.env.LC_ALL ?? '',
          TZ: process.env.TZ ?? 'UTC',
          NODE_OPTIONS: '',
        },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
      }
    );

    return await new Promise((resolve, reject) => {
      let terminalError: DocumentParserError | null = null;
      let resultBytes = 0;
      let stderrBytes = 0;
      const resultChunks: Buffer[] = [];
      const stderrTail: Buffer[] = [];
      const stderrText = (): string =>
        Buffer.concat(stderrTail)
          .subarray(-MAX_STDERR_TAIL_BYTES)
          .toString('utf8')
          .trim();
      const logChildFailure = (reason: string, exitCode: number | null): void => {
        const detail = stderrText();
        if (!detail) return;
        logger.error(
          {
            component: 'document-parser',
            operation,
            reason,
            exitCode,
            stderrBytes,
            stderrTail: detail,
          },
          'Document parser subprocess failed'
        );
      };

      const requestTermination = (error: DocumentParserError): void => {
        terminalError ??= error;
        terminateChild(child);
      };
      const onAbort = (): void => requestTermination(cancelledError());
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        requestTermination(
          new DocumentParserError('Document parsing timed out', 'timeout')
        );
      }, timeoutMs);
      timer.unref?.();

      const resultStream = child.stdio[3];
      if (!resultStream || typeof resultStream.on !== 'function') {
        requestTermination(
          new DocumentParserError('Document parser response pipe is unavailable', 'worker_failed')
        );
      } else {
        resultStream.on('data', (chunk: Buffer) => {
          resultBytes += chunk.length;
          if (resultBytes > MAX_RESULT_BYTES) {
            requestTermination(
              new DocumentParserError('Document parser output exceeded its limit', 'worker_failed')
            );
            return;
          }
          resultChunks.push(chunk);
        });
      }

      // Keep a bounded TAIL of the child's stderr instead of killing the parse over it.
      //
      // Two reasons. First, pdfjs logs through console.warn, and one bad embedded font
      // subset emits thousands of `Warning: TT: undefined function` lines — well past
      // 64 KiB — so the old code SIGKILLed the child and threw away a result it had
      // very likely already produced. Chatty diagnostics are not an attack.
      //
      // Second, the worker collapses every non-allowlisted failure into
      // `invalid_document`, which the translate route reports as
      // 「PDF 解析失败（可能已加密或损坏）」. Counting these bytes and discarding the
      // content meant a missing package in the deployed tree — the #229/#231 failure
      // mode, twice in production — would read as "the user uploaded a bad file" with
      // nothing at all in journald. Both incidents at least printed a stack.
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrTail.push(chunk);
        let tailBytes = stderrTail.reduce((sum, part) => sum + part.length, 0);
        while (stderrTail.length > 1 && tailBytes > MAX_STDERR_TAIL_BYTES) {
          tailBytes -= stderrTail.shift()!.length;
        }
      });
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          requestTermination(
            new DocumentParserError('Document parser input failed', 'worker_failed')
          );
        }
      });
      child.on('error', () => {
        requestTermination(
          new DocumentParserError('Document parser failed to start', 'worker_failed')
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (terminalError) {
          logChildFailure(terminalError.code, code);
          reject(terminalError);
          return;
        }
        const payload = Buffer.concat(resultChunks, resultBytes);
        try {
          const response = normalizeWorkerResponse(payload, operation);
          if (code === 0) resolve(response);
          else {
            logChildFailure('nonzero_exit', code);
            reject(
              new DocumentParserError(
                'Document parser exited unsuccessfully',
                'worker_failed'
              )
            );
          }
        } catch (error) {
          logChildFailure('unparseable_response', code);
          reject(error);
        }
      });

      child.stdin?.end(buffer);
      if (options.signal?.aborted) onAbort();
    });
  } finally {
    release();
  }
}

function preflightArchive(buffer: Buffer, mimeType: string): void {
  if (mimeType === MIME_XLS) {
    // Preserve the previous extractor's explicit non-ZIP failure for legacy BIFF.
    inspectDocumentArchive(buffer);
    return;
  }
  const requiredEntries = OOXML_REQUIRED_ENTRIES[mimeType];
  if (!requiredEntries) return;
  try {
    inspectDocumentArchive(buffer, { requiredEntries });
  } catch (error) {
    if (error instanceof UnsafeDocumentArchiveError) {
      const code = error.code === 'archive_limit' ? 'archive_limit' : 'invalid_archive';
      throw new DocumentParserError(error.message, code);
    }
    throw error;
  }
}

export async function extractKeywordDocumentText(
  buffer: Buffer,
  mimeType: string,
  options: ParserOptions = {}
): Promise<string> {
  const mt = mimeType.toLowerCase();
  preflightArchive(buffer, mt);
  const value = (await runRestrictedDocumentParser(
    'keyword-text',
    buffer,
    mt,
    options
  )) as { text: string };
  return value.text;
}

export interface ParsedAttachmentDocument {
  text: string;
  pages?: number;
  truncated: boolean;
}

export async function extractAttachmentDocumentText(
  buffer: Buffer,
  mimeType: string,
  options: ParserOptions = {}
): Promise<ParsedAttachmentDocument> {
  const mt = mimeType.toLowerCase();
  preflightArchive(buffer, mt);
  return (await runRestrictedDocumentParser(
    'attachment-text',
    buffer,
    mt,
    options
  )) as ParsedAttachmentDocument;
}

export async function inspectPdfDocument(
  buffer: Buffer,
  options: ParserOptions = {}
): Promise<{ pages: number }> {
  return (await runRestrictedDocumentParser(
    'pdf-info',
    buffer,
    MIME_PDF,
    options
  )) as { pages: number };
}
