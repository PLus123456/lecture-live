import type { RealtimeToken } from '@/types/soniox';
import type { TranscriptSegment } from '@/types/transcript';

let segmentCounter = 0;

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

interface SessionRecord {
  index: number;
  timeOffsetMs: number; // 这个 session 相对于录音开始的时间偏移
  finalTokens: RealtimeToken[];
}

interface TranslationBindingMeta {
  sourceLanguage: string;
  targetLanguage: string;
}

interface FinalizedTranslationSegment {
  id: string;
  sourceLanguage: string;
  startMs: number;
  endMs: number;
  translationText: string;
  usesPassthrough: boolean;
}

interface PendingTranslationToken {
  text: string;
  globalTimeMs: number | null;
}

export class TokenProcessor {
  private sessions: SessionRecord[] = [];
  private currentSessionIndex = 0;
  private segmentTokens: RealtimeToken[] = [];
  private currentSegmentTranslation = '';
  private recentTranslationSegments: FinalizedTranslationSegment[] = [];
  private pendingTranslationTokens: PendingTranslationToken[] = [];

  /** 目标翻译语言，用于判断是否需要 passthrough */
  private targetLang = '';

  /** 动态截断阈值（字符数），0 表示不启用 */
  private maxSegmentChars = 0;

  /** 句子结束标点（中英日韩通用） */
  private static SENTENCE_END_RE = /[.!?。！？；]\s*$/;
  private static readonly TRANSLATION_MATCH_TOLERANCE_MS = 250;
  private static readonly MAX_RECENT_TRANSLATION_SEGMENTS = 64;

  private onSegmentFinalized?: (segment: TranscriptSegment) => void;
  private onPreviewUpdate?: (text: string) => void;
  private onTranslationToken?: (
    text: string,
    segmentId: string,
    meta: TranslationBindingMeta
  ) => void;
  private onPreviewTranslationUpdate?: (text: string) => void;

  constructor(callbacks: {
    onSegmentFinalized?: (segment: TranscriptSegment) => void;
    onPreviewUpdate?: (text: string) => void;
    onTranslationToken?: (
      text: string,
      segmentId: string,
      meta: TranslationBindingMeta
    ) => void;
    onPreviewTranslationUpdate?: (text: string) => void;
  }) {
    this.onSegmentFinalized = callbacks.onSegmentFinalized;
    this.onPreviewUpdate = callbacks.onPreviewUpdate;
    this.onTranslationToken = callbacks.onTranslationToken;
    this.onPreviewTranslationUpdate = callbacks.onPreviewTranslationUpdate;

    // 创建初始 session
    this.startNewSession(0);
  }

  /** 设置目标翻译语言 */
  setTargetLang(lang: string) {
    this.targetLang = lang;
  }

  /** 设置动态截断阈值（字符数），由窗口高度动态计算 */
  setMaxSegmentChars(chars: number) {
    this.maxSegmentChars = Math.max(chars, 0);
  }

  /**
   * 判断当前 segment 的主要语言是否就是目标翻译语言。
   * 通过统计各 token 的 language 字段投票决定。
   */
  private isSegmentInTargetLang(): boolean {
    if (!this.targetLang || this.segmentTokens.length === 0) return false;
    const langCounts: Record<string, number> = {};
    for (const t of this.segmentTokens) {
      const lang = t.language || '';
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
    // 找到出现次数最多的语言
    let dominant = '';
    let maxCount = 0;
    for (const [lang, count] of Object.entries(langCounts)) {
      if (count > maxCount) {
        dominant = lang;
        maxCount = count;
      }
    }
    return dominant === this.targetLang;
  }

  /** 检查是否应在句子边界处自动截断 */
  private shouldAutoSplit(): boolean {
    if (this.maxSegmentChars <= 0 || this.segmentTokens.length === 0) return false;
    const text = this.segmentTokens.map((t) => t.text).join('');
    return text.length >= this.maxSegmentChars && TokenProcessor.SENTENCE_END_RE.test(text);
  }

  /** 开始新 session（麦克风切换或关键词注入时调用） */
  startNewSession(timeOffsetMs: number) {
    this.currentSessionIndex++;
    this.sessions.push({
      index: this.currentSessionIndex,
      timeOffsetMs,
      finalTokens: [],
    });
  }

  private getCurrentSession(): SessionRecord {
    return this.sessions[this.sessions.length - 1];
  }

  private getCurrentSegmentRange():
    | { startMs: number; endMs: number }
    | null {
    if (this.segmentTokens.length === 0) return null;

    const currentSession = this.getCurrentSession();
    const rawStartMs = this.segmentTokens[0]?.start_ms ?? 0;
    const rawEndMs =
      this.segmentTokens[this.segmentTokens.length - 1]?.end_ms ?? rawStartMs;

    return {
      startMs: currentSession.timeOffsetMs + rawStartMs,
      endMs: currentSession.timeOffsetMs + rawEndMs,
    };
  }

  private getTokenGlobalTimeMs(
    token: RealtimeToken,
    session: SessionRecord
  ): number | null {
    const localTimeMs =
      typeof token.end_ms === 'number'
        ? token.end_ms
        : typeof token.start_ms === 'number'
          ? token.start_ms
          : null;

    return localTimeMs == null ? null : session.timeOffsetMs + localTimeMs;
  }

  private distanceToRange(timeMs: number, startMs: number, endMs: number): number {
    if (timeMs < startMs) return startMs - timeMs;
    if (timeMs > endMs) return timeMs - endMs;
    return 0;
  }

  private findMatchingFinalizedSegment(
    globalTimeMs: number
  ): FinalizedTranslationSegment | null {
    let bestMatch: FinalizedTranslationSegment | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = this.recentTranslationSegments.length - 1; i >= 0; i--) {
      const segment = this.recentTranslationSegments[i];
      const distance = this.distanceToRange(
        globalTimeMs,
        segment.startMs,
        segment.endMs
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = segment;
        if (distance === 0) {
          break;
        }
      }
    }

    if (
      bestMatch &&
      bestDistance <= TokenProcessor.TRANSLATION_MATCH_TOLERANCE_MS
    ) {
      return bestMatch;
    }

    return null;
  }

