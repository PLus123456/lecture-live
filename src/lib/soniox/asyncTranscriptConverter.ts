/**
 * 把 Soniox async transcript（一次性返回所有 token）转成项目内部用的
 * TranscriptSegment[]。
 *
 * Async 和 realtime 的 token shape 几乎一致，除了：
 * - async token 没有 is_final（都是已完成的）→ 全部标记 is_final: true
 * - async 的 translation_status 只有 "translation"（翻译 token）或 absent（原文）；
 *   TokenProcessor 期望的是 'none' | 'original' | 'translation'，我们把 absent → 'original'
 *
 * ⚠️ 分段：async（文件）路径拿不到 realtime 的两个分段驱动 ——
 *   1. Soniox WebSocket 的 endpoint 事件（停顿/说话人边界触发 onEndpoint）：文件 API 不产出；
 *   2. useSoniox 里按窗口高度设的 setMaxSegmentChars 自动截断：那是纯前端逻辑。
 * 而 TokenProcessor 自身**不会**按说话人或句末标点主动分段（只在 onEndpoint 或
 * maxSegmentChars 命中时 flush）。所以早期「一次性喂全量 + 末尾一次 onEndpoint」的实现
 * 会把整段音频压成**单个 segment**：无分段、无分人（只取首 token 的 speaker）、翻译也
 * 塌成一整块。这里改成用文件 token 自带的信号在服务端重建分段，逼近 realtime 观感。
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

/** 相邻 token 时间间隙 ≥ 此阈值视为明显停顿 → 切段（替代 realtime 的 endpoint 事件）。 */
const ASYNC_SEGMENT_SILENCE_GAP_MS = 700;
/** 无停顿/无说话人切换的连续语流的兜底长度上限：达到后遇句末标点即截断。 */
const ASYNC_SEGMENT_MAX_CHARS = 200;

/** 在 next token 之前是否应当断段（说话人切换或明显停顿）。 */
function shouldBreakBefore(prev: RealtimeToken, next: RealtimeToken): boolean {
  // 说话人切换（两侧都带 speaker 且不同）→ 还原 diarization 的分人
  const prevSpeaker = prev.speaker ?? '';
  const nextSpeaker = next.speaker ?? '';
  if (nextSpeaker && prevSpeaker && nextSpeaker !== prevSpeaker) {
    return true;
  }
  // 明显停顿：相邻 token 之间的时间间隙
  if (
    typeof prev.end_ms === 'number' &&
    typeof next.start_ms === 'number' &&
    next.start_ms - prev.end_ms >= ASYNC_SEGMENT_SILENCE_GAP_MS
  ) {
    return true;
  }
  return false;
}

export function convertAsyncTokensToSegments(
  asyncTokens: SonioxAsyncToken[],
  config: Pick<SessionConfig, 'targetLang'>
): TranscriptSegment[] {
  // 只用原文 token 做分段；翻译 token 交给 extractTranslationsByTokens 单独按时间归属。
  const originalTokens: RealtimeToken[] = asyncTokens
    .filter((t) => t.translation_status !== 'translation')
    .map((t) => ({
      text: t.text,
      start_ms: t.start_ms,
      end_ms: t.end_ms,
      confidence: t.confidence,
      is_final: true,
      speaker: t.speaker ?? undefined,
      language: t.language ?? undefined,
      translation_status: 'original',
    }));

  const collected: TranscriptSegment[] = [];
  const processor = new TokenProcessor({
    onSegmentFinalized: (seg) => collected.push(seg),
  });
  processor.setTargetLang(config.targetLang || '');
  processor.setMaxSegmentChars(ASYNC_SEGMENT_MAX_CHARS);

  let prev: RealtimeToken | null = null;
  for (const token of originalTokens) {
    // 说话人切换 / 明显停顿：先把已累积的上一段结算，再开始新段。
    if (prev && shouldBreakBefore(prev, token)) {
      processor.onEndpoint();
    }
    // 逐 token 喂：让「句末标点 + maxSegmentChars」的自动截断能在正确位置触发。
    processor.processTokens([token]);
    prev = token;
  }
  // 强制 flush 尾部未结算的 token
  processor.onEndpoint();

  if (collected.length > 0) return collected;
  // 兜底：一个段都没结算（极短、无标点、无停顿）——退回逐 token 段，至少不塌成空。
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
