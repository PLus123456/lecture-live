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

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

interface SessionRecord {
  index: number;
  timeOffsetMs: number;
  finalTokens: RealtimeToken[];
}

interface TranslationMeta {
  state: SegmentTranslationState;
  sourceLanguage: string | null;
}

interface TrackedTranslationSegment {
  id: string;
  sourceLanguage: string;
  startMs: number;
  endMs: number;
  finalText: string;
  nonFinalText: string;
  usesPassthrough: boolean;
}

interface PendingTranslationToken {
  text: string;
  isFinal: boolean;
  globalTimeMs: number | null;
  sourceLanguage: string | null;
}

export class TokenProcessor {
  private sessions: SessionRecord[] = [];
  private currentSessionIndex = 0;
  private segmentFinalTokens: RealtimeToken[] = [];
  private segmentNonFinalTokens: RealtimeToken[] = [];
  private previewTranslationFinalTokens: RealtimeToken[] = [];
  private previewTranslationNonFinalTokens: RealtimeToken[] = [];
  private previewTranslationSourceLanguage: string | null = null;
  private recentTranslationSegments: TrackedTranslationSegment[] = [];
  private pendingTranslationTargets: string[] = [];
  private pendingTranslationTokens: PendingTranslationToken[] = [];

  private targetLang = '';
  // 双向同传（two_way）语言对：设置后，每个段落的目标语言按其检测到的原文语言
  // 动态取「语言对中的另一个」，而非固定单一 targetLang。这样 A→B 段目标为 langB、
  // B→A 段目标为 langA，passthrough/waiting 判定对两个方向都成立。
  private languagePair: { langA: string; langB: string } | null = null;
  private maxSegmentChars = 0;
  // segment id 自增计数器：用实例字段而非模块级全局，避免多个 TokenProcessor
  // 并发（录音 / 同传 / 文件转录）时共享同一计数器导致 segment id 串号、碰撞
  private segmentCounter = 0;

