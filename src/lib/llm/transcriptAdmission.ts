import type { TranscriptSegment } from '@/lib/llm/chatContextBuilder';
import {
  BoundedBodyError,
  readJsonBodyBounded,
} from '@/lib/boundedBody';

/** 真实多小时录音远低于这些边界；它们用于在 tokenizer/chunker 前关闭失败。 */
export const CHAT_TRANSCRIPT_MAX_SEGMENTS = 100_000;
export const CHAT_TRANSCRIPT_MAX_SEGMENT_UTF8_BYTES = 64 * 1024;
export const CHAT_TRANSCRIPT_MAX_SEGMENT_TOKENS = 16_384;
export const CHAT_TRANSCRIPT_MAX_TOTAL_UTF8_BYTES = 2 * 1024 * 1024;
export const CHAT_TRANSCRIPT_MAX_TOTAL_TOKENS = 500_000;
/** 4 x 5MiB decoded images (base64), transcript, and JSON framing. */
export const CHAT_REQUEST_MAX_UTF8_BYTES = 32 * 1024 * 1024;

export class TranscriptAdmissionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 = 413
  ) {
    super(message);
    this.name = 'TranscriptAdmissionError';
  }
}

export async function readBoundedChatRequestJson(
  req: Request
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await readJsonBodyBounded(req, CHAT_REQUEST_MAX_UTF8_BYTES);
  } catch (error) {
    if (error instanceof BoundedBodyError) {
      throw new TranscriptAdmissionError(
        error.code === 'too_large'
          ? 'Chat request body is too large'
          : 'Invalid chat request body',
        error.code === 'too_large' ? 413 : 400
      );
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TranscriptAdmissionError('Invalid chat request body', 400);
  }
  return parsed as Record<string, unknown>;
}

interface TranscriptSegmentInput {
  text?: unknown;
  startMs?: unknown;
  globalStartMs?: unknown;
}

export class TranscriptAdmissionAccumulator {
  private readonly encoder = new TextEncoder();
  private readonly out: TranscriptSegment[] = [];
  private totalUtf8Bytes = 0;
  private totalTokenUpperBound = 0;

  constructor(declaredSegments = 0) {
    if (declaredSegments > CHAT_TRANSCRIPT_MAX_SEGMENTS) {
      throw new TranscriptAdmissionError('Too many transcript segments');
    }
  }

  add(text: string, startMs: number): void {
    if (!text) return;
    if (this.out.length >= CHAT_TRANSCRIPT_MAX_SEGMENTS) {
      throw new TranscriptAdmissionError('Too many transcript segments');
    }

    // UTF-16 code-unit 数绝不会大于同内容的 UTF-8 字节上限；先用这个零分配
    // 快速门禁挡住 32MiB 首段，再为边界内文本做精确 TextEncoder 计数。
    if (text.length > CHAT_TRANSCRIPT_MAX_SEGMENT_UTF8_BYTES) {
      throw new TranscriptAdmissionError('Transcript segment is too large');
    }
    const segmentBytes = this.encoder.encode(text).byteLength;
    if (segmentBytes > CHAT_TRANSCRIPT_MAX_SEGMENT_UTF8_BYTES) {
      throw new TranscriptAdmissionError('Transcript segment is too large');
    }
    // cl100k 是 byte-BPE：每个 token 至少消费一个 UTF-8 byte，因此 byte 数是
    // token 数的确定上界。这里刻意不用同步 tokenizer；高度可压缩的长重复串
    // 会让 gpt-tokenizer 单段耗时数秒，成为 admission 自身的 CPU DoS。
    if (segmentBytes > CHAT_TRANSCRIPT_MAX_SEGMENT_TOKENS) {
      throw new TranscriptAdmissionError(
        'Transcript segment token limit exceeded'
      );
    }

    const separatorBytes = this.out.length > 0 ? 1 : 0;
    if (
      this.totalUtf8Bytes + separatorBytes + segmentBytes >
      CHAT_TRANSCRIPT_MAX_TOTAL_UTF8_BYTES
    ) {
      throw new TranscriptAdmissionError('Transcript total size exceeded');
    }
    if (
      this.totalTokenUpperBound + separatorBytes + segmentBytes >
      CHAT_TRANSCRIPT_MAX_TOTAL_TOKENS
    ) {
      throw new TranscriptAdmissionError(
        'Transcript total token limit exceeded'
      );
    }
    this.totalUtf8Bytes += separatorBytes + segmentBytes;
    this.totalTokenUpperBound += separatorBytes + segmentBytes;
    this.out.push({ text, startMs: Number.isFinite(startMs) ? startMs : 0 });
  }

  finish(): TranscriptSegment[] {
    return [...this.out];
  }
}

/**
 * 在任何 segment 被加入 RAG/context 数组前执行单段与聚合双界。
 * 越界明确拒绝，不能把首个巨段完整 push 后再靠总量 break 静默带入。
 */
export function admitTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const accumulator = new TranscriptAdmissionAccumulator(value.length);

  for (const raw of value as TranscriptSegmentInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text) continue;

    const startCandidate =
      typeof raw.startMs === 'number'
        ? raw.startMs
        : typeof raw.globalStartMs === 'number'
          ? raw.globalStartMs
          : 0;
    accumulator.add(text, startCandidate);
  }
  return accumulator.finish();
}
