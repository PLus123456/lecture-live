import {
  CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
  CHAT_ATTACHMENT_SELECTION_MAX_COUNT,
  CHAT_ATTACHMENT_SELECTION_TOTAL_MAX_BYTES,
  CHAT_ATTACHMENT_TEXT_MAX_BYTES,
} from '@/lib/llm/chatAttachmentPolicy';

export interface ChatAttachmentSelectionCandidate {
  id: string;
  kind: 'image' | 'document' | 'text';
  bytes: number;
  llmUsable?: boolean;
}

export interface ChatAttachmentSelection {
  attachmentIds: string[];
  omittedByLimits: number;
  omittedUnavailable: number;
  reservedBytes: number;
}

/**
 * 构造一轮 chat 的显式附件集合。顺序稳定且只跳过当前超限项；文档/文本按服务端
 * extracted-text 最坏 512KiB 保守计费，图片按原始对象字节计费。服务端仍会独立复核。
 */
export function selectChatAttachmentsForLlm(
  candidates: ReadonlyArray<ChatAttachmentSelectionCandidate>
): ChatAttachmentSelection {
  const attachmentIds: string[] = [];
  const seenIds = new Set<string>();
  let omittedByLimits = 0;
  let omittedUnavailable = 0;
  let reservedBytes = 0;

  for (const candidate of candidates) {
    if (
      !candidate.id ||
      seenIds.has(candidate.id) ||
      candidate.llmUsable === false
    ) {
      if (candidate.llmUsable === false) omittedUnavailable += 1;
      continue;
    }
    seenIds.add(candidate.id);

    if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0) {
      omittedUnavailable += 1;
      continue;
    }

    const charge =
      candidate.kind === 'image'
        ? candidate.bytes
        : candidate.kind === 'document' || candidate.kind === 'text'
          ? CHAT_ATTACHMENT_TEXT_MAX_BYTES
          : Number.NaN;
    if (
      !Number.isSafeInteger(charge) ||
      charge <= 0 ||
      (candidate.kind === 'image' &&
        charge > CHAT_ATTACHMENT_IMAGE_MAX_BYTES)
    ) {
      omittedUnavailable += 1;
      continue;
    }

    if (
      attachmentIds.length >= CHAT_ATTACHMENT_SELECTION_MAX_COUNT ||
      reservedBytes + charge > CHAT_ATTACHMENT_SELECTION_TOTAL_MAX_BYTES
    ) {
      omittedByLimits += 1;
      continue;
    }

    attachmentIds.push(candidate.id);
    reservedBytes += charge;
  }

  return {
    attachmentIds,
    omittedByLimits,
    omittedUnavailable,
    reservedBytes,
  };
}
