/**
 * 把 Soniox async transcript（一次性返回所有 token）转成项目内部用的
 * TranscriptSegment[]。复用 TokenProcessor 的分段/说话人/翻译配对逻辑。
 *
 * Async 和 realtime 的 token shape 几乎一致，除了：
 * - async token 没有 is_final（都是已完成的）→ 全部标记 is_final: true
 * - async 的 translation_status 只有 "translation"（翻译 token）或 absent（原文）；
 *   TokenProcessor 期望的是 'none' | 'original' | 'translation'，我们把 absent → 'original'
 */
import type { RealtimeToken } from '@/types/soniox';
import type { SessionConfig, TranscriptSegment } from '@/types/transcript';
import { TokenProcessor } from './tokenProcessor';
import type { SonioxAsyncToken } from './asyncFile';

/** 提取 translation 时只用到 segment 的 id + 时间区间，复用 TranscriptSegment 的形状 */
export type TranslationSegmentBounds = Pick<
  TranscriptSegment,
  'id' | 'startMs' | 'endMs'
>;

export function convertAsyncTokensToSegments(
  asyncTokens: SonioxAsyncToken[],
  config: Pick<SessionConfig, 'targetLang'>
): TranscriptSegment[] {
  const realtimeTokens: RealtimeToken[] = asyncTokens.map((t) => ({
    text: t.text,
    start_ms: t.start_ms,
    end_ms: t.end_ms,
    confidence: t.confidence,
    is_final: true,
    speaker: t.speaker ?? undefined,
    language: t.language ?? undefined,
    translation_status:
      t.translation_status === 'translation' ? 'translation' : 'original',
  }));

  const collected: TranscriptSegment[] = [];
  const processor = new TokenProcessor({
    onSegmentFinalized: (seg) => collected.push(seg),
  });
  processor.setTargetLang(config.targetLang || '');

  // 全量喂进去 —— 所有 token 都是 final，processor 内部按句末标点 / 说话人切换分段
  processor.processTokens(realtimeTokens);
  // 强制 flush 尾部未结算的 token
  processor.onEndpoint();

  if (collected.length > 0) return collected;
  // 兜底：onSegmentFinalized 没收到任何段（短句无标点结尾），用 buildAllSegments
  return processor.buildAllSegments();
}

/**
 * 从 Soniox 原始 tokens 里抽出翻译 token（translation_status === 'translation'），
 * 按 start_ms 归属到对应 segment，并拼接成每段的完整翻译文本。
 *
 * 归属规则：半开区间 [startMs, endMs)，最后一个 segment 双端闭合。这样相邻 segment
 * 的边界 token（start_ms === seg.endMs）会归到右边的 segment，与 realtime 路径
 * "按时间最近匹配"的语义一致。
 *
 * 落在 segment gap 里（说话人停顿/标点切段后的空隙）的 token 会安静跳过 —— 允许少量
 * 丢失，下游 UI 仍能正常渲染。
 *
 * 翻译 token 之间在中文/中英混合场景下通常没有空格，直接 join('') 拼接即可。
 */
export function extractTranslationsByTokens(
  tokens: SonioxAsyncToken[],
  segments: TranslationSegmentBounds[]
): Record<string, string> {
  if (!tokens.length || !segments.length) return {};

  const lastIndex = segments.length - 1;
  const parts: Record<string, string[]> = {};
  for (const token of tokens) {
    if (token.translation_status !== 'translation') continue;

    const startMs = token.start_ms;
    const segIdx = segments.findIndex((s, i) =>
      i === lastIndex
        ? startMs >= s.startMs && startMs <= s.endMs
        : startMs >= s.startMs && startMs < s.endMs
    );
    if (segIdx === -1) continue;

    (parts[segments[segIdx].id] ??= []).push(token.text);
  }

  const result: Record<string, string> = {};
  for (const [segmentId, pieces] of Object.entries(parts)) {
    result[segmentId] = pieces.join('');
  }
  return result;
}
