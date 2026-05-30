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

/** SRT 每条字幕的最小时长（ms）。零长 / 缺时间戳的段补足此时长而非丢弃，避免漏字幕。 */
const MIN_SRT_DURATION_MS = 500;

export function exportToSrt(
  segments: ExportTranscriptSegment[],
  translations?: Record<string, string>
): string {
  const lines: string[] = [];
  // 只要有文本就保留；零长 / endMs<=startMs 的段把结束时间补足 MIN_SRT_DURATION_MS，
  // 而不是整段丢弃（此前 filter(endMs>startMs) 会静默吞掉这些字幕）。
  const valid = segments.filter((seg) => seg.text.trim().length > 0);

  valid.forEach((seg, index) => {
    const startMs = Number.isFinite(seg.startMs) && seg.startMs >= 0 ? seg.startMs : 0;
    const endMs =
      Number.isFinite(seg.endMs) && seg.endMs > startMs
        ? seg.endMs
        : startMs + MIN_SRT_DURATION_MS;
    lines.push(`${index + 1}`);
    lines.push(`${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}`);
    lines.push(seg.text);
    if (translations?.[seg.id]) {
      lines.push(translations[seg.id]);
    }
    lines.push('');
  });

  return lines.join('\n');
}
