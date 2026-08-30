export const CHAT_ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_ATTACHMENT_TEXT_MAX_CHARS = 80_000;
export const CHAT_ATTACHMENT_SELECTION_MAX_COUNT = 32;
export const CHAT_ATTACHMENT_SELECTION_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
const CHAT_ATTACHMENT_TEXT_TRUNCATION_MARKER =
  '\n\n[... truncated due to size limit ...]';

/**
 * 附件文本最终只会注入 80K UTF-16 字符；512KiB 足以容纳最坏 UTF-8 编码并留出余量，
 * 无需为了截断后的少量文本把数 MB 的抽取副本读进堆。
 */
export const CHAT_ATTACHMENT_TEXT_MAX_BYTES = 512 * 1024;
/**
 * 覆盖 fetch chunk、合并 Buffer、base64/data URI、gateway JSON 字符串及其 UTF-8
 * request body 同时存活的峰值；按原始响应 8 倍保守 charge。
 */
export const CHAT_ATTACHMENT_MEMORY_RESERVATION_MULTIPLIER = 8;

export function prepareExtractedTextForLlm(text: string): string {
  if (text.length <= CHAT_ATTACHMENT_TEXT_MAX_CHARS) return text;
  return (
    text.slice(
      0,
      CHAT_ATTACHMENT_TEXT_MAX_CHARS -
        CHAT_ATTACHMENT_TEXT_TRUNCATION_MARKER.length
    ) + CHAT_ATTACHMENT_TEXT_TRUNCATION_MARKER
  );
}

export type ChatAttachmentLlmUnavailableReason =
  | 'image_too_large'
  | 'text_too_large'
  | 'extracted_text_unavailable'
  | 'unsupported_kind'
  | 'invalid_metadata';

export type ChatAttachmentKind = 'image' | 'document' | 'text';

export type ChatAttachmentLlmPolicy =
  | {
      llmUsable: true;
      llmUnavailableReason: null;
      /** 准入时按最坏情况预留的在途响应字节。 */
      reservedDownloadBytes: number;
      /** 进程级 gate 使用的保守堆内存 charge（含 base64/Buffer 放大）。 */
      reservedMemoryBytes: number;
      /** 逐块读取该目标时的实际硬上限。 */
      maxDownloadBytes: number;
      target: 'original' | 'extracted';
    }
  | {
      llmUsable: false;
      llmUnavailableReason: ChatAttachmentLlmUnavailableReason;
      reservedDownloadBytes: 0;
      reservedMemoryBytes: 0;
      maxDownloadBytes: 0;
      target: null;
    };

function normalizeBytes(bytes: bigint | number): bigint | null {
  if (typeof bytes === 'bigint') {
    return bytes > BigInt(0) ? bytes : null;
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return BigInt(bytes);
}

function unavailable(
  reason: ChatAttachmentLlmUnavailableReason
): ChatAttachmentLlmPolicy {
  return {
    llmUsable: false,
    llmUnavailableReason: reason,
    reservedDownloadBytes: 0,
    reservedMemoryBytes: 0,
    maxDownloadBytes: 0,
    target: null,
  };
}

/**
 * 判断单个已持久化附件能否安全用于 LLM。
 *
 * `bytes` 是原文件大小，并不是 extractedTextPath 的大小。因此：
 * - 有抽取文本的超大 Office/PDF 仍可用，但按文本流硬上限做最坏预留；
 * - 图片与没有抽取副本的纯文本直接读取原文件，DB bytes 可用于下载前准入；
 * - document 没有抽取副本时不把 PDF/Office 二进制误当 UTF-8 喂给模型。
 */
export function assessChatAttachmentForLlm(input: {
  kind: string;
  bytes: bigint | number;
  hasExtractedText: boolean;
}): ChatAttachmentLlmPolicy {
  const bytes = normalizeBytes(input.bytes);
  if (bytes === null) return unavailable('invalid_metadata');
  if (
    input.kind !== 'image' &&
    input.kind !== 'document' &&
    input.kind !== 'text'
  ) {
    return unavailable('unsupported_kind');
  }

  if (input.kind === 'image') {
    if (bytes > BigInt(CHAT_ATTACHMENT_IMAGE_MAX_BYTES)) {
      return unavailable('image_too_large');
    }
    return {
      llmUsable: true,
      llmUnavailableReason: null,
      reservedDownloadBytes: Number(bytes),
      reservedMemoryBytes:
        Number(bytes) * CHAT_ATTACHMENT_MEMORY_RESERVATION_MULTIPLIER,
      // 原始对象必须同时受持久化元数据约束。若远端对象被覆盖、实际流大于
      // DB bytes，读取侧会 fail-closed，不能用 1B reservation 缓冲 5MiB。
      maxDownloadBytes: Number(bytes),
      target: 'original',
    };
  }

  if (input.hasExtractedText) {
    return {
      llmUsable: true,
      llmUnavailableReason: null,
      reservedDownloadBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES,
      reservedMemoryBytes:
        CHAT_ATTACHMENT_TEXT_MAX_BYTES *
        CHAT_ATTACHMENT_MEMORY_RESERVATION_MULTIPLIER,
      maxDownloadBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES,
      target: 'extracted',
    };
  }

  if (input.kind === 'text') {
    if (bytes > BigInt(CHAT_ATTACHMENT_TEXT_MAX_BYTES)) {
      return unavailable('text_too_large');
    }
    return {
      llmUsable: true,
      llmUnavailableReason: null,
      reservedDownloadBytes: Number(bytes),
      reservedMemoryBytes:
        Number(bytes) * CHAT_ATTACHMENT_MEMORY_RESERVATION_MULTIPLIER,
      maxDownloadBytes: Number(bytes),
      target: 'original',
    };
  }

  if (input.kind === 'document') {
    return unavailable('extracted_text_unavailable');
  }
  return unavailable('unsupported_kind');
}