  private static SENTENCE_END_RE = /[.!?。！？；]\s*$/;
  private static readonly TRANSLATION_MATCH_TOLERANCE_MS = 250;
  private static readonly MAX_RECENT_TRANSLATION_SEGMENTS = 64;

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
    this.startNewSession(0);
  }

  setTargetLang(lang: string) {
    this.targetLang = lang;
    this.languagePair = null;
  }

  // 双向同传：设置 A↔B 语言对。目标语言按段落原文语言动态解析（见 resolveTargetLang）。
  setLanguagePair(langA: string, langB: string) {
    this.languagePair = { langA, langB };
    // targetLang 仍作为「是否启用翻译判定」的开关：设为 langB 以保证判定分支被激活，
    // 但实际每段目标由 resolveTargetLang 按方向覆盖，故它自身的值不参与相等比较。
    this.targetLang = langB;
  }

  // 解析某段落的目标语言：
  // - two_way：取语言对中与原文语言不同的那一个（A→B 目标 langB、B→A 目标 langA）。
  //   若原文语言不在语言对内（误检第三语言），回退到 langB 作为默认目标。
  // - one_way：恒为固定 targetLang。
  private resolveTargetLang(sourceLanguage: string | null): string {
    if (!this.languagePair) {
      return this.targetLang;
    }
    const { langA, langB } = this.languagePair;
    if (sourceLanguage === langA) return langB;
    if (sourceLanguage === langB) return langA;
    return langB;
  }

  setMaxSegmentChars(chars: number) {
    this.maxSegmentChars = Math.max(chars, 0);
  }

  startNewSession(timeOffsetMs: number) {
    this.currentSessionIndex++;
    this.sessions.push({
      index: this.currentSessionIndex,
      timeOffsetMs,
      finalTokens: [],
    });
  }

  processTokens(tokens: RealtimeToken[]) {
    const currentSession = this.getCurrentSession();
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

      this.segmentNonFinalTokens = nextNonFinalTokens;
    }

    if (this.shouldAutoSplit()) {
      this.flushSegment();
    }

    if (translationTokens.length > 0) {
      this.processTranslationTokens(translationTokens, currentSession);
    }

    this.flushPendingTranslationTokens();
    this.emitPreviewState();
  }

  onEndpoint() {
    this.flushSegment();
    this.emitPreviewState();
  }

  private getCurrentSession(): SessionRecord {
    return this.sessions[this.sessions.length - 1];
  }

  private getCurrentSegmentTokens(): RealtimeToken[] {
    return [...this.segmentFinalTokens, ...this.segmentNonFinalTokens];
  }

  private getCurrentSegmentRange():
    | { startMs: number; endMs: number }
    | null {
    const tokens = this.getCurrentSegmentTokens();
    if (tokens.length === 0) return null;

    const currentSession = this.getCurrentSession();
    const startToken = tokens.find(
      (token) => typeof token.start_ms === 'number'
    );
    const endToken = [...tokens]
      .reverse()
      .find((token) => typeof token.end_ms === 'number');
    const rawStartMs = startToken?.start_ms ?? 0;
    const rawEndMs = endToken?.end_ms ?? rawStartMs;

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

  private getDominantLanguage(tokens = this.getCurrentSegmentTokens()) {
    if (tokens.length === 0) {
      return null;
    }

    const languageCounts: Record<string, number> = {};
    for (const token of tokens) {
      if (!token.language) continue;
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

    // 该段原文语言是否已经等于「它自己的目标语言」。双向模式下目标按方向解析，
    // 因此一个干净的 A↔B 段（A→B 或 B→A）永远不会命中 passthrough——这正是期望：
    // Soniox 对每段都会产出跨语真实译文，不能被误判为无需翻译。
    const dominant = this.getDominantLanguage(tokens);
    return dominant != null && dominant === this.resolveTargetLang(dominant);
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

  private shouldAutoSplit(): boolean {
    if (this.maxSegmentChars <= 0) {
      return false;
    }

    const text = combinePreviewText(this.getCurrentPreview());
    return (
      text.length >= this.maxSegmentChars &&
      TokenProcessor.SENTENCE_END_RE.test(text)
    );
  }

  private addTrackedTranslationSegment(segment: TrackedTranslationSegment) {
    this.recentTranslationSegments.push(segment);
    if (
      this.recentTranslationSegments.length >
      TokenProcessor.MAX_RECENT_TRANSLATION_SEGMENTS
    ) {
      const overflow = this.recentTranslationSegments.length -
        TokenProcessor.MAX_RECENT_TRANSLATION_SEGMENTS;
      const removed = this.recentTranslationSegments.splice(0, overflow);
      if (removed.length > 0) {
        const removedIds = new Set(removed.map((item) => item.id));
        this.pendingTranslationTargets = this.pendingTranslationTargets.filter(
          (segmentId) => !removedIds.has(segmentId)
        );
      }
    }
  }

  private findTrackedTranslationSegmentById(segmentId: string) {
    return this.recentTranslationSegments.find((segment) => segment.id === segmentId) ?? null;
  }

  private findMatchingFinalizedSegment(globalTimeMs: number) {
    let bestMatch: TrackedTranslationSegment | null = null;
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
        if (distance === 0) break;
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

  private canMatchCurrentSegment(globalTimeMs: number) {
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

  private emitTrackedTranslationSegment(segment: TrackedTranslationSegment) {
    const text = segment.finalText.trim();
    const state: SegmentTranslationState = text
      ? segment.nonFinalText.trim()
        ? 'streaming'
        : 'final'
      : 'pending';

    this.onTranslationToken?.(text, segment.id, {
      state,
      sourceLanguage: segment.sourceLanguage,
    });

    if (state === 'final') {
      this.pendingTranslationTargets = this.pendingTranslationTargets.filter(
        (segmentId) => segmentId !== segment.id
      );
    }
  }

  private applyTokensToTrackedSegment(
    segment: TrackedTranslationSegment,
    tokens: PendingTranslationToken[]
  ) {
    if (tokens.length === 0) return;

    const sourceLanguage =
      tokens.find((token) => token.sourceLanguage)?.sourceLanguage ??
      segment.sourceLanguage;
    segment.sourceLanguage = sourceLanguage ?? segment.sourceLanguage;

    const finalTextChunk = tokens
      .filter((token) => token.isFinal)
      .map((token) => token.text)
      .join('');
    const nonFinalText = tokens
      .filter((token) => !token.isFinal)
      .map((token) => token.text)
      .join('');

    if (finalTextChunk) {
      if (segment.usesPassthrough) {
        segment.finalText = '';
        segment.usesPassthrough = false;
      }
      segment.finalText += finalTextChunk;
    }

    if (nonFinalText) {
      segment.nonFinalText = nonFinalText;
    } else if (finalTextChunk) {
      segment.nonFinalText = '';
    }

    this.emitTrackedTranslationSegment(segment);
  }

  private enqueuePendingTarget(segmentId: string) {
    if (!this.pendingTranslationTargets.includes(segmentId)) {
      this.pendingTranslationTargets.push(segmentId);
    }
  }

  private findPendingTarget(sourceLanguage: string | null) {
    if (this.pendingTranslationTargets.length === 0) {
      return null;
    }

    if (sourceLanguage) {
      for (const segmentId of this.pendingTranslationTargets) {
        const target = this.findTrackedTranslationSegmentById(segmentId);
        if (target?.sourceLanguage === sourceLanguage) {
          return target;
        }
      }
    }

    if (this.pendingTranslationTargets.length === 1) {
      return this.findTrackedTranslationSegmentById(this.pendingTranslationTargets[0]);
    }

    return this.findTrackedTranslationSegmentById(
      this.pendingTranslationTargets[this.pendingTranslationTargets.length - 1]
    );
  }

  private applyTokensToCurrentPreview(tokens: PendingTranslationToken[]) {
    if (tokens.length === 0) return;

    const sourceLanguage =
      tokens.find((token) => token.sourceLanguage)?.sourceLanguage ??
      this.getDominantLanguage();
    const finalTokens = tokens.filter((token) => token.isFinal);
    const nonFinalTokens = tokens.filter((token) => !token.isFinal);

    if (finalTokens.length > 0) {
      this.previewTranslationFinalTokens.push(
        ...finalTokens.map((token) => ({
          text: token.text,
          confidence: 1,
          is_final: true,
        }))
      );
    }
    this.previewTranslationNonFinalTokens = nonFinalTokens.map((token) => ({
      text: token.text,
      confidence: 1,
      is_final: false,
    }));
    this.previewTranslationSourceLanguage =
      sourceLanguage ?? this.previewTranslationSourceLanguage ?? null;
  }

  private routeUntimedTranslationTokens(tokens: PendingTranslationToken[]) {
    if (tokens.length === 0) return;

    const sourceLanguage =
      tokens.find((token) => token.sourceLanguage)?.sourceLanguage ?? null;
    const hasCurrentPreview = hasPreviewContent(this.getCurrentPreview());

    if (hasCurrentPreview) {
      this.applyTokensToCurrentPreview(tokens);
      return;
    }

    const pendingTarget = this.findPendingTarget(sourceLanguage);
    if (pendingTarget) {
      this.applyTokensToTrackedSegment(pendingTarget, tokens);
      return;
    }

    const latestSegment = this.recentTranslationSegments.at(-1);
    if (latestSegment) {
      this.applyTokensToTrackedSegment(latestSegment, tokens);
      return;
    }

    this.applyTokensToCurrentPreview(tokens);
  }

  private processTranslationTokens(
    tokens: RealtimeToken[],
    currentSession: SessionRecord
  ) {
    const currentPreviewTokens: PendingTranslationToken[] = [];
    const finalizedGroups = new Map<string, PendingTranslationToken[]>();
    const untimedTokens: PendingTranslationToken[] = [];

    for (const token of tokens) {
      const queuedToken: PendingTranslationToken = {
        text: token.text,
        isFinal: token.is_final,
        globalTimeMs: this.getTokenGlobalTimeMs(token, currentSession),
        sourceLanguage: token.source_language ?? null,
      };

      if (queuedToken.globalTimeMs == null) {
        untimedTokens.push(queuedToken);
        continue;
      }

      const finalizedSegment = this.findMatchingFinalizedSegment(
        queuedToken.globalTimeMs
      );
      if (finalizedSegment) {
        const existing = finalizedGroups.get(finalizedSegment.id) ?? [];
        existing.push(queuedToken);
        finalizedGroups.set(finalizedSegment.id, existing);
        continue;
      }

      if (this.canMatchCurrentSegment(queuedToken.globalTimeMs)) {
        currentPreviewTokens.push(queuedToken);
        continue;
      }

      this.pendingTranslationTokens.push(queuedToken);
    }

    for (const [segmentId, groupedTokens] of finalizedGroups.entries()) {
      const trackedSegment = this.findTrackedTranslationSegmentById(segmentId);
      if (trackedSegment) {
        this.applyTokensToTrackedSegment(trackedSegment, groupedTokens);
      }
    }

    if (currentPreviewTokens.length > 0) {
      this.applyTokensToCurrentPreview(currentPreviewTokens);
    }

    if (untimedTokens.length > 0) {
      this.routeUntimedTranslationTokens(untimedTokens);
    }
  }

  private flushPendingTranslationTokens() {
    if (this.pendingTranslationTokens.length === 0) return;

    const unresolved: PendingTranslationToken[] = [];
    for (const token of this.pendingTranslationTokens) {
      if (token.globalTimeMs != null) {
        const finalizedSegment = this.findMatchingFinalizedSegment(token.globalTimeMs);
        if (finalizedSegment) {
          this.applyTokensToTrackedSegment(finalizedSegment, [token]);
          continue;
        }

        if (this.canMatchCurrentSegment(token.globalTimeMs)) {
          this.applyTokensToCurrentPreview([token]);
          continue;
        }
      }

      unresolved.push(token);
    }

    this.pendingTranslationTokens = unresolved;
  }

  private flushSegment() {
    const segmentTokens = this.getCurrentSegmentTokens();
    if (segmentTokens.length === 0) {
      this.clearCurrentPreviewTranslation();
      return;
    }

    const currentSession = this.getCurrentSession();
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

    this.segmentCounter++;
    const segment: TranscriptSegment = {
      id: `seg-${this.segmentCounter}`,
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

    this.onSegmentFinalized?.(segment);

    const trackedTranslationSegment: TrackedTranslationSegment = {
      id: segment.id,
      sourceLanguage: dominantLanguage,
      startMs: globalStartMs,
      endMs: globalEndMs,
      finalText: '',
      nonFinalText: '',
      usesPassthrough: false,
    };
    this.addTrackedTranslationSegment(trackedTranslationSegment);

    const previewTranslationFinalText = this.previewTranslationFinalTokens
      .map((token) => token.text)
      .join('');
    const previewTranslationNonFinalText = this.previewTranslationNonFinalTokens
      .map((token) => token.text)
      .join('');

    if (previewTranslationFinalText || previewTranslationNonFinalText) {
      trackedTranslationSegment.finalText = previewTranslationFinalText;
      trackedTranslationSegment.nonFinalText = previewTranslationNonFinalText;
      this.emitTrackedTranslationSegment(trackedTranslationSegment);

      if (previewTranslationNonFinalText.trim()) {
        this.enqueuePendingTarget(trackedTranslationSegment.id);
      }
    } else if (this.targetLang && this.isCurrentSegmentInTargetLang(segmentTokens)) {
      trackedTranslationSegment.finalText = text;
      trackedTranslationSegment.usesPassthrough = true;
      this.emitTrackedTranslationSegment(trackedTranslationSegment);
    } else if (this.targetLang) {
      this.enqueuePendingTarget(trackedTranslationSegment.id);
      this.emitTrackedTranslationSegment(trackedTranslationSegment);
    }

    this.segmentFinalTokens = [];
    this.segmentNonFinalTokens = [];
    this.clearCurrentPreviewTranslation();
    this.flushPendingTranslationTokens();
  }

  getAllFinalText(): string {
    return this.sessions
      .flatMap((session) => session.finalTokens.map((token) => token.text))
      .join('');
  }

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

  setSegmentCounterOffset(offset: number) {
    this.segmentCounter = offset;
  }

  reset() {
    this.sessions = [];
    this.segmentFinalTokens = [];
    this.segmentNonFinalTokens = [];
    this.recentTranslationSegments = [];
    this.pendingTranslationTargets = [];
    this.pendingTranslationTokens = [];
    this.clearCurrentPreviewTranslation();
    this.currentSessionIndex = 0;
    this.segmentCounter = 0;
    this.startNewSession(0);
    this.onPreviewUpdate?.(EMPTY_STREAMING_PREVIEW_TEXT);
    this.onPreviewTranslationUpdate?.(EMPTY_STREAMING_PREVIEW_TRANSLATION);
  }
}
