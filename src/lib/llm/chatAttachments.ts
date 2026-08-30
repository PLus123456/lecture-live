import 'server-only';

import { prisma } from '@/lib/prisma';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import type { ChatImageInput } from '@/lib/llm/gateway';
import { LLMValidationError } from '@/lib/llm/security';
import {
  assessChatAttachmentForLlm,
  CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
  CHAT_ATTACHMENT_SELECTION_MAX_COUNT,
  CHAT_ATTACHMENT_SELECTION_TOTAL_MAX_BYTES,
  CHAT_ATTACHMENT_TEXT_MAX_CHARS,
} from '@/lib/llm/chatAttachmentPolicy';
import { tryReserveChatAttachmentDownload } from '@/lib/llm/chatAttachmentAdmission';
import { logger, serializeError } from '@/lib/logger';
import type { SessionReportData } from '@/types/report';

const chatAttLogger = logger.child({ component: 'chat-attachments' });

/**
 * 单条附件文本注入到 system 消息时的最大字符数。再大的单条文档会挤掉历史。
 */
export const ATTACHMENT_TEXT_PER_FILE_MAX_CHARS =
  CHAT_ATTACHMENT_TEXT_MAX_CHARS;

/**
 * 所有附件文本总注入上限。本任务要求"附件文本注入上限 80K 字符（4x reportText）"，
 * 也即整个 conversation 的所有 attachments 抽取文本拼起来不能超过 80K 字符。
 *
 * 单文件最大与总量上限相同（在 plan 里：reportText 上限 8K，attachments 上限 80K）：
 * 实务上单文档可能就吃掉 80K，但多个小文档累计也不能超过同一上限。
 */
export const ATTACHMENT_TEXT_TOTAL_MAX_CHARS = 80_000;

/** 单轮只允许调用方显式选择有限数量的附件。 */
export const ATTACHMENT_SELECTION_MAX_COUNT =
  CHAT_ATTACHMENT_SELECTION_MAX_COUNT;

/**
 * 图片/原始文本可直接用 DB bytes 做下载前准入；document 的 bytes 是原文件大小，
 * 若改读 extractedTextPath 则按文本流硬上限预留。两者都不能代替实际逐块计数。
 */
export const ATTACHMENT_METADATA_PER_FILE_MAX_BYTES =
  CHAT_ATTACHMENT_IMAGE_MAX_BYTES;
export const ATTACHMENT_METADATA_TOTAL_MAX_BYTES =
  CHAT_ATTACHMENT_SELECTION_TOTAL_MAX_BYTES;

/** 真正从远端响应流读入内存的硬上限。 */
export const ATTACHMENT_DOWNLOAD_PER_FILE_MAX_BYTES =
  CHAT_ATTACHMENT_IMAGE_MAX_BYTES;
export const ATTACHMENT_DOWNLOAD_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_DOWNLOAD_CONCURRENCY = 3;

const ATTACHMENT_ID_MAX_CHARS = 64;

/**
 * 预算拒绝必须与普通 Cloudreve 单文件故障区分：后者可 warn + skip，前者必须让
 * 整轮请求稳定失败，不能被附件级 catch 吞掉后变成静默降级。
 */
export class ChatAttachmentBudgetError extends LLMValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'ChatAttachmentBudgetError';
  }
}

export class ChatAttachmentCapacityError extends Error {
  constructor() {
    super('Attachment processing capacity is busy; retry later');
    this.name = 'ChatAttachmentCapacityError';
  }
}

class AttachmentDownloadBudget {
  private usedBytes = 0;
  exceeded = false;

  get remainingBytes(): number {
    return ATTACHMENT_DOWNLOAD_TOTAL_MAX_BYTES - this.usedBytes;
  }

  reject(message: string): never {
    this.exceeded = true;
    throw new ChatAttachmentBudgetError(message);
  }

