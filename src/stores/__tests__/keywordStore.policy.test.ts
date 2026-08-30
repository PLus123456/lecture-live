import { beforeEach, describe, expect, it } from 'vitest';
import { parseExistingKeywordText, serializeExistingKeywordItems } from '@/lib/llm/keywordPolicy';
import { useKeywordStore } from '@/stores/keywordStore';
import type { KeywordEntry } from '@/types/llm';

function entries(texts: string[]): KeywordEntry[] {
  return texts.map((text) => ({ text, source: 'llm', active: true }));
}

describe('keywordStore shared prompt boundary', () => {
  beforeEach(() => {
    useKeywordStore.getState().clearAll();
  });

  it('正常累计到 200 项后仍能序列化发起提取，超出项明确返回 rejected', () => {
    const first = useKeywordStore
      .getState()
      .addKeywords(entries(Array.from({ length: 199 }, (_, index) => `term-${index}`)));
    expect(first.added).toHaveLength(199);

    const boundary = useKeywordStore
      .getState()
      .addKeywords(entries(['term-199', 'term-200', 'term-201']));
    expect(boundary.added.map((entry) => entry.text)).toEqual(['term-199']);
    expect(boundary.rejected).toBe(2);
    expect(boundary.reasons).toContain('too_many');
    expect(useKeywordStore.getState().keywords).toHaveLength(200);

    const serialized = serializeExistingKeywordItems(
      useKeywordStore.getState().keywords.map((entry) => entry.text)
    );
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseExistingKeywordText(serialized.serialized)).toMatchObject({
      ok: true,
      keywords: expect.any(Array),
    });

    const nextAttempt = useKeywordStore
      .getState()
      .addKeywords(entries(['term-202']));
    expect(nextAttempt).toMatchObject({ added: [], rejected: 1 });
  });

  it('词内分隔符不会让客户端与服务端条数语义分裂', () => {
    const addition = useKeywordStore
      .getState()
      .addKeywords(entries(['Paris, France; Île-de-France']));
    expect(addition.added).toHaveLength(1);

    const serialized = serializeExistingKeywordItems(
      useKeywordStore.getState().keywords.map((entry) => entry.text)
    );
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseExistingKeywordText(serialized.serialized)).toEqual({
      ok: true,
      keywords: ['Paris, France; Île-de-France'],
    });
  });
});
