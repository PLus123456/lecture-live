import type { SummaryBlock } from '@/types/summary';
import type { TranscriptSegment } from '@/types/transcript';

export function makeTranscriptSegment(
  overrides: Partial<TranscriptSegment> = {}
): TranscriptSegment {
  return {
    id: 'seg-1',
    sessionIndex: 0,
    speaker: 'speaker-1',
    language: 'en',
    text: 'Hello',
    globalStartMs: 0,
    globalEndMs: 1_000,
    startMs: 0,
    endMs: 1_000,
    isFinal: true,
    confidence: 0.99,
    timestamp: '00:00:00',
    ...overrides,
  };
}

export function makeSummaryBlock(
  overrides: Partial<SummaryBlock> = {}
): SummaryBlock {
  return {
    id: 'sum-1',
    blockIndex: 0,
    timeRange: { startMs: 0, endMs: 1_000 },
    keyPoints: ['Key point'],
    definitions: { term: 'Definition' },
    summary: 'Summary',
    suggestedQuestions: ['Question?'],
    frozen: false,
    ...overrides,
  };
}
