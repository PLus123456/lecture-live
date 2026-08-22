import { describe, expect, it } from 'vitest';

import {
  admitTranscriptSegments,
  CHAT_TRANSCRIPT_MAX_SEGMENT_TOKENS,
  CHAT_TRANSCRIPT_MAX_SEGMENT_UTF8_BYTES,
  CHAT_TRANSCRIPT_MAX_TOTAL_TOKENS,
  TranscriptAdmissionAccumulator,
  TranscriptAdmissionError,
} from '@/lib/llm/transcriptAdmission';

describe('transcript admission', () => {
  it('首个超长段在进入输出数组前立即拒绝', () => {
    expect(() =>
      admitTranscriptSegments([
        {
          text: 'x'.repeat(CHAT_TRANSCRIPT_MAX_SEGMENT_UTF8_BYTES + 1),
          startMs: 0,
        },
      ])
    ).toThrowError(TranscriptAdmissionError);
  });

  it('UTF-16 字符数在界内但 UTF-8 字节超界仍拒绝', () => {
    const text = '🙂'.repeat(
      Math.floor(CHAT_TRANSCRIPT_MAX_SEGMENT_UTF8_BYTES / 4) + 1
    );
    expect(text.length).toBeLessThan(CHAT_TRANSCRIPT_MAX_SEGMENT_UTF8_BYTES);
    expect(() => admitTranscriptSegments([{ text, startMs: 0 }])).toThrow(
      'Transcript segment is too large'
    );
  });

  it('单段 token 超界时不进入 RAG', () => {
    const text = 'x'.repeat(CHAT_TRANSCRIPT_MAX_SEGMENT_TOKENS + 1);
    expect(() => admitTranscriptSegments([{ text, startMs: 0 }])).toThrow(
      'Transcript segment token limit exceeded'
    );
  });

  it('多个合法单段的聚合 token 超界时整批拒绝', () => {
    const accumulator = new TranscriptAdmissionAccumulator();
    const piece = 'x'.repeat(10_000);
    expect(() => {
      for (
        let i = 0;
        i < Math.floor(CHAT_TRANSCRIPT_MAX_TOTAL_TOKENS / 10_000);
        i++
      ) {
        accumulator.add(piece, i);
      }
      accumulator.add('x', 999_999);
      accumulator.finish();
    }).toThrow(
      'Transcript total token limit exceeded'
    );
  });

  it('正常多段保留顺序、startMs 与 globalStartMs 兼容语义', () => {
    expect(
      admitTranscriptSegments([
        { text: 'first', startMs: 10 },
        { text: 'second', globalStartMs: 20 },
        { text: '', startMs: 30 },
      ])
    ).toEqual([
      { text: 'first', startMs: 10 },
      { text: 'second', startMs: 20 },
    ]);
  });
});
