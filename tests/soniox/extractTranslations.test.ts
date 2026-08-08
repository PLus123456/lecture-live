/**
 * 单测 extractTranslationsByTokens —— 上传转录路径从 Soniox tokens 还原翻译文本的入口。
 */
import { describe, expect, it } from 'vitest';
import {
  extractTranslationsByTokens,
  type TranslationSegmentBounds,
} from '@/lib/soniox/asyncTranscriptConverter';
import type { SonioxAsyncToken } from '@/lib/soniox/asyncFile';

function origToken(
  text: string,
  startMs: number,
  endMs: number,
  extra: Partial<SonioxAsyncToken> = {}
): SonioxAsyncToken {
  return {
    text,
    start_ms: startMs,
    end_ms: endMs,
    confidence: 0.95,
    ...extra,
  };
}

function transToken(
  text: string,
  startMs: number,
  endMs: number,
  extra: Partial<SonioxAsyncToken> = {}
): SonioxAsyncToken {
  return {
    text,
    start_ms: startMs,
    end_ms: endMs,
    confidence: 0.95,
    translation_status: 'translation',
    ...extra,
  };
}

function bounds(
  id: string,
  startMs: number,
  endMs: number
): TranslationSegmentBounds {
  return { id, startMs, endMs };
}

describe('extractTranslationsByTokens', () => {
  it('空 tokens 返回 {}', () => {
    const segments = [bounds('seg-1', 0, 1000)];
    expect(extractTranslationsByTokens([], segments)).toEqual({});
  });

  it('空 segments 返回 {}', () => {
    const tokens = [transToken('hello', 0, 500)];
    expect(extractTranslationsByTokens(tokens, [])).toEqual({});
  });

  it('全是原文 token（无 translation_status）→ {}', () => {
    const tokens = [origToken('你好', 0, 500), origToken('世界', 500, 1000)];
    const segments = [bounds('seg-1', 0, 1000)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({});
  });

  it('单 segment 单翻译 token → 正确归属', () => {
    const tokens = [
      origToken('你好', 0, 500),
      transToken('hello', 0, 500),
    ];
    const segments = [bounds('seg-1', 0, 500)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-1': 'hello',
    });
  });

  it('单 segment 多个连续翻译 token → 拼接成完整翻译', () => {
    const tokens = [
      origToken('你', 0, 100),
      origToken('好', 100, 200),
      origToken('世', 200, 300),
      origToken('界', 300, 400),
      transToken('hello', 0, 200),
      transToken(' ', 200, 250),
      transToken('world', 250, 400),
    ];
    const segments = [bounds('seg-1', 0, 400)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-1': 'hello world',
    });
  });

  it('多 segment 多翻译 token → 每个 segment 一条翻译', () => {
    const tokens = [
      // seg-1 区间 [0, 500]
      origToken('你好', 0, 500),
      transToken('hello', 0, 500),
      // seg-2 区间 [500, 1000]
      origToken('世界', 500, 1000),
      transToken('the ', 500, 700),
      transToken('world', 700, 1000),
    ];
    const segments = [bounds('seg-1', 0, 500), bounds('seg-2', 500, 1000)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-1': 'hello',
      'seg-2': 'the world',
    });
  });

  it('翻译 token 时间区间跨越 segment 边界 → 归到起始时间所在的 segment', () => {
    const tokens = [
      origToken('你好', 0, 500),
      origToken('世界', 500, 1000),
      // 这个翻译 token 从 seg-1 跨到 seg-2，应当按 start_ms 归到 seg-1
      transToken('hello world', 400, 800),
    ];
    const segments = [bounds('seg-1', 0, 500), bounds('seg-2', 500, 1000)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-1': 'hello world',
    });
  });

  // V1a：零容差归属会把落在段间 gap 的翻译 token 静默丢掉（整段译文凭空缺失）。
  // 现在精确区间未命中时退到「时间最近且在 250ms 容差内」的段，超出容差才丢。
  it('翻译 token 落在 gap 里但在容差内 → 归到时间最近的段', () => {
    const tokens = [
      origToken('你好', 0, 500),
      origToken('世界', 1000, 1500),
      transToken('hello', 0, 500),
      // 落在 [500, 1000) 的 gap 里，但距 seg-1 尾部仅 100ms（≤250ms 容差）
      transToken(' tail', 600, 800),
    ];
    const segments = [bounds('seg-1', 0, 500), bounds('seg-2', 1000, 1500)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-1': 'hello tail',
    });
  });

  it('翻译 token 落在 gap 正中、两侧都超出容差 → 安静跳过，不抛错', () => {
    const tokens = [
      origToken('你好', 0, 500),
      origToken('世界', 3000, 3500),
      // 距 seg-1 尾 1000ms、距 seg-2 头 1500ms，两侧都 >250ms
      transToken('orphan', 1500, 1800),
      transToken('hello', 0, 500),
    ];
    const segments = [bounds('seg-1', 0, 500), bounds('seg-2', 3000, 3500)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-1': 'hello',
    });
  });

  it('末段之后一点点的翻译 token（翻译滞后于原文）不再被丢弃', () => {
    const tokens = [
      origToken('你好', 0, 500),
      origToken('世界', 500, 1000),
      // start_ms 比末段 endMs 晚 200ms —— 零容差下整条被丢，译文缺失
      transToken('late tail', 1200, 1400),
    ];
    const segments = [bounds('seg-1', 0, 500), bounds('seg-2', 500, 1000)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-2': 'late tail',
    });
  });

  it('相邻 segment 边界：start_ms === 前段 endMs 归到后段（半开区间）', () => {
    const tokens = [
      origToken('你好', 0, 500),
      origToken('世界', 500, 1000),
      // start_ms=500 落在 seg-1.endMs / seg-2.startMs；半开 [startMs, endMs) 归 seg-2
      transToken('boundary', 500, 700),
    ];
    const segments = [bounds('seg-1', 0, 500), bounds('seg-2', 500, 1000)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-2': 'boundary',
    });
  });

  it('最后一个 segment 的右端点闭合：start_ms === lastSeg.endMs 仍归该段', () => {
    const tokens = [
      origToken('你好', 0, 500),
      origToken('世界', 500, 1000),
      // start_ms=1000 === lastSeg.endMs；最后段闭合，归 seg-2
      transToken('tail', 1000, 1000),
    ];
    const segments = [bounds('seg-1', 0, 500), bounds('seg-2', 500, 1000)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-2': 'tail',
    });
  });

  it('中文翻译 token 直接拼接，不插空格', () => {
    const tokens = [
      origToken('hello world', 0, 1000),
      transToken('你', 0, 300),
      transToken('好', 300, 600),
      transToken('世界', 600, 1000),
    ];
    const segments = [bounds('seg-1', 0, 1000)];
    expect(extractTranslationsByTokens(tokens, segments)).toEqual({
      'seg-1': '你好世界',
    });
  });
});
