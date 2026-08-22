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
    // 旧实现把整份 200 万字符喂进 encode；新实现先粗切尾部再 encode。
    // 校正循环（L38①）可能多编码几次，但每次的输入都被粗切上界钉住。
    expect(encodeMock.mock.calls.length).toBeLessThanOrEqual(4);
    for (const [encoded] of encodeMock.mock.calls as Array<[string]>) {
      expect(encoded.length).toBeLessThan(huge.length);
      expect(encoded.length).toBeLessThanOrEqual(200_000);
    }
  });
});

/**
 * L38①：按字符比例反推截断点会在「尾部 token 密度高于全文」时**超出** maxTokens。
 * 这里用一个刻意非均匀的 encode 桩（CJK 2 token/字，ASCII 0.25 token/字）把这个
 * 场景固定下来：全文平均密度低，尾部是密集的 CJK。
 */
describe('truncateToTokensFromEnd 不得超出 maxTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    encodeMock.mockImplementation((text: string) => {
      let total = 0;
      for (const ch of text) {
        total += /[一-鿿]/.test(ch) ? 2 : 0.25;
      }
      return new Array(Math.ceil(total)).fill(0);
    });
  });

  it('尾部密度高于全文时，返回值的真实 token 数仍 ≤ maxTokens', () => {
    // 8000 个 'a'（2000 token）+ 200 个汉字（400 token）：全文 2400 token / 8200 字符。
    // 纯比例反推会保留最后 ~3417 字符 = 400 + 804 ≈ 1205 token，超出 1000。
    const text = 'a'.repeat(8000) + '一'.repeat(200);
    const out = truncateToTokensFromEnd(text, 1000);

    expect(encodeMock(out).length).toBeLessThanOrEqual(1000);
    // 也不能收得太狠（否则等于把预算白白浪费掉）
    expect(encodeMock(out).length).toBeGreaterThan(700);
    // 必须仍然是原文的尾巴
    expect(text.endsWith(out)).toBe(true);
  });
});
