import type { ExportTranscriptSegment } from './types';

/** v2 simplified export interface */
export function exportSrt(segments: ExportTranscriptSegment[]): string {
  return exportToSrt(segments);
}

function formatSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${millis.toString().padStart(3, '0')}`;
}

export function exportToSrt(
  segments: ExportTranscriptSegment[],
  translations?: Record<string, string>
): string {
  const lines: string[] = [];

  segments.forEach((seg, index) => {
    lines.push(`${index + 1}`);
    lines.push(`${formatSrtTime(seg.startMs)} --> ${formatSrtTime(seg.endMs)}`);
    lines.push(seg.text);
    if (translations?.[seg.id]) {
      lines.push(translations[seg.id]);
    }
    lines.push('');
  });

  return lines.join('\n');
}