  private canMatchCurrentSegment(globalTimeMs: number): boolean {
    const currentRange = this.getCurrentSegmentRange();
    if (!currentRange) return false;

    return (
      this.distanceToRange(
        globalTimeMs,
        currentRange.startMs,
        currentRange.endMs
      ) <= TokenProcessor.TRANSLATION_MATCH_TOLERANCE_MS
    );
  }

  private emitSegmentTranslation(segment: FinalizedTranslationSegment) {
    this.onTranslationToken?.(segment.translationText, segment.id, {
      sourceLanguage: segment.sourceLanguage,
      targetLanguage: this.targetLang,
    });
  }

  private appendTranslationToFinalizedSegment(
    segment: FinalizedTranslationSegment,
    text: string
  ) {
    if (segment.usesPassthrough) {
      segment.translationText = text;
      segment.usesPassthrough = false;
    } else {
      segment.translationText += text;
    }

    this.emitSegmentTranslation(segment);
  }

  private appendPreviewTranslation(text: string) {
    this.currentSegmentTranslation += text;
    this.onPreviewTranslationUpdate?.(this.currentSegmentTranslation);
  }

  private routeTranslationToken(token: PendingTranslationToken): boolean {
    if (token.globalTimeMs != null) {
      const finalizedSegment = this.findMatchingFinalizedSegment(token.globalTimeMs);
      if (finalizedSegment) {
        this.appendTranslationToFinalizedSegment(finalizedSegment, token.text);
        return true;
      }

      if (this.canMatchCurrentSegment(token.globalTimeMs)) {
        this.appendPreviewTranslation(token.text);
        return true;
      }

      return false;
    }

    if (this.segmentTokens.length > 0) {
      this.appendPreviewTranslation(token.text);
      return true;
    }

    return false;
  }

  private flushPendingTranslationTokens() {
    if (this.pendingTranslationTokens.length === 0) return;

    const unresolved: PendingTranslationToken[] = [];
    for (const token of this.pendingTranslationTokens) {
      if (!this.routeTranslationToken(token)) {
        unresolved.push(token);
      }
    }
    this.pendingTranslationTokens = unresolved;
  }

  processTokens(tokens: RealtimeToken[]) {
    const currentSession = this.getCurrentSession();
    const nonFinalTokens: RealtimeToken[] = [];
    const translationTokens: RealtimeToken[] = [];

    for (const token of tokens) {
      // Separate translation tokens from transcription tokens
      if (token.translation_status === 'translation') {
        translationTokens.push(token);
        continue;
      }

      if (token.is_final) {
        currentSession.finalTokens.push(token);
        this.segmentTokens.push(token);

        // 累积文本超过阈值且到达句子边界 → 自动截断
        if (this.shouldAutoSplit()) {
          this.flushSegment();
        }
      } else {
        nonFinalTokens.push(token);
      }
    }

    // Update preview: show accumulated segment tokens + non-final tokens
    // This prevents text from "disappearing" when non-final tokens are revised
    const accText = this.segmentTokens.map((t) => t.text).join('');
    const nonFinalText = nonFinalTokens.map((t) => t.text).join('');
    this.onPreviewUpdate?.(accText + nonFinalText);

    // Handle translation tokens — 累积翻译文本，实时推送 preview
    if (translationTokens.length > 0) {
      for (const token of translationTokens) {
        const pendingToken: PendingTranslationToken = {
          text: token.text,
          globalTimeMs: this.getTokenGlobalTimeMs(token, currentSession),
        };

        if (!this.routeTranslationToken(pendingToken)) {
          this.pendingTranslationTokens.push(pendingToken);
        }
      }
    }

    this.flushPendingTranslationTokens();
  }

