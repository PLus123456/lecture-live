import {
  EMPTY_STREAMING_PREVIEW_TRANSLATION,
  EMPTY_STREAMING_PREVIEW_TEXT,
  combinePreviewText,
  hasPreviewContent,
} from '@/lib/transcriptPreview';
import type { RealtimeToken } from '@/types/soniox';
import type {
  SegmentTranslationState,
  StreamingPreviewText,
  StreamingPreviewTranslation,
  TranscriptSegment,
} from '@/types/transcript';

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

interface TranslationMeta {
  state: SegmentTranslationState;
  sourceLanguage: string | null;
}

interface PendingTranslationTarget {
  segmentId: string;
  sourceLanguage: string | null;
  finalTokens: RealtimeToken[];
  nonFinalTokens: RealtimeToken[];
}

export class TokenProcessor {
  private sessions: SessionRecord[] = [];
  private currentSessionIndex = 0;
  private segmentFinalTokens: RealtimeToken[] = [];
  private segmentNonFinalTokens: RealtimeToken[] = [];
  private previewTranslationFinalTokens: RealtimeToken[] = [];
  private previewTranslationNonFinalTokens: RealtimeToken[] = [];
  private previewTranslationSourceLanguage: string | null = null;
  private pendingTranslationTargets: PendingTranslationTarget[] = [];

  /** 目标翻译语言，用于判断是否需要 passthrough */
  private targetLang = '';

  /** 动态截断阈值（字符数），0 表示不启用 */
  private maxSegmentChars = 0;

  /** 句子结束标点（中英日韩通用） */
  private static SENTENCE_END_RE = /[.!?。！？；]\s*$/;

  private onSegmentFinalized?: (segment: TranscriptSegment) => void;
  private onPreviewUpdate?: (preview: StreamingPreviewText) => void;
  private onTranslationToken?: (
    text: string,
    segmentId: string,
    meta?: TranslationMeta
  ) => void;
  private onPreviewTranslationUpdate?: (
    preview: StreamingPreviewTranslation
  ) => void;