  consume(bytes: number): void {
    if (
      this.exceeded ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.remainingBytes
    ) {
      this.reject('Attachment download byte budget exceeded');
    }
    this.usedBytes += bytes;
  }
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readResponseWithByteBudget(
  response: Response,
  budget: AttachmentDownloadBudget,
  maxFileBytes: number,
  overflowMode: 'reject' | 'truncate'
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const declaredBytes = parseContentLength(response);
  const declaredReadBytes =
    declaredBytes === null ? null : Math.min(declaredBytes, maxFileBytes);
  if (
    declaredBytes !== null &&
    declaredBytes > maxFileBytes &&
    overflowMode === 'reject'
  ) {
    budget.exceeded = true;
    await response.body?.cancel().catch(() => undefined);
    throw new ChatAttachmentBudgetError(
      'Attachment download byte budget exceeded'
    );
  }
  if (
    declaredReadBytes !== null &&
    declaredReadBytes > budget.remainingBytes
  ) {
    budget.exceeded = true;
    await response.body?.cancel().catch(() => undefined);
    throw new ChatAttachmentBudgetError(
      'Attachment download byte budget exceeded'
    );
  }

  if (!response.body) {
    return {
      buffer: Buffer.alloc(0),
      truncated: declaredBytes !== null && declaredBytes > maxFileBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let fileBytes = 0;
  let truncated =
    overflowMode === 'truncate' &&
    declaredBytes !== null &&
    declaredBytes > maxFileBytes;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remainingFileBytes = maxFileBytes - fileBytes;
      if (value.byteLength > remainingFileBytes) {
        if (overflowMode === 'reject') {
          budget.exceeded = true;
          await reader.cancel().catch(() => undefined);
          throw new ChatAttachmentBudgetError(
            'Attachment download byte budget exceeded'
          );
        }

        if (remainingFileBytes > 0) {
          try {
            budget.consume(remainingFileBytes);
          } catch (err) {
            await reader.cancel().catch(() => undefined);
            throw err;
          }
          fileBytes += remainingFileBytes;
          chunks.push(Buffer.from(value.subarray(0, remainingFileBytes)));
        }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      try {
        budget.consume(value.byteLength);
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        throw err;
      }
      fileBytes += value.byteLength;
      chunks.push(Buffer.from(value));

      if (
        overflowMode === 'truncate' &&
        fileBytes === maxFileBytes &&
        declaredBytes !== null &&
        declaredBytes > maxFileBytes
      ) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    buffer:
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, fileBytes),
    truncated,
  };
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  shouldStop: () => boolean,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;
  let fatalError: unknown;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (!fatalError && !shouldStop()) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          results[index] = await mapper(items[index]);
        } catch (err) {
          fatalError ??= err;
          return;
        }
      }
    }
  );

  // 即使某个 worker 预算失败，也等已经打开的有限几个流收尾，避免后台 Promise 泄漏。
  await Promise.all(workers);
  if (fatalError) throw fatalError;
  return results;
}

/** 截断标记，写在文本尾部便于 LLM 与用户都能看见 */
const TRUNCATION_MARKER = '\n\n[... truncated due to size limit ...]';

/**
 * 把 SessionReportData JSON 渲染成可读的纯文本，用于喂 LLM 作为 system 消息。
 * 与 src/lib/export/markdown.ts 的 toMarkdown 逻辑保持一致但只取核心字段 ——
 * 不需要表格、不需要时间戳，越简洁越省 token。
 *
 * 返回空串当 report 为 null / 不值得总结。
 */
export function renderReportAsText(report: SessionReportData | null): string {
  if (!report?.significance?.isWorthSummarizing || !report.report) return '';
  const r = report.report;
  const lines: string[] = [];
  if (r.topic) lines.push(`Topic: ${r.topic}`);
  if (r.participants?.length) {
    lines.push(`Participants: ${r.participants.join(', ')}`);
  }
  if (r.duration) lines.push(`Duration: ${r.duration}`);
  if (r.overview) lines.push(`\nOverview: ${r.overview}`);
  if (Array.isArray(r.sections) && r.sections.length > 0) {
    lines.push('\nSections:');
    for (const section of r.sections) {
      lines.push(`- ${section.title}`);
      for (const point of section.points ?? []) {
        lines.push(`  - ${point}`);
      }
    }
  }
  if (Array.isArray(r.conclusions) && r.conclusions.length > 0) {
    lines.push('\nConclusions:');
    for (const c of r.conclusions) lines.push(`- ${c}`);
  }
  if (Array.isArray(r.actionItems) && r.actionItems.length > 0) {
    lines.push('\nAction Items:');
    for (const item of r.actionItems) lines.push(`- ${item}`);
  }
  if (r.keyTerms && Object.keys(r.keyTerms).length > 0) {
    lines.push('\nKey Terms:');
    for (const [term, def] of Object.entries(r.keyTerms)) {
      lines.push(`- ${term}: ${def}`);
    }
  }
  return lines.join('\n');
}

