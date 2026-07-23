// 文档翻译 API 层纯件单测：报价、glossary/语言码清洗、序列化剥敏感列。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/translate/taskStorage', () => ({ deleteTaskFiles: vi.fn() }));

import {
  quoteCents,
  sanitizeGlossary,
  sanitizeLangCode,
  toTaskView,
} from '@/lib/translate/taskApi';

describe('quoteCents', () => {
  it('页数 × 单价，四舍五入非负', () => {
    expect(quoteCents(12, 10)).toBe(120);
    expect(quoteCents(1, 0)).toBe(0); // 免费站点
    expect(quoteCents(3, -5)).toBe(0); // 负单价防御
  });
});

describe('sanitizeGlossary', () => {
  it('保留合法条目，丢掉超长/缺字段/非对象', () => {
    const result = sanitizeGlossary([
      { src: 'transformer', dst: '变换器' },
      { src: '', dst: 'x' }, // 空 src 丢
      { src: 'a'.repeat(101), dst: 'b' }, // 超长丢
      'not-an-object',
      { src: 'attention', dst: '注意力' },
    ]);
    expect(result).toEqual([
      { src: 'transformer', dst: '变换器' },
      { src: 'attention', dst: '注意力' },
    ]);
  });

  it('非数组 / 全非法 → null（不用术语表）', () => {
    expect(sanitizeGlossary('x')).toBeNull();
    expect(sanitizeGlossary([{ src: '', dst: '' }])).toBeNull();
  });

  it('上限 500 条截断', () => {
    const big = Array.from({ length: 600 }, (_, i) => ({ src: `s${i}`, dst: `d${i}` }));
    expect(sanitizeGlossary(big)).toHaveLength(500);
  });
});

describe('sanitizeLangCode', () => {
  it('合法代码通过，非法回落 fallback', () => {
    expect(sanitizeLangCode('zh', 'en')).toBe('zh');
    expect(sanitizeLangCode('zh-TW', 'en')).toBe('zh-TW');
    expect(sanitizeLangCode('../../etc', 'en')).toBe('en'); // 注入形态拒绝
    expect(sanitizeLangCode(123, 'en')).toBe('en');
    expect(sanitizeLangCode('', 'en')).toBe('en');
  });
});

describe('toTaskView', () => {
  it('序列化剥掉内部列，refunded 由 refundedAt 派生', () => {
    const view = toTaskView({
      id: 't1',
      fileName: 'paper.pdf',
      fileBytes: 1024,
      pageCount: 12,
      status: 'FAILED',
      progress: 40,
      sourceLang: 'en',
      targetLang: 'zh',
      estimatedCents: 120,
      chargedCents: 120,
      refundedAt: new Date('2026-07-22T00:00:00Z'),
      monoPath: null,
      dualPath: null,
      errorMessage: 'worker 翻译失败',
      createdAt: new Date('2026-07-22T00:00:00Z'),
      completedAt: null,
    });
    expect(view.refunded).toBe(true);
    expect(view.hasMono).toBe(false);
    expect(view).not.toHaveProperty('proxyTokenHash');
    expect(view).not.toHaveProperty('workerId');
  });
});
