import { describe, expect, it } from 'vitest';
import { getTranslation } from '@/lib/i18n';

describe('i18n translations', () => {
  it('returns localized values for the same key', () => {
    const en = getTranslation('en');
    const zh = getTranslation('zh');

    expect(en('session.share.start')).toBe('Start Live Share');
    expect(zh('session.share.start')).toBe('开始实时共享');
  });

  it('interpolates params in translated strings', () => {
    const en = getTranslation('en');
    const zh = getTranslation('zh');

    expect(en('session.notices.maxDurationReached', { duration: '01:00:00' })).toContain(
      '01:00:00'
    );
    expect(zh('session.backup.chunkProgress', { have: 3, total: 5 })).toBe('3/5 块');
  });

  it('falls back to the key when a translation is missing', () => {
    const en = getTranslation('en');

    expect(en('missing.translation.key')).toBe('missing.translation.key');
  });
});
