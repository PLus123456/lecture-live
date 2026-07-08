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

  describe('双向同传 setLanguagePair — per-direction 目标语言', () => {
    // 语言对 A=en / B=zh。验证 R5 修复：waiting 指示器在两个方向都生效，
    // 且 passthrough 判定对两个方向都正确（干净的 A↔B 段永不 passthrough）。

    it('A→B 段（原文 en）目标为 langB(zh)：显示 waiting，收到真实 zh 译文后落地', () => {
      const previewTranslations: StreamingPreviewTranslation[] = [];
      const translationUpdates: Array<{
        text: string;
        segmentId: string;
        state?: string;
        sourceLanguage?: string | null;
      }> = [];
      const processor = new TokenProcessor({
        onPreviewTranslationUpdate: (preview) => previewTranslations.push(preview),
        onTranslationToken: (text, segmentId, meta) =>
          translationUpdates.push({
            text,
            segmentId,
            state: meta?.state,
            sourceLanguage: meta?.sourceLanguage,
          }),
      });
      processor.setLanguagePair('en', 'zh');

      // en 原文进入 → 目标 zh，尚无译文 → waiting
      processor.processTokens([
        buildToken('Hello', { language: 'en', start_ms: 0, end_ms: 300 }),
      ]);
      expect(previewTranslations.at(-1)).toMatchObject({
        state: 'waiting',
        sourceLanguage: 'en',
      });

      // 收到真实 zh 译文（跨语，非 passthrough）
      processor.processTokens([
        buildToken('你好', {
          is_final: true,
          translation_status: 'translation',
          source_language: 'en',
        }),
      ]);
      processor.onEndpoint();

      // 该段最终译文为真实 zh 文本，不是原文 passthrough
      const finalUpdate = translationUpdates.at(-1);
      expect(finalUpdate).toMatchObject({ text: '你好', sourceLanguage: 'en' });
      // passthrough 会把原文 'Hello' 当译文；这里绝不能出现
      expect(translationUpdates.some((u) => u.text === 'Hello')).toBe(false);
    });

    it('B→A 段（原文 zh）目标为 langA(en)：显示 waiting，收到真实 en 译文后落地（不被误判 passthrough）', () => {
      const previewTranslations: StreamingPreviewTranslation[] = [];
      const translationUpdates: Array<{
        text: string;
        segmentId: string;
        state?: string;
        sourceLanguage?: string | null;
      }> = [];
      const processor = new TokenProcessor({
        onPreviewTranslationUpdate: (preview) => previewTranslations.push(preview),
        onTranslationToken: (text, segmentId, meta) =>
          translationUpdates.push({
            text,
            segmentId,
            state: meta?.state,
            sourceLanguage: meta?.sourceLanguage,
          }),
      });
      processor.setLanguagePair('en', 'zh');

      // zh 原文进入 → 目标 en，尚无译文 → waiting（旧固定 targetLang=zh 会误判为
      // passthrough，导致这里没有 waiting，B→A 方向回归破坏）
      processor.processTokens([
        buildToken('你好', { language: 'zh', start_ms: 0, end_ms: 300 }),
      ]);
      expect(previewTranslations.at(-1)).toMatchObject({
        state: 'waiting',
        sourceLanguage: 'zh',
      });

      // 收到真实 en 译文
      processor.processTokens([
        buildToken('Hello', {
          is_final: true,
          translation_status: 'translation',
          source_language: 'zh',
        }),
      ]);
      processor.onEndpoint();

      const finalUpdate = translationUpdates.at(-1);
      expect(finalUpdate).toMatchObject({ text: 'Hello', sourceLanguage: 'zh' });
      // 绝不能把 zh 原文 '你好' 当作译文（passthrough 回归）
      expect(translationUpdates.some((u) => u.text === '你好')).toBe(false);
    });

    it('单向 setTargetLang 语义不受影响：原文已是目标语言时仍走 passthrough', () => {
      const translations = new Map<string, string>();
      const processor = new TokenProcessor({
        onTranslationToken: (text, segmentId) => translations.set(segmentId, text),
      });
      // 单向：目标 en，原文也是 en → passthrough（沿用旧行为，不能被 pair 改动波及）
      processor.setTargetLang('en');
      processor.processTokens([
        buildToken('Already English.', {
          is_final: true,
          language: 'en',
          start_ms: 0,
          end_ms: 300,
        }),
      ]);
      processor.onEndpoint();
      expect([...translations.values()]).toContain('Already English.');
    });
  });

  it('多个实例各自独立计数 segment id，互不串号', () => {
    const segmentsA: TranscriptSegment[] = [];
    const segmentsB: TranscriptSegment[] = [];
    const processorA = new TokenProcessor({
      onSegmentFinalized: (segment) => segmentsA.push(segment),
    });
    const processorB = new TokenProcessor({
      onSegmentFinalized: (segment) => segmentsB.push(segment),
    });

    processorA.processTokens([
      buildToken('你好', { is_final: true, start_ms: 0, end_ms: 300 }),
    ]);
    processorA.onEndpoint();

    processorB.processTokens([
      buildToken('世界', { is_final: true, start_ms: 0, end_ms: 300 }),
    ]);
    processorB.onEndpoint();

    expect(segmentsA).toHaveLength(1);
    expect(segmentsB).toHaveLength(1);
    // 两个实例都应从 seg-1 起算；若仍是模块级全局变量，processorB 会串到 seg-2
    expect(segmentsA[0]?.id).toBe('seg-1');
    expect(segmentsB[0]?.id).toBe('seg-1');
  });
});
