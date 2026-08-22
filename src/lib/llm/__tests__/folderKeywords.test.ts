import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { parseExtractedKeywords } from '@/lib/llm/folderKeywords';

/**
 * L35：关键词抽取此前只 try/catch 了 JSON.parse，之后完全信任 LLM 返回的形状：
 *  - 返回 JSON 对象（非数组）→ `for...of` 抛未捕获 TypeError；
 *  - 元素不是对象 / keyword 非字符串 → normalizeKeyword 的 .trim() 抛 TypeError；
 *  - confidence 是字符串 → `"high" || 0` 得 "high" → Math.min/max 产出 NaN
 *    → Prisma 写入抛错，而且发生在**循环中途**（前面已写库、后面全丢）。
 * 同目录 security.ts 早有完整的 toStringArray / toBoundedNumber 防御，这里补齐同等口径。
 */
describe('parseExtractedKeywords（L35 LLM 返回体形状校验）', () => {
  it('正常数组照常解析', () => {
    const out = parseExtractedKeywords(
      JSON.stringify([
        { keyword: '梯度下降', confidence: 0.9 },
        { keyword: 'BPE', confidence: 0.4 },
      ])
    );
    expect(out).toEqual([
      { keyword: '梯度下降', confidence: 0.9 },
      { keyword: 'BPE', confidence: 0.4 },
    ]);
  });

  it('返回 JSON 对象而非数组 → 空数组，不抛错', () => {
    expect(() =>
      parseExtractedKeywords('{"keywords":[{"keyword":"x","confidence":1}]}')
    ).not.toThrow();
    expect(
      parseExtractedKeywords('{"keywords":[{"keyword":"x","confidence":1}]}')
    ).toEqual([]);
  });

  it('非法 JSON → 空数组，不抛错', () => {
    expect(parseExtractedKeywords('not json at all')).toEqual([]);
  });

  it('元素不是对象 / keyword 非字符串 → 跳过而不是抛 TypeError', () => {
    const out = parseExtractedKeywords(
      JSON.stringify([
        'plain string',
        null,
        42,
        ['nested'],
        { keyword: 123, confidence: 0.5 },
        { confidence: 0.5 },
        { keyword: '   ', confidence: 0.5 },
        { keyword: 'ok', confidence: 0.5 },
      ])
    );
    expect(out).toEqual([{ keyword: 'ok', confidence: 0.5 }]);
  });

  it('confidence 非数值 → 归零，绝不产出 NaN（NaN 进 Prisma 会中途炸掉写入循环）', () => {
    const out = parseExtractedKeywords(
      JSON.stringify([
        { keyword: 'a', confidence: 'high' },
        { keyword: 'b', confidence: null },
        { keyword: 'c' },
        { keyword: 'd', confidence: '0.9' },
      ])
    );
    expect(out.map((k) => k.confidence)).toEqual([0, 0, 0, 0]);
    for (const k of out) {
      expect(Number.isNaN(k.confidence)).toBe(false);
    }
  });

  it('confidence 超界被夹回 [0,1]', () => {
    const out = parseExtractedKeywords(
      JSON.stringify([
        { keyword: 'a', confidence: 7 },
        { keyword: 'b', confidence: -3 },
        { keyword: 'c', confidence: Number.POSITIVE_INFINITY },
      ])
    );
    expect(out.map((k) => k.confidence)).toEqual([1, 0, 0]);
  });

  it('超长数组被截断（防写库循环被打爆）', () => {
    const raw = JSON.stringify(
      Array.from({ length: 500 }, (_, i) => ({
        keyword: `k${i}`,
        confidence: 0.5,
      }))
    );
    expect(parseExtractedKeywords(raw)).toHaveLength(200);
  });
});
