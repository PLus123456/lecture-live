import { describe, expect, it, vi } from 'vitest';

// token 估算固定成「字符数」，让切块边界可预测。
vi.mock('@/lib/llm/tokenizer', () => ({
  estimateTokens: (text: string) => (text ? text.length : 0),
}));

import { chunkText, chunkTextWithMeta } from '@/lib/llm/chunking';

function sentences(count: number, len = 40): string {
  return Array.from({ length: count }, (_, i) =>
    `${String(i).padStart(3, '0')}${'x'.repeat(len - 4)}。`
  ).join('');
}

describe('chunkTextWithMeta（M17 触顶截断必须可见）', () => {
  it('未触顶：truncated=false 且覆盖全文', () => {
    const text = sentences(10);
    const result = chunkTextWithMeta(text, {
      chunkTargetTokens: 100,
      maxChunks: 500,
    });

    expect(result.truncated).toBe(false);
    expect(result.totalChars).toBe(text.length);
    expect(result.consumedChars).toBe(text.length);
  });

  it('触顶：truncated=true 且 consumedChars < totalChars（此前完全静默）', () => {
    const text = sentences(60);
    const result = chunkTextWithMeta(text, {
      chunkTargetTokens: 40,
      maxChunks: 5,
    });

    expect(result.chunks).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.consumedChars).toBeLessThan(result.totalChars);
    expect(result.totalChars).toBe(text.length);
  });

  it('超长单句被强切时撞上 maxChunks 也算触顶', () => {
    const giant = 'y'.repeat(5000);
    const result = chunkTextWithMeta(giant, {
      chunkTargetTokens: 100,
      maxChunks: 3,
    });

    expect(result.chunks).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.consumedChars).toBeLessThan(giant.length);
  });

  it('chunkText 仍返回纯数组（既有调用方不受影响）', () => {
    const text = sentences(6);
    expect(chunkText(text, { chunkTargetTokens: 100 })).toEqual(
      chunkTextWithMeta(text, { chunkTargetTokens: 100 }).chunks
    );
  });
});

describe('chunkText（L43 overlap 与超长句共存）', () => {
  /**
   * 不变量：每个 chunk 的 text 必须等于原文 [charStart, charEnd) 的切片。
   * 旧实现里 overlap 的"引子"在遇到超长句强切后**没被清掉**，会被拼到超长句之后
   * 那一块的开头，而 charStart 已被改成超长句之后的位置 —— 文本与坐标错位。
   */
  it('每个 chunk 的 text 与 charStart/charEnd 严格对应', () => {
    const text = `${sentences(4, 30)}${'z'.repeat(1200)}。${sentences(4, 30)}`;
    const chunks = chunkText(text, {
      chunkTargetTokens: 100,
      chunkMaxTokens: 125,
      overlapTokens: 20,
    });

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.charStart, chunk.charEnd));
    }
  });

  it('overlap=0 时同样保持坐标一致（回归保护）', () => {
    const text = `${sentences(4, 30)}${'z'.repeat(1200)}。${sentences(4, 30)}`;
    const chunks = chunkText(text, {
      chunkTargetTokens: 100,
      chunkMaxTokens: 125,
    });
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.charStart, chunk.charEnd));
    }
  });
});
