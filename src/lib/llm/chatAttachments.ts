import 'server-only';

import { prisma } from '@/lib/prisma';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import type { ChatImageInput } from '@/lib/llm/gateway';
import { logger, serializeError } from '@/lib/logger';
import type { SessionReportData } from '@/types/report';

const chatAttLogger = logger.child({ component: 'chat-attachments' });

/**
 * 单条附件文本注入到 system 消息时的最大字符数。8000 字符 ≈ 2000 token，
 * 与 reportText 的截断阈值持平。再大单条文档会挤掉历史。
 */
export const ATTACHMENT_TEXT_PER_FILE_MAX_CHARS = 80_000;

/**
 * 所有附件文本总注入上限。本任务要求"附件文本注入上限 80K 字符（4x reportText）"，
 * 也即整个 conversation 的所有 attachments 抽取文本拼起来不能超过 80K 字符。
 *
 * 单文件最大与总量上限相同（在 plan 里：reportText 上限 8K，attachments 上限 80K）：
 * 实务上单文档可能就吃掉 80K，但多个小文档累计也不能超过同一上限。
 */
export const ATTACHMENT_TEXT_TOTAL_MAX_CHARS = 80_000;

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
 * 收集一组 ChatAttachment（按 conversationId + 可选 attachmentIds 过滤）→ 下载它们的
 * 图片二进制 / extractedTextPath 文本，转换成 AttachmentSystemBlock[]。
 *
 *  - dedup by cloudrevePath（避免一个 conversation 同一文件被点选两次）
 *  - 任意一条下载失败 → 记 warn 且跳过该条，整体流程不中断
 *  - 每条 document 文本超 ATTACHMENT_TEXT_PER_FILE_MAX_CHARS 直接截尾
 *
 * 全部 await 完后再批量 update lastAccessedAt（一条 SQL）以减少 DB round-trip。
 * lastAccessedAt 的更新即使 chat 流随后失败也保留 —— LRU 清理感知"今天有人用过"。
 */
export async function loadAttachmentsAsSystemBlocks(args: {
  conversationId: string;
  /** 若提供，则只取列表里这些 id；否则取 conversation 的全部 attachments */
  attachmentIds?: ReadonlyArray<string>;
}): Promise<AttachmentSystemBlock[]> {
  const { conversationId, attachmentIds } = args;

  const where =
    attachmentIds && attachmentIds.length > 0
      ? { conversationId, id: { in: [...attachmentIds] } }
      : { conversationId };

  const rows = await prisma.chatAttachment.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      cloudrevePath: true,
      extractedTextPath: true,
      userId: true,
    },
  });

  if (rows.length === 0) return [];

  // 按 cloudrevePath 去重（同一文件被同一 conversation 引用多次的极端情况）
  const seen = new Set<string>();
  const dedupRows = rows.filter((r) => {
    if (seen.has(r.cloudrevePath)) return false;
    seen.add(r.cloudrevePath);
    return true;
  });

  const cloudreve = await CloudreveStorage.create().catch((err) => {
    chatAttLogger.warn(
      { conversationId, err: serializeError(err) },
      'Cloudreve 未配置 / 不可用，附件无法注入'
    );
    return null;
  });
  if (!cloudreve) return [];

  const blocks = await Promise.all(
    dedupRows.map(async (row): Promise<AttachmentSystemBlock | null> => {
      try {
        if (row.kind === 'image') {
          const buf = await cloudreve.downloadByRemotePath(
            row.cloudrevePath,
            row.userId
          );
          return {
            attachmentId: row.id,
            kind: 'image',
            fileName: row.fileName,
            imageData: buf.toString('base64'),
            imageMediaType: row.mimeType,
          };
        }
        // document / text → 优先读 extractedTextPath；没有就直接当文本读 cloudrevePath
        const textPath = row.extractedTextPath || row.cloudrevePath;
        const buf = await cloudreve.downloadByRemotePath(textPath, row.userId);
        let text = buf.toString('utf-8');
        if (text.length > ATTACHMENT_TEXT_PER_FILE_MAX_CHARS) {
          text =
            text.slice(0, ATTACHMENT_TEXT_PER_FILE_MAX_CHARS) +
            TRUNCATION_MARKER;
        }
        const kind: 'document' | 'text' =
          row.kind === 'text' ? 'text' : 'document';
        return {
          attachmentId: row.id,
          kind,
          fileName: row.fileName,
          text,
        };
      } catch (err) {
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
    })
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

  return usable;
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
