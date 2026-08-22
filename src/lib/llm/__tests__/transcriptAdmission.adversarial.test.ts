import { describe, expect, it } from 'vitest';

import {
  admitTranscriptSegments,
  TranscriptAdmissionError,
} from '@/lib/llm/transcriptAdmission';

describe('transcript admission adversarial token boundary', () => {
  it('高熵非 CJK Unicode 不能借超长启发式穿透聚合 token 上限', () => {
    // 每段 16,384 UTF-8 bytes 且 cl100k 恰为 16,384 tokens；31 段的
    // 总字节仍远低于 2MiB，但真实 token 已超过 500k。旧 chars/3.5
    // 启发式只估约 72k，因而会错误放行。
    const piece = '𐍈'.repeat(4096);
    const input = Array.from({ length: 31 }, (_, index) => ({
      text: piece,
      startMs: index,
    }));

    expect(() => admitTranscriptSegments(input)).toThrowError(
      TranscriptAdmissionError
    );
    expect(() => admitTranscriptSegments(input)).toThrow(
      'Transcript total token limit exceeded'
    );
  });
});
