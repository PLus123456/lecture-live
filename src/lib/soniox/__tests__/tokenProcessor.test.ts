import { describe, expect, it } from 'vitest';
import { TokenProcessor } from '@/lib/soniox/tokenProcessor';
import type { RealtimeToken } from '@/types/soniox';
import type {
  StreamingPreviewText,
  StreamingPreviewTranslation,
  TranscriptSegment,
} from '@/types/transcript';

function buildToken(
  text: string,
  overrides: Partial<RealtimeToken> = {}
): RealtimeToken {
  return {
    text,
    confidence: 1,
    is_final: false,
    start_ms: 0,
    end_ms: 0,
    language: 'zh',
    ...overrides,
  };
}

describe('TokenProcessor', () => {
  it('会用最新 non-final 原文覆盖旧尾巴，而不是追加', () => {
    const previews: StreamingPreviewText[] = [];
    const segments: TranscriptSegment[] = [];
    const processor = new TokenProcessor({
      onPreviewUpdate: (preview) => {
        previews.push(preview);
      },
      onSegmentFinalized: (segment) => {
        segments.push(segment);
      },
    });

    processor.processTokens([
      buildToken('你', { is_final: true, start_ms: 0, end_ms: 120 }),
      buildToken('好', { start_ms: 120, end_ms: 240 }),
    ]);

    expect(previews.at(-1)).toEqual({
      finalText: '你',
      nonFinalText: '好',
    });

    processor.processTokens([
      buildToken('们', { start_ms: 120, end_ms: 280 }),
    ]);

    expect(previews.at(-1)).toEqual({
      finalText: '你',
      nonFinalText: '们',
    });

    processor.onEndpoint();

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('你们');
  });

  it('会显示翻译等待态，并用最新 non-final 翻译覆盖旧值', () => {
    const previewTranslations: StreamingPreviewTranslation[] = [];
    const translationUpdates: Array<{
      text: string;
      segmentId: string;
      state?: string;
      sourceLanguage?: string | null;
    }> = [];
    const processor = new TokenProcessor({
      onPreviewTranslationUpdate: (preview) => {
        previewTranslations.push(preview);
      },
      onTranslationToken: (text, segmentId, meta) => {
        translationUpdates.push({
          text,
          segmentId,
          state: meta?.state,
          sourceLanguage: meta?.sourceLanguage,
        });
      },
    });
    processor.setTargetLang('en');

    processor.processTokens([
      buildToken('你好', { language: 'zh', start_ms: 0, end_ms: 300 }),
    ]);

    expect(previewTranslations.at(-1)).toMatchObject({
      finalText: '',
      nonFinalText: '',
      state: 'waiting',
      sourceLanguage: 'zh',
    });

    processor.processTokens([
      buildToken('hel', {
        translation_status: 'translation',
        source_language: 'zh',
      }),
    ]);

    expect(previewTranslations.at(-1)).toMatchObject({
      finalText: '',
      nonFinalText: 'hel',
      state: 'streaming',
      sourceLanguage: 'zh',
    });

    processor.processTokens([
      buildToken('hello', {
        translation_status: 'translation',
        source_language: 'zh',
      }),
    ]);

    expect(previewTranslations.at(-1)).toMatchObject({
      finalText: '',
      nonFinalText: 'hello',
      state: 'streaming',
    });

    processor.onEndpoint();

    const pendingUpdate = translationUpdates.at(-1);
    expect(pendingUpdate).toMatchObject({
      text: '',
      state: 'pending',
      sourceLanguage: 'zh',
    });

    processor.processTokens([
      buildToken('hello', {
        is_final: true,
        translation_status: 'translation',
        source_language: 'zh',
      }),
    ]);

    expect(translationUpdates.at(-1)).toMatchObject({
      text: 'hello',
      segmentId: pendingUpdate?.segmentId,
      state: 'final',
      sourceLanguage: 'zh',
    });
  });
});
