import type {
  SegmentTranslationEntry,
  SegmentTranslationState,
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';

export const EMPTY_STREAMING_PREVIEW_TEXT: StreamingPreviewText = {
  finalText: '',
  nonFinalText: '',
};

export const EMPTY_STREAMING_PREVIEW_TRANSLATION: StreamingPreviewTranslation = {
  finalText: '',
  nonFinalText: '',
  state: 'idle',
  sourceLanguage: null,
};

export function combinePreviewText(
  preview: StreamingPreviewText | StreamingPreviewTranslation
): string {
  return `${preview.finalText}${preview.nonFinalText}`;
}

export function hasPreviewContent(
  preview: StreamingPreviewText | StreamingPreviewTranslation
): boolean {
  return combinePreviewText(preview).trim().length > 0;
}

export function normalizePreviewText(
  preview: string | StreamingPreviewText
): StreamingPreviewText {
  if (typeof preview === 'string') {
    return {
      finalText: preview,
      nonFinalText: '',
    };
  }

  return {
    finalText: preview.finalText ?? '',
    nonFinalText: preview.nonFinalText ?? '',
  };
}

export function normalizePreviewTranslation(
  preview: string | StreamingPreviewTranslation
): StreamingPreviewTranslation {
  if (typeof preview === 'string') {
    return {
      finalText: preview,
      nonFinalText: '',
      state: preview.trim() ? 'streaming' : 'idle',
      sourceLanguage: null,
    };
  }

  return {
    finalText: preview.finalText ?? '',
    nonFinalText: preview.nonFinalText ?? '',
    state: preview.state ?? 'idle',
    sourceLanguage: preview.sourceLanguage ?? null,
  };
}

export function createSegmentTranslationEntry(
  text = '',
  state: SegmentTranslationState = 'final',
  sourceLanguage: string | null = null
): SegmentTranslationEntry {
  return {
    text,
    state,
    sourceLanguage,
  };
}
