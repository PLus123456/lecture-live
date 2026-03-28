import type { TranscriptSegment } from '@/types/transcript';

export type ExportTranscriptSegment = Pick<
  TranscriptSegment,
  | 'id'
  | 'speaker'
  | 'language'
  | 'text'
  | 'startMs'
  | 'endMs'
  | 'isFinal'
  | 'confidence'
  | 'timestamp'
>;
