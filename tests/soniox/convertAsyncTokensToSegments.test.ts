/**
 * 单测 convertAsyncTokensToSegments —— 上传/完整版转录把 Soniox 文件 token 还原成分段的入口。
 *
 * 回归目标：文件路径拿不到 realtime 的 endpoint 事件，早期实现会把整段音频压成单个
 * segment（无分段、无分人、翻译塌块）。这里断言按「说话人切换 / 明显停顿 / 句末标点+长度」
 * 正确分段，且能与 extractTranslationsByTokens 配合还原每段翻译。
 */
import { describe, expect, it } from 'vitest';
import {
  convertAsyncTokensToSegments,
  extractTranslationsByTokens,
} from '@/lib/soniox/asyncTranscriptConverter';
import type { SonioxAsyncToken } from '@/lib/soniox/asyncFile';

function orig(
  text: string,
  startMs: number,
  endMs: number,
  extra: Partial<SonioxAsyncToken> = {}
): SonioxAsyncToken {
  return { text, start_ms: startMs, end_ms: endMs, confidence: 0.95, ...extra };
}

function trans(
  text: string,
  startMs: number,
  endMs: number
): SonioxAsyncToken {
  return {
    text,
    start_ms: startMs,
    end_ms: endMs,
    confidence: 0.95,
    translation_status: 'translation',
  };
}

describe('convertAsyncTokensToSegments', () => {
  it('说话人切换 → 分成不同 speaker 的多段（还原 diarization）', () => {
    const tokens = [
      orig('Hello', 0, 400, { speaker: '1' }),
      orig(' everyone', 400, 900, { speaker: '1' }),
      // 说话人从 1 → 2：即使没有停顿也要断段
      orig('Nice', 950, 1300, { speaker: '2' }),
      orig(' day', 1300, 1700, { speaker: '2' }),
    ];

    const segments = convertAsyncTokensToSegments(tokens, { targetLang: 'zh' });

    expect(segments).toHaveLength(2);
    expect(segments[0].speaker).toBe('1');
    expect(segments[0].text).toBe('Hello everyone');
    expect(segments[1].speaker).toBe('2');
    expect(segments[1].text).toBe('Nice day');
  });

  it('明显停顿 → 断段（替代 realtime 的 endpoint 事件）', () => {
    const tokens = [
      orig('First', 0, 400, { speaker: '1' }),
      orig(' part', 400, 800, { speaker: '1' }),
      // 800 → 2000 有 1200ms 停顿（≥ 700ms 阈值）：断段
      orig('Second', 2000, 2400, { speaker: '1' }),
      orig(' part', 2400, 2800, { speaker: '1' }),
    ];

    const segments = convertAsyncTokensToSegments(tokens, { targetLang: '' });

    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('First part');
    expect(segments[1].text).toBe('Second part');
  });

  it('停顿分段 + 翻译按段归属（不再塌成一整块）', () => {
    // 同一说话人的两句，中间有停顿 → 切成两段；每段各自的翻译 token 落在源句区间内，
    // extractTranslationsByTokens 应逐段还原，而非把全部译文塞进单一 key。
    const tokens: SonioxAsyncToken[] = [
      orig('你好世界。', 0, 1500, { speaker: '1', language: 'zh' }),
      // 1500 → 3000 停顿 1500ms（≥ 700）→ 断段
      orig('再见世界。', 3000, 4500, { speaker: '1', language: 'zh' }),
      trans('Hello world.', 0, 1500),
      trans('Goodbye world.', 3000, 4500),
    ];

    const segments = convertAsyncTokensToSegments(tokens, { targetLang: 'en' });
    expect(segments).toHaveLength(2);

    const translations = extractTranslationsByTokens(tokens, segments);
    expect(translations[segments[0].id]).toBe('Hello world.');
    expect(translations[segments[1].id]).toBe('Goodbye world.');
  });

  it('超长无停顿连续语流 → maxChars 上限在句末标点处截断，不产出单一超长段', () => {
    // 首句本身就超过 200 的 maxChars 上限 + 句末标点 → 立即截断；次句同理。
    const sentenceA = 'A'.repeat(210) + '.';
    const sentenceB = 'B'.repeat(210) + '.';
    const tokens = [
      orig(sentenceA, 0, 4000, { speaker: '1' }),
      orig(sentenceB, 4050, 8000, { speaker: '1' }),
    ];

    const segments = convertAsyncTokensToSegments(tokens, { targetLang: '' });
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe(sentenceA);
    expect(segments[1].text).toBe(sentenceB);
  });

  it('单句短音频（无停顿无标点）→ 仍产出单段，不报错', () => {
    const tokens = [
      orig('hi', 0, 300, { speaker: '1' }),
      orig(' there', 300, 700, { speaker: '1' }),
    ];
    const segments = convertAsyncTokensToSegments(tokens, { targetLang: 'zh' });
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('hi there');
  });

  it('空 token → 返回空数组', () => {
    expect(convertAsyncTokensToSegments([], { targetLang: 'zh' })).toEqual([]);
  });
});
