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