/**
 * 把多个录音的 report 文本拼成单一段。每个录音前加 `[Recording: <title>]`
 * 头部，便于 LLM 区分。空报告自动跳过。
 *
 * 不在这里做总长度截断 —— 调用方（buildChatContext）会按 REPORT_TEXT_MAX_CHARS
 * 截尾。这里只负责拼接，避免双重截断造成歧义。
 */
export function concatRecordingReports(
  reports: Array<{ recordingTitle: string; reportText: string }>
): string {
  return reports
    .filter((r) => r.reportText.trim())
    .map((r) => `[Recording: ${r.recordingTitle}]\n${r.reportText}`)
    .join('\n\n');
}

/** 单条 ChatAttachment 转换成 system 消息后的形态 */
export interface AttachmentSystemBlock {
  attachmentId: string;
  kind: 'image' | 'document' | 'text';
  /** 仅 document/text：抽取出来的文本（已截断） */
  text?: string;
  /** 仅 image：base64 编码（不含 data: 前缀） */
  imageData?: string;
  imageMediaType?: string;
  /** 原始文件名 */
  fileName: string;
}

/**
 * `release` 持有本轮附件在途内存 reservation。只要 blocks 仍可能被 gateway
 * 序列化/发送，就必须继续持有；调用方在流结束、取消或流前失败时幂等释放。
 */
export interface LoadedAttachmentSystemBlocks {
  blocks: AttachmentSystemBlock[];
  release: () => void;
}

const NOOP_ATTACHMENT_RELEASE = () => {};

function emptyAttachmentLoad(): LoadedAttachmentSystemBlocks {
  return { blocks: [], release: NOOP_ATTACHMENT_RELEASE };
}

function truncateAttachmentText(text: string, force: boolean): string {
  if (!force && text.length <= ATTACHMENT_TEXT_PER_FILE_MAX_CHARS) {
    return text;
  }
  return (
    text.slice(
      0,
      Math.max(
        0,
        ATTACHMENT_TEXT_PER_FILE_MAX_CHARS - TRUNCATION_MARKER.length
      )
    ) + TRUNCATION_MARKER
  );
}

/**
 * 把 AttachmentSystemBlock[] 中所有 document/text 类附件的抽取文本拼成
 * 一条 system 消息内容。
 *
 *   [附件: foo.pdf]
 *   <text>
 *
 *   [附件: bar.docx]
 *   <text>
 *
 * 累计超 ATTACHMENT_TEXT_TOTAL_MAX_CHARS 时截尾并加 marker。
 * 没有任何 document/text → 返回空串。
 */
export function buildAttachmentsSystemMessage(
  blocks: ReadonlyArray<AttachmentSystemBlock>
): string {
  const docs = blocks.filter(
    (b): b is AttachmentSystemBlock & { text: string } =>
      (b.kind === 'document' || b.kind === 'text') && typeof b.text === 'string'
  );
  if (docs.length === 0) return '';

  /**
   * 最小可用内容字节数：单条 doc 要进总注入，至少要能塞下 header + 这么多正文。
   * 否则当前 doc 完整跳过 + 后续 doc 一律跳过（不做半截 inclusion，避免给 LLM 一堆"半句话"）。
   */
  const MIN_BODY_CHARS = 200;

  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const doc of docs) {
    const header = `[附件: ${doc.fileName}]\n`;
    const remaining = ATTACHMENT_TEXT_TOTAL_MAX_CHARS - used;
    if (remaining < header.length + MIN_BODY_CHARS) {
      // 余量太小：当前 doc 整段跳过，后续 doc 也全部跳过
      truncated = true;
      break;
    }
    let body = doc.text;
    const maxBody = remaining - header.length;
    if (body.length > maxBody) {
      body = body.slice(0, maxBody);
      truncated = true;
    }
    const block = header + body;
    parts.push(block);
    used += block.length + 2; // +2 for the joining "\n\n"
  }

  let result = parts.join('\n\n');
  if (truncated) result += TRUNCATION_MARKER;
  return result;
}