  onEndpoint() {
    this.flushSegment();
    this.onPreviewUpdate?.('');
  }

  private flushSegment() {
    if (this.segmentTokens.length === 0) return;

    const currentSession = this.getCurrentSession();
    const text = this.segmentTokens.map((t) => t.text).join('');
    const rawStartMs = this.segmentTokens[0]?.start_ms ?? 0;
    const rawEndMs =
      this.segmentTokens[this.segmentTokens.length - 1]?.end_ms ?? rawStartMs;

    // 全局时间戳对齐
    const globalStartMs = currentSession.timeOffsetMs + rawStartMs;
    const globalEndMs = currentSession.timeOffsetMs + rawEndMs;

    const avgConfidence =
      this.segmentTokens.reduce((sum, t) => sum + t.confidence, 0) /
      this.segmentTokens.length;

    segmentCounter++;
    const segment: TranscriptSegment = {
      id: `seg-${segmentCounter}`,
      sessionIndex: currentSession.index,
      speaker: this.segmentTokens[0]?.speaker ?? '',
      language: this.segmentTokens[0]?.language ?? 'en',
      text: text.trim(),
      globalStartMs,
      globalEndMs,
      startMs: globalStartMs,
      endMs: globalEndMs,
      isFinal: true,
      confidence: avgConfidence,
      timestamp: formatTimestamp(globalStartMs),
    };

    this.onSegmentFinalized?.(segment);

    const trackedSegment: FinalizedTranslationSegment = {
      id: segment.id,
      sourceLanguage: segment.language,
      startMs: globalStartMs,
      endMs: globalEndMs,
      translationText: '',
      usesPassthrough: false,
    };
    this.recentTranslationSegments.push(trackedSegment);
    if (
      this.recentTranslationSegments.length >
      TokenProcessor.MAX_RECENT_TRANSLATION_SEGMENTS
    ) {
      this.recentTranslationSegments = this.recentTranslationSegments.slice(
        -TokenProcessor.MAX_RECENT_TRANSLATION_SEGMENTS
      );
    }

    // 已到达的翻译 preview 先绑定到刚完成的 segment；
    // 若原文语言已是目标语言，则先回退为 passthrough，后续若有真正翻译 token 会覆盖。
    if (this.currentSegmentTranslation) {
      trackedSegment.translationText = this.currentSegmentTranslation;
      this.emitSegmentTranslation(trackedSegment);
    } else if (this.targetLang && this.isSegmentInTargetLang()) {
      trackedSegment.translationText = text.trim();
      trackedSegment.usesPassthrough = true;
      this.emitSegmentTranslation(trackedSegment);
    }

    this.currentSegmentTranslation = '';
    this.onPreviewTranslationUpdate?.('');
    this.segmentTokens = [];
    this.flushPendingTranslationTokens();
  }

  /** 获取所有 session 的完整文本 */
  getAllFinalText(): string {
    return this.sessions
      .flatMap((s) => s.finalTokens.map((t) => t.text))
      .join('');
  }

  /** 构建所有 segments（用于导出等场景） */
  buildAllSegments(): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    for (const session of this.sessions) {
      for (const token of session.finalTokens) {
        const globalStartMs = session.timeOffsetMs + (token.start_ms || 0);
        const globalEndMs = session.timeOffsetMs + (token.end_ms || 0);
        segments.push({
          id: `${session.index}-${token.start_ms}`,
          sessionIndex: session.index,
          speaker: token.speaker || '1',
          language: token.language || 'en',
          text: token.text,
          globalStartMs,
          globalEndMs,
          startMs: globalStartMs,
          endMs: globalEndMs,
          isFinal: true,
          confidence: token.confidence || 0,
          timestamp: formatTimestamp(globalStartMs),
        });
      }
    }
    return segments;
  }

  /** 设置 segmentCounter 起始值（刷新恢复时使用） */
  setSegmentCounterOffset(offset: number) {
    segmentCounter = offset;
  }

  reset() {
    this.sessions = [];
    this.segmentTokens = [];
    this.currentSegmentTranslation = '';
    this.recentTranslationSegments = [];
    this.pendingTranslationTokens = [];
    this.currentSessionIndex = 0;
    segmentCounter = 0;
    this.startNewSession(0);
  }
}
