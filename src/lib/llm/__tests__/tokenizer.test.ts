/**
 * P4-2：estimateTokens 对超长输入必须短路成便宜估算。
 *
 * encode() 是同步 CPU（60K 字符 ≈ 5ms，线性外推 32MB ≈ 2.6 秒），extract-keywords 会对整份
 * 输入 encode 一次、chunkText 再对每个句子各 encode 一次——**在任何 LLM 调用之前**就把事件
 * 循环钉死。这里用桩 encode 计数锁住「超长输入不进 BPE」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { encodeMock } = vi.hoisted(() => ({ encodeMock: vi.fn() }));

vi.mock('gpt-tokenizer', () => ({ encode: encodeMock }));

import {
  estimateTokens,
  isWithinTokens,
  truncateToTokensFromEnd,
  truncateToTokensFromEndUtf8ByteUpperBound,
} from '@/lib/llm/tokenizer';

describe('estimateTokens 超长输入短路', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 桩：按 4 字符/token 返回等长数组（只用长度）。
    encodeMock.mockImplementation((text: string) =>
      new Array(Math.ceil(text.length / 4)).fill(0)
    );
  });

  it('常规长度仍走真 BPE encode（精度不退化）', () => {
    expect(estimateTokens('a'.repeat(1000))).toBe(250);
    expect(encodeMock).toHaveBeenCalledTimes(1);
  });

  it('超过 20 万字符时不再 encode（同步 CPU 不被钉死）', () => {
    const huge = 'a'.repeat(400_000);
    const tokens = estimateTokens(huge);
    expect(encodeMock).not.toHaveBeenCalled();
    expect(tokens).toBeGreaterThan(0);
  });

  it('便宜估算对 CJK 是高估而非低估（chars/4 会严重低估中文）', () => {
    const cjk = '一'.repeat(300_000);
    const tokens = estimateTokens(cjk);
    expect(encodeMock).not.toHaveBeenCalled();
    // cl100k 下一个汉字通常 1-2 token；估算必须 ≥ 字符数，低估会把真超限的内容送进模型。
    expect(tokens).toBeGreaterThanOrEqual(cjk.length);
  });

  it('isWithinTokens 对超长输入也不 encode', () => {
    expect(isWithinTokens('a'.repeat(400_000), 1000)).toBe(false);
    expect(encodeMock).not.toHaveBeenCalled();
  });

  it('truncateToTokensFromEnd 的 encode 工作量随 maxTokens 而非输入长度增长', () => {
    const huge = 'a'.repeat(2_000_000);
    truncateToTokensFromEnd(huge, 1000);
    expect(encodeMock).toHaveBeenCalledTimes(1);
    // 旧实现把整份 200 万字符喂进 encode；新实现先粗切尾部再 encode。
    const encoded = encodeMock.mock.calls[0][0] as string;
    expect(encoded.length).toBeLessThan(huge.length);
    expect(encoded.length).toBeLessThanOrEqual(200_000);
  });

  it('高度可压缩的 20 万字符 suffix 也被 UTF-8 预留上界完整覆盖', () => {
    encodeMock.mockImplementationOnce(() => new Array(1563).fill(0));
    const compressed = ' '.repeat(200_000);
    const truncated = truncateToTokensFromEnd(compressed, 2000);

    expect(truncated).toBe(compressed);
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(
      truncateToTokensFromEndUtf8ByteUpperBound(2000)
    );
    // 旧的 inputBudget*32 只预留 64,000，无法覆盖该反例。
    expect(truncateToTokensFromEndUtf8ByteUpperBound(2000)).toBe(800_000);
  });
});