/**
 * 收集一组 ChatAttachment（按 conversationId + 显式 attachmentIds 过滤）→ 下载它们的
 * 图片二进制 / extractedTextPath 文本，转换成 AttachmentSystemBlock[]。
 *
 *  - attachmentIds 缺省或空数组都表示“不加载”，绝不回退为 conversation 全选
 *  - 在创建 Cloudreve client / 发起远端请求前完成数量与元数据字节预算校验
 *  - dedup by cloudrevePath（避免一个 conversation 同一文件被点选两次）
 *  - 实际响应体按字节读取，单文件和单轮都有硬上限；下载并发固定有界
 *  - 任意一条下载失败 → 记 warn 且跳过该条，整体流程不中断
 *  - 每条 document 文本超 ATTACHMENT_TEXT_PER_FILE_MAX_CHARS 直接截尾
 *
 * 全部 await 完后再批量 update lastAccessedAt（一条 SQL）以减少 DB round-trip。
 * lastAccessedAt 的更新即使 chat 流随后失败也保留 —— LRU 清理感知"今天有人用过"。
 */
export async function loadAttachmentsAsSystemBlocks(args: {
  conversationId: string;
  /** 已鉴权的 conversation owner；同时作为账号级在途预算键。 */
  userId: string;
  /** 只读取显式列出的 id；undefined / [] 均表示不读取附件。 */
  attachmentIds?: ReadonlyArray<string>;
  /** 纯文本模型传 false：图片在元数据准入前即被排除，更不会发起下载。 */
  allowImages?: boolean;
}): Promise<LoadedAttachmentSystemBlocks> {
  const { conversationId, userId, attachmentIds, allowImages = false } = args;

  if (!attachmentIds || attachmentIds.length === 0) {
    return emptyAttachmentLoad();
  }
  if (attachmentIds.length > ATTACHMENT_SELECTION_MAX_COUNT) {
    throw new ChatAttachmentBudgetError(
      `Too many attachmentIds (max ${ATTACHMENT_SELECTION_MAX_COUNT})`
    );
  }

  const normalizedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const rawId of attachmentIds) {
    if (typeof rawId !== 'string') {
      throw new LLMValidationError('attachmentIds must be strings');
    }
    const id = rawId.trim();
    if (!id || id.length > ATTACHMENT_ID_MAX_CHARS) {
      throw new LLMValidationError('attachmentIds entry invalid');
    }
    if (!seenIds.has(id)) {
      seenIds.add(id);
      normalizedIds.push(id);
    }
  }

  if (normalizedIds.length === 0) return emptyAttachmentLoad();

  const rows = await prisma.chatAttachment.findMany({
    where: {
      conversationId,
      userId,
      id: { in: normalizedIds },
      source: 'UPLOAD',
    } as never,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      cloudrevePath: true,
      extractedTextPath: true,
      userId: true,
      bytes: true,
    },
  });

  if (rows.length === 0) return emptyAttachmentLoad();

  // 按 cloudrevePath 去重（同一文件被同一 conversation 引用多次的极端情况）
  const seen = new Set<string>();
  const dedupRows = rows.filter((r) => {
    if (!allowImages && r.kind === 'image') return false;
    if (seen.has(r.cloudrevePath)) return false;
    seen.add(r.cloudrevePath);
    return true;
  });

  if (dedupRows.length === 0) return emptyAttachmentLoad();

  if (dedupRows.length > ATTACHMENT_SELECTION_MAX_COUNT) {
    throw new ChatAttachmentBudgetError(
      `Too many attachments selected (max ${ATTACHMENT_SELECTION_MAX_COUNT})`
    );
  }

  const admittedRows = dedupRows.map((row) => {
    const policy = assessChatAttachmentForLlm({
      kind: row.kind,
      bytes: row.bytes,
      hasExtractedText: Boolean(row.extractedTextPath),
    });
    if (!policy.llmUsable) {
      if (
        policy.llmUnavailableReason === 'image_too_large' ||
        policy.llmUnavailableReason === 'text_too_large' ||
        policy.llmUnavailableReason === 'invalid_metadata'
      ) {
        throw new ChatAttachmentBudgetError(
          'Attachment metadata per-file byte budget exceeded'
        );
      }
      throw new LLMValidationError(
        `Attachment is not available for LLM (${policy.llmUnavailableReason})`
      );
    }
    return { row, policy };
  });

  const reservedDownloadBytes = admittedRows.reduce(
    (sum, item) => sum + item.policy.reservedDownloadBytes,
    0
  );
  if (reservedDownloadBytes > ATTACHMENT_METADATA_TOTAL_MAX_BYTES) {
    throw new ChatAttachmentBudgetError(
      'Attachment metadata total byte budget exceeded'
    );
  }

  const reservedMemoryBytes = admittedRows.reduce(
    (sum, item) => sum + item.policy.reservedMemoryBytes,
    0
  );

  const releaseAdmission = tryReserveChatAttachmentDownload(
    userId,
    reservedMemoryBytes,
    Math.min(admittedRows.length, ATTACHMENT_DOWNLOAD_CONCURRENCY)
  );
  if (!releaseAdmission) throw new ChatAttachmentCapacityError();

  let leaseTransferred = false;
  try {
    const cloudreve = await CloudreveStorage.create().catch((err) => {
      chatAttLogger.warn(
        { conversationId, err: serializeError(err) },
        'Cloudreve 未配置 / 不可用，附件无法注入'
      );
      return null;
    });
    if (!cloudreve) return emptyAttachmentLoad();

    const downloadBudget = new AttachmentDownloadBudget();
    const blocks = await mapWithConcurrency(
      admittedRows,
      ATTACHMENT_DOWNLOAD_CONCURRENCY,
      () => downloadBudget.exceeded,
      async ({ row, policy }): Promise<AttachmentSystemBlock | null> => {
        try {
          const targetPath =
            policy.target === 'extracted'
              ? row.extractedTextPath!
              : row.cloudrevePath;
          const response = await cloudreve.openDownloadStream(targetPath, {
            expectedUserId: row.userId,
            ...(policy.target === 'extracted'
              ? { range: `bytes=0-${policy.maxDownloadBytes - 1}` }
              : {}),
          });
          const { buffer, truncated } = await readResponseWithByteBudget(
            response,
            downloadBudget,
            policy.maxDownloadBytes,
            policy.target === 'extracted' ? 'truncate' : 'reject'
          );

          if (row.kind === 'image') {
            return {
              attachmentId: row.id,
              kind: 'image',
              fileName: row.fileName,
              imageData: buffer.toString('base64'),
              imageMediaType: row.mimeType,
            };
          }

          const text = truncateAttachmentText(
            buffer.toString('utf-8'),
            truncated
          );
          const kind: 'document' | 'text' =
            row.kind === 'text' ? 'text' : 'document';
          return {
            attachmentId: row.id,
            kind,
            fileName: row.fileName,
            text,
          };
        } catch (err) {
          if (err instanceof ChatAttachmentBudgetError) throw err;
          chatAttLogger.warn(
            {
              conversationId,
              attachmentId: row.id,
              cloudrevePath: row.cloudrevePath,
              err: serializeError(err),
            },
            'Chat 附件下载失败，跳过该附件继续 chat'
          );
          return null;
        }
      }
    );

    const usable = blocks.filter((b): b is AttachmentSystemBlock => b !== null);

    // 批量更新 lastAccessedAt（fire-and-forget；失败不影响 chat）
    if (usable.length > 0) {
      const usedIds = usable.map((b) => b.attachmentId);
      prisma.chatAttachment
        .updateMany({
          where: { id: { in: usedIds } },
          data: { lastAccessedAt: new Date() },
        })
        .catch((err) => {
          chatAttLogger.warn(
            { conversationId, count: usedIds.length, err: serializeError(err) },
            'ChatAttachment.lastAccessedAt 批量更新失败（不影响本轮 chat）'
          );
        });
    }

    if (usable.length === 0) return emptyAttachmentLoad();

    leaseTransferred = true;
    return { blocks: usable, release: releaseAdmission };
  } finally {
    // 成功返回非空 blocks 后，reservation 随 blocks 移交给 chat route；其余所有
    // 路径（创建存储失败、全部附件跳过、预算异常）都在这里立即释放。
    if (!leaseTransferred) releaseAdmission();
  }
}

/**
 * 从 AttachmentSystemBlock[] 抽出图片，转为 gateway 期望的 ChatImageInput[]。
 * 用于追加到当前轮 user message 上。
 */
export function extractAttachmentImages(
  blocks: ReadonlyArray<AttachmentSystemBlock>
): ChatImageInput[] {
  return blocks
    .filter((b) => b.kind === 'image' && b.imageData && b.imageMediaType)
    .map((b) => ({
      mediaType: b.imageMediaType!,
      data: b.imageData!,
    }));
}
