import { describe, expect, it } from 'vitest';
import {
  isStorageCategoryValue,
  normalizeExportFormat,
  normalizeLanguageCode,
  normalizeOptionalString,
  normalizeSessionAudioSource,
  normalizeSessionRegion,
  validatePersistedTranscriptBundle,
} from '@/lib/sessionApi';

describe('session api helpers', () => {
  it('规范化音频源、区域和语言', () => {
    expect(normalizeSessionAudioSource('mic')).toBe('microphone');
    expect(normalizeSessionAudioSource('system_audio')).toBe('system_audio');
    expect(normalizeSessionRegion('EU')).toBe('eu');
    // 'zh-cn' 不在有效语言列表中（列表使用 ISO 639-1: 'zh'），回退到 fallback
    expect(normalizeLanguageCode('  ZH-CN  ', 'en')).toBe('en');
    expect(normalizeLanguageCode('  ZH  ', 'en')).toBe('zh');
    expect(normalizeLanguageCode('invalid-lang', 'en')).toBe('en');
    expect(normalizeSessionAudioSource({})).toBeNull();
    expect(normalizeSessionRegion(123)).toBeNull();
  });

  it('验证 transcript bundle 结构', () => {
    expect(
      validatePersistedTranscriptBundle({
        segments: [],
        summaries: [],
        translations: { a: 'b' },
      })
    ).toEqual({
      segments: [],
      summaries: [],
      translations: { a: 'b' },
    });

    expect(validatePersistedTranscriptBundle({ segments: [] })).toBeNull();
    expect(
      validatePersistedTranscriptBundle({
        segments: [],
        summaries: [],
        translations: { a: 1 },
      })
    ).toBeNull();
    expect(validatePersistedTranscriptBundle(null)).toBeNull();
  });

  it('规范化导出格式', () => {
    expect(normalizeExportFormat('markdown')).toBe('markdown');
    expect(normalizeExportFormat('pdf')).toBeNull();
    expect(normalizeExportFormat(123)).toBeNull();
  });

  it('处理可选字符串和存储分类判断', () => {
    expect(normalizeOptionalString('  title  ', 4)).toBe('titl');
    expect(normalizeOptionalString('   ', 10)).toBeNull();
    expect(normalizeOptionalString(42, 10)).toBeNull();
    expect(isStorageCategoryValue('recordings')).toBe(true);
    expect(isStorageCategoryValue('reports')).toBe(false);
  });
});
