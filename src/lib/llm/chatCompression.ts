const COMPRESSION_MARKER_RE =
  /^<!-- lecture-live:compressed-through=([A-Za-z0-9_-]+) -->\n?/;

export interface CompressionBoundaryMessage {
  id: string;
  role: string;
  content: string;
}

export function encodeCompressedHistorySystemMessage(
  summary: string,
  compressedThroughMessageId: string | null
): string {
  const cleanSummary = summary.trim();
  if (!compressedThroughMessageId) {
    return cleanSummary;
  }
  return `<!-- lecture-live:compressed-through=${compressedThroughMessageId} -->\n${cleanSummary}`;
}

export function parseCompressedHistorySystemMessage(content: string): {
  summary: string;
  compressedThroughMessageId: string | null;
} {
  const match = content.match(COMPRESSION_MARKER_RE);
  if (!match) {
    return { summary: content, compressedThroughMessageId: null };
  }

  return {
    summary: content.replace(COMPRESSION_MARKER_RE, '').trim(),
    compressedThroughMessageId: match[1],
  };
}

/**
 * 找最近一条压缩 system 消息对应的切割点。
 *
 * 新格式用 compressed-through 标记指向“已压缩到哪条消息”，不依赖 system
 * 消息在 createdAt 排序里的物理位置；旧格式没有标记时沿用“system 之后有效”。
 */
export function findCompressionBoundary(
  messages: ReadonlyArray<CompressionBoundaryMessage>
): {
  systemIndex: number;
  splitIndex: number;
  summary: string | null;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'system') {
      continue;
    }

    const parsed = parseCompressedHistorySystemMessage(message.content);
    if (parsed.compressedThroughMessageId) {
      const markerIndex = messages.findIndex(
        (item) => item.id === parsed.compressedThroughMessageId
      );
      return {
        systemIndex: i,
        splitIndex: markerIndex >= 0 ? markerIndex : i,
        summary: parsed.summary,
      };
    }

    return {
      systemIndex: i,
      splitIndex: i,
      summary: parsed.summary,
    };
  }

  return { systemIndex: -1, splitIndex: -1, summary: null };
}