  constructor(callbacks: {
    onSegmentFinalized?: (segment: TranscriptSegment) => void;
    onPreviewUpdate?: (preview: StreamingPreviewText) => void;
    onTranslationToken?: (
      text: string,
      segmentId: string,
      meta?: TranslationMeta
    ) => void;
    onPreviewTranslationUpdate?: (
      preview: StreamingPreviewTranslation
    ) => void;
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

  /** 开始新 session（麦克风切换或关键词注入时调用） */
  startNewSession(timeOffsetMs: number) {
    this.currentSessionIndex++;
    this.sessions.push({
      index: this.currentSessionIndex,
      timeOffsetMs,
      finalTokens: [],
    });
  }

  processTokens(tokens: RealtimeToken[]) {
    const currentSession = this.sessions[this.sessions.length - 1];
    const transcriptionTokens = tokens.filter(
      (token) => token.translation_status !== 'translation'
    );
    const translationTokens = tokens.filter(
      (token) => token.translation_status === 'translation'
    );

    if (transcriptionTokens.length > 0) {
      const nextNonFinalTokens: RealtimeToken[] = [];

      for (const token of transcriptionTokens) {
        if (token.is_final) {
          currentSession.finalTokens.push(token);
          this.segmentFinalTokens.push(token);
        } else {
          nextNonFinalTokens.push(token);
        }
      }

      // Soniox 的 non-final 是“当前尾巴快照”，不是追加流
      this.segmentNonFinalTokens = nextNonFinalTokens;
    }

    if (translationTokens.length > 0) {
      this.processTranslationTokens(translationTokens);
    }

    if (this.shouldAutoSplit()) {
      this.flushSegment();
    }

    this.emitPreviewState();
  }

  onEndpoint() {
    this.flushSegment();
    this.emitPreviewState();
  }

  private processTranslationTokens(tokens: RealtimeToken[]) {
    const sourceLanguage =
      tokens.find((token) => token.source_language)?.source_language ??
      this.getDominantLanguage();
    const pendingTargetIndex = this.findPendingTranslationTarget(sourceLanguage);

    if (pendingTargetIndex >= 0) {
      this.applyTranslationTokensToPendingTarget(
        pendingTargetIndex,
        tokens,
        sourceLanguage
      );
      return;
    }

    const finalTokens = tokens.filter((token) => token.is_final);
    const nonFinalTokens = tokens.filter((token) => !token.is_final);

    if (finalTokens.length > 0) {
      this.previewTranslationFinalTokens.push(...finalTokens);
    }
    this.previewTranslationNonFinalTokens = nonFinalTokens;
    this.previewTranslationSourceLanguage =
      sourceLanguage ?? this.previewTranslationSourceLanguage ?? null;
  }

  private findPendingTranslationTarget(sourceLanguage: string | null): number {
    if (this.pendingTranslationTargets.length === 0) {
      return -1;
    }

    if (sourceLanguage) {
      const matchIndex = this.pendingTranslationTargets.findIndex(
        (target) => target.sourceLanguage === sourceLanguage
      );
      if (matchIndex >= 0) {
        return matchIndex;
      }
    }

    return this.pendingTranslationTargets.length === 1 ? 0 : -1;
  }

  private applyTranslationTokensToPendingTarget(
    index: number,
    tokens: RealtimeToken[],
    sourceLanguage: string | null
  ) {
    const target = this.pendingTranslationTargets[index];
    const finalTokens = tokens.filter((token) => token.is_final);
    const nonFinalTokens = tokens.filter((token) => !token.is_final);

    if (finalTokens.length > 0) {
      target.finalTokens.push(...finalTokens);
    }
    target.nonFinalTokens = nonFinalTokens;
    target.sourceLanguage = target.sourceLanguage ?? sourceLanguage ?? null;

    const finalText = target.finalTokens.map((token) => token.text).join('').trim();
    const hasNonFinalText = target.nonFinalTokens.some(
      (token) => token.text.trim().length > 0
    );
    const state: SegmentTranslationState = hasNonFinalText
      ? 'streaming'
      : finalText
        ? 'final'
        : 'pending';

    this.onTranslationToken?.(finalText, target.segmentId, {
      state,
      sourceLanguage: target.sourceLanguage,
    });

    if (state === 'final') {
      this.pendingTranslationTargets.splice(index, 1);
    }
  }

  private getCurrentSegmentTokens(): RealtimeToken[] {
    return [...this.segmentFinalTokens, ...this.segmentNonFinalTokens];
  }

  private getCurrentPreview(): StreamingPreviewText {
    return {
      finalText: this.segmentFinalTokens.map((token) => token.text).join(''),
      nonFinalText: this.segmentNonFinalTokens.map((token) => token.text).join(''),
    };
  }

  private getCurrentPreviewTranslation(): StreamingPreviewTranslation {
    const preview = this.getCurrentPreview();
    const finalText = this.previewTranslationFinalTokens
      .map((token) => token.text)
      .join('');
    const nonFinalText = this.previewTranslationNonFinalTokens
      .map((token) => token.text)
      .join('');
    const hasTranslationText = `${finalText}${nonFinalText}`.trim().length > 0;

    if (!hasPreviewContent(preview)) {
      return EMPTY_STREAMING_PREVIEW_TRANSLATION;
    }

    if (!hasTranslationText) {
      if (this.targetLang && !this.isCurrentSegmentInTargetLang()) {
        return {
          ...EMPTY_STREAMING_PREVIEW_TRANSLATION,
          state: 'waiting',
          sourceLanguage: this.getDominantLanguage(),
        };
      }

      return {
        ...EMPTY_STREAMING_PREVIEW_TRANSLATION,
        sourceLanguage: this.getDominantLanguage(),
      };
    }

    return {
      finalText,
      nonFinalText,
      state: nonFinalText.trim() ? 'streaming' : 'final',
      sourceLanguage:
        this.previewTranslationSourceLanguage ?? this.getDominantLanguage(),
    };
  }

  private emitPreviewState() {
    this.onPreviewUpdate?.(this.getCurrentPreview());
    this.onPreviewTranslationUpdate?.(this.getCurrentPreviewTranslation());
  }

  private clearCurrentPreviewTranslation() {
    this.previewTranslationFinalTokens = [];
    this.previewTranslationNonFinalTokens = [];
    this.previewTranslationSourceLanguage = null;
  }

  private flushSegment() {
    const segmentTokens = this.getCurrentSegmentTokens();
    if (segmentTokens.length === 0) {
      this.clearCurrentPreviewTranslation();
      return;
    }

    const currentSession = this.sessions[this.sessions.length - 1];
    const rawText = segmentTokens.map((token) => token.text).join('');
    const text = rawText.trim();
    if (!text) {
      this.segmentFinalTokens = [];
      this.segmentNonFinalTokens = [];
      this.clearCurrentPreviewTranslation();
      return;
    }

    const startToken = segmentTokens.find(
      (token) => typeof token.start_ms === 'number'
    );
    const endToken = [...segmentTokens]
      .reverse()
      .find((token) => typeof token.end_ms === 'number');
    const rawStartMs = startToken?.start_ms ?? 0;
    const rawEndMs = endToken?.end_ms ?? rawStartMs;

    // 全局时间戳对齐
    const globalStartMs = currentSession.timeOffsetMs + rawStartMs;
    const globalEndMs = currentSession.timeOffsetMs + rawEndMs;

    const avgConfidence =
      segmentTokens.reduce((sum, token) => sum + token.confidence, 0) /
      segmentTokens.length;
    const dominantLanguage =
      this.getDominantLanguage(segmentTokens) ??
      segmentTokens[0]?.language ??
      'en';
    const speaker =
      segmentTokens.find((token) => token.speaker)?.speaker ?? '';

    segmentCounter++;
    const segment: TranscriptSegment = {
      id: `seg-${segmentCounter}`,
      sessionIndex: currentSession.index,
      speaker,
      language: dominantLanguage,
      text,
      globalStartMs,
      globalEndMs,
      startMs: globalStartMs,
      endMs: globalEndMs,
      isFinal: true,
      confidence: avgConfidence,
      timestamp: formatTimestamp(globalStartMs),
    };

    const translationFinalText = this.previewTranslationFinalTokens
      .map((token) => token.text)
      .join('')
      .trim();
    const hasTranslationNonFinal = this.previewTranslationNonFinalTokens.some(
      (token) => token.text.trim().length > 0
    );
    const translationSourceLanguage =
      this.previewTranslationSourceLanguage ?? dominantLanguage;

    if (translationFinalText || hasTranslationNonFinal) {
      if (hasTranslationNonFinal) {
        this.pendingTranslationTargets.push({
          segmentId: segment.id,
          sourceLanguage: translationSourceLanguage,
          finalTokens: [...this.previewTranslationFinalTokens],
          nonFinalTokens: [...this.previewTranslationNonFinalTokens],
        });
        this.onTranslationToken?.(translationFinalText, segment.id, {
          state: translationFinalText ? 'streaming' : 'pending',
          sourceLanguage: translationSourceLanguage,
        });
      } else if (translationFinalText) {
        this.onTranslationToken?.(translationFinalText, segment.id, {
          state: 'final',
          sourceLanguage: translationSourceLanguage,
        });
      }
    } else if (this.targetLang && this.isCurrentSegmentInTargetLang(segmentTokens)) {
      // Soniox 没返回翻译且当前段语言已等于目标语言时，最终段落直接 passthrough
      this.onTranslationToken?.(text, segment.id, {
        state: 'final',
        sourceLanguage: dominantLanguage,
      });
    } else if (this.targetLang) {
      this.onTranslationToken?.('', segment.id, {
        state: 'pending',
        sourceLanguage: dominantLanguage,
      });
    }

    this.onSegmentFinalized?.(segment);
    this.segmentFinalTokens = [];
    this.segmentNonFinalTokens = [];
    this.clearCurrentPreviewTranslation();
  }

  private getDominantLanguage(tokens = this.getCurrentSegmentTokens()) {
    if (tokens.length === 0) {
      return null;
    }

    const languageCounts: Record<string, number> = {};
    for (const token of tokens) {
      if (!token.language) {
        continue;
      }
      languageCounts[token.language] = (languageCounts[token.language] || 0) + 1;
    }

    let dominantLanguage: string | null = null;
    let maxCount = 0;
    for (const [language, count] of Object.entries(languageCounts)) {
      if (count > maxCount) {
        dominantLanguage = language;
        maxCount = count;
      }
    }

    return dominantLanguage;
  }

  private isCurrentSegmentInTargetLang(tokens = this.getCurrentSegmentTokens()) {
    if (!this.targetLang) {
      return false;
    }

    return this.getDominantLanguage(tokens) === this.targetLang;
  }

  /** 检查是否应在句子边界处自动截断 */
  private shouldAutoSplit(): boolean {
    if (this.maxSegmentChars <= 0) {
      return false;
    }

    const preview = this.getCurrentPreview();
    const text = combinePreviewText(preview);
    return (
      text.length >= this.maxSegmentChars &&
      TokenProcessor.SENTENCE_END_RE.test(text)
    );
  }

  /** 获取所有 session 的完整文本 */
  getAllFinalText(): string {
    return this.sessions
      .flatMap((session) => session.finalTokens.map((token) => token.text))
      .join('');
  }

  /** 构建所有 segments（用于导出等场景） */
  buildAllSegments(): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    for (const session of this.sessions) {
      for (const token of session.finalTokens) {
        const globalStartMs = session.timeOffsetMs + (token.start_ms ?? 0);
        const globalEndMs = session.timeOffsetMs + (token.end_ms ?? 0);
        segments.push({
          id: `${session.index}-${token.start_ms ?? 0}`,
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
    this.segmentFinalTokens = [];
    this.segmentNonFinalTokens = [];
    this.pendingTranslationTargets = [];
    this.clearCurrentPreviewTranslation();
    this.currentSessionIndex = 0;
    segmentCounter = 0;
    this.startNewSession(0);
    this.onPreviewUpdate?.(EMPTY_STREAMING_PREVIEW_TEXT);
    this.onPreviewTranslationUpdate?.(EMPTY_STREAMING_PREVIEW_TRANSLATION);
  }
}
