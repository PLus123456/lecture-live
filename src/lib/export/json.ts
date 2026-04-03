import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import type { ExportTranscriptSegment } from './types';

/** v2 simplified export interface */
export function exportJson(
  title: string,
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
  summaries: unknown[],
  sourceLang?: string,
  targetLang?: string,
  report?: SessionReportData | null,
  date?: string,
): string {
  return exportToJson(
    title,
    date || new Date().toISOString(),
    segments,
    translations,
    summaries as SummarizeResponse[],
    sourceLang,
    targetLang,
    report
  );
}

export function exportToJson(
  title: string,
  date: string,
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
  summaries: SummarizeResponse[],
  sourceLang?: string,
  targetLang?: string,
  report?: SessionReportData | null
): string {
  return JSON.stringify(
    {
      title,
      date,
      ...(sourceLang ? { sourceLang } : {}),
      ...(targetLang ? { targetLang } : {}),
      exportedAt: new Date().toISOString(),
      segments: segments.map((seg) => ({
        ...seg,
        translation: translations[seg.id] ?? null,
      })),
      summaries,
      ...(report ? { report } : {}),
    },
    null,
    2
  );
}
