import { describe, expect, it } from 'vitest';
import {
  parseExistingKeywordText,
  serializeExistingKeywordItems,
  validateExistingKeywordItems,
} from '@/lib/llm/keywordPolicy';

describe('existing keyword shared policy', () => {
  it('新客户端 JSON round-trip 保留词内逗号/分号，200 项在服务端仍是 200 项', () => {
    const keywords = Array.from(
      { length: 200 },
      (_, index) => `Paris, France; region ${index}`
    );

    const serialized = serializeExistingKeywordItems(keywords);

    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const parsed = parseExistingKeywordText(serialized.serialized);
    expect(parsed).toEqual({ ok: true, keywords });
  });

  it('旧 CSV 协议仍可用，但计数在去重前完成', () => {
    expect(parseExistingKeywordText('alpha, beta')).toEqual({
      ok: true,
      keywords: ['alpha', 'beta'],
    });
    expect(
      parseExistingKeywordText(
        Array.from({ length: 201 }, () => 'duplicate').join(',')
      )
    ).toEqual({ ok: false, reason: 'too_many' });
  });

  it('客户端与服务端使用同一单项边界', () => {
    expect(validateExistingKeywordItems(['x'.repeat(121)])).toEqual({
      ok: false,
      reason: 'item_too_long',
    });
  });
});
