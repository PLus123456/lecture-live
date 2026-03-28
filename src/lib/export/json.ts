import type { SummarizeResponse } from '@/types/summary';
import type { ExportTranscriptSegment } from './types';

/** v2 simplified export interface */
export function exportJson(
  title: string,
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
  summaries: unknown[]
): string {
  return exportToJson(title, new Date().toISOString(), segments, translations, summaries as SummarizeResponse[]);
}

export function exportToJson(
  title: string,
  date: string,
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
  summaries: SummarizeResponse[]
): string {
  return JSON.stringify(
    {
      title,
      date,
      exportedAt: new Date().toISOString(),
      segments: segments.map((seg) => ({
        ...seg,
        translation: translations[seg.id] ?? null,
      })),
      summaries,
    },
    null,
    2
  );
}
