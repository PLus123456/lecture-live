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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize and validate an array of unknown input into safe ExportTranscriptSegment[].
 * Ensures all fields have correct types with sensible defaults, and filters out empty text.
 */
export function toExportSegments(input: unknown[]): ExportTranscriptSegment[] {
  return input
    .filter(isPlainObject)
    .map((segment) => ({
      id: typeof segment.id === 'string' ? segment.id : crypto.randomUUID(),
      speaker:
        typeof segment.speaker === 'string' && segment.speaker.trim()
          ? segment.speaker
          : 'Speaker',
      language:
        typeof segment.language === 'string' && segment.language.trim()
          ? segment.language
          : 'en',
      text: typeof segment.text === 'string' ? segment.text : '',
      startMs:
        typeof segment.startMs === 'number'
          ? segment.startMs
          : typeof segment.globalStartMs === 'number'
            ? segment.globalStartMs
            : 0,
      endMs:
        typeof segment.endMs === 'number'
          ? segment.endMs
          : typeof segment.globalEndMs === 'number'
            ? segment.globalEndMs
            : 0,
      isFinal: segment.isFinal !== false,
      confidence:
        typeof segment.confidence === 'number' ? segment.confidence : 1,
      timestamp:
        typeof segment.timestamp === 'string' ? segment.timestamp : '00:00:00',
    }))
    .filter((segment) => segment.text.trim().length > 0);
}
