import { describe, expect, it } from 'vitest';
import { TokenProcessor } from '@/lib/soniox/tokenProcessor';
import type { RealtimeToken } from '@/types/soniox';
import type { TranscriptSegment } from '@/types/transcript';

function makeToken(token: Partial<RealtimeToken> & Pick<RealtimeToken, 'text'>): RealtimeToken {
  return {
    text: token.text,
    start_ms: token.start_ms ?? 0,
    end_ms: token.end_ms ?? token.start_ms ?? 0,
    confidence: token.confidence ?? 1,
    is_final: token.is_final ?? true,
    speaker: token.speaker,
    language: token.language,
    source_language: token.source_language,
    translation_status: token.translation_status,
  };
}

describe('TokenProcessor', () => {
  it('将晚到的翻译 token 回填到上一段，而不是串到下一段', () => {
    const segments: TranscriptSegment[] = [];
    const translations = new Map<string, string>();

    const processor = new TokenProcessor({
      onSegmentFinalized: (segment) => {
        segments.push(segment);
      },
      onTranslationToken: (text, segmentId) => {
        translations.set(segmentId, text);
      },
    });

    processor.setTargetLang('zh');
    processor.setMaxSegmentChars(5);

    processor.processTokens([
      makeToken({
        text: 'Hello.',
        start_ms: 0,
        end_ms: 1000,
        language: 'en',
        translation_status: 'original',
      }),
    ]);

    processor.processTokens([
      makeToken({
        text: 'Next.',
        start_ms: 1100,
        end_ms: 2000,
        language: 'en',
        translation_status: 'original',
      }),
      makeToken({
        text: '你好。',
        start_ms: 0,
        end_ms: 1000,
        language: 'zh',
        source_language: 'en',
        translation_status: 'translation',
      }),
    ]);

    processor.processTokens([
      makeToken({
        text: '下一句。',
        start_ms: 1100,
        end_ms: 2000,
        language: 'zh',
        source_language: 'en',
        translation_status: 'translation',
      }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.text).toBe('Hello.');
    expect(segments[1]?.text).toBe('Next.');
    expect(translations.get(segments[0]!.id)).toBe('你好。');
    expect(translations.get(segments[1]!.id)).toBe('下一句。');
  });

  it('目标语言与原文相同时先走 passthrough，后续若有真实翻译会覆盖', () => {
    const segments: TranscriptSegment[] = [];
    const translations = new Map<string, string>();

    const processor = new TokenProcessor({
      onSegmentFinalized: (segment) => {
        segments.push(segment);
      },
      onTranslationToken: (text, segmentId) => {
        translations.set(segmentId, text);
      },
    });

    processor.setTargetLang('en');
    processor.processTokens([
      makeToken({
        text: 'Already English.',
        start_ms: 0,
        end_ms: 1200,
        language: 'en',
        translation_status: 'original',
      }),
    ]);
    processor.onEndpoint();

    expect(segments).toHaveLength(1);
    expect(translations.get(segments[0]!.id)).toBe('Already English.');

    processor.processTokens([
      makeToken({
        text: 'Normalized English.',
        start_ms: 0,
        end_ms: 1200,
        language: 'en',
        source_language: 'en',
        translation_status: 'translation',
      }),
    ]);

    expect(translations.get(segments[0]!.id)).toBe('Normalized English.');
  });
});
