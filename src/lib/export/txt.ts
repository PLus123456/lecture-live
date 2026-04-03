import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import type { ExportTranscriptSegment } from './types';

/**
 * 将总结和报告格式化为纯文本
 */
export function formatSummaryTxt(
  summaries: SummarizeResponse[],
  report?: SessionReportData | null,
): string {
  const lines: string[] = [];

  if (report?.significance?.isWorthSummarizing && report.report) {
    const r = report.report;
    if (r.overview) lines.push(r.overview, '');
    for (const section of r.sections ?? []) {
      lines.push(section.title, '-'.repeat(20));
      for (const p of section.points ?? []) lines.push(`• ${p}`);
      lines.push('');
    }
    if (r.conclusions?.length) {
      lines.push('结论：');
      for (const c of r.conclusions) lines.push(`• ${c}`);
      lines.push('');
    }
    if (r.actionItems?.length) {
      lines.push('待办事项：');
      for (const a of r.actionItems) lines.push(`□ ${a}`);
      lines.push('');
    }
    if (r.keyTerms && Object.keys(r.keyTerms).length > 0) {
      lines.push('关键术语：');
      for (const [term, definition] of Object.entries(r.keyTerms)) {
        lines.push(`${term}: ${definition}`);
      }
      lines.push('');
    }
  }

  const overallSummaries = summaries.filter((s) => !s.timeRange);
  for (const summary of overallSummaries) {
    if (summary.summary) lines.push(summary.summary, '');
    if (summary.keyPoints?.length) {
      lines.push('要点：');
      for (const p of summary.keyPoints) lines.push(`• ${p}`);
      lines.push('');
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      lines.push('术语：');
      for (const [term, def] of Object.entries(summary.definitions)) {
        lines.push(`${term}: ${def}`);
      }
      lines.push('');
    }
    if (summary.suggestedQuestions?.length) {
      lines.push('复习问题：');
      summary.suggestedQuestions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
      lines.push('');
    }
  }

  const timedSummaries = summaries.filter((s) => s.timeRange);
  for (const summary of timedSummaries) {
    lines.push(`[${summary.timeRange}]`);
    if (summary.summary) lines.push(summary.summary);
    if (summary.keyPoints?.length) {
      for (const p of summary.keyPoints) lines.push(`• ${p}`);
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      lines.push('术语：');
      for (const [term, def] of Object.entries(summary.definitions)) {
        lines.push(`${term}: ${def}`);
      }
    }
    if (summary.suggestedQuestions?.length) {
      lines.push('复习问题：');
      summary.suggestedQuestions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 将转录文本格式化为纯文本
 */
export function formatTranscriptTxt(
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
): string {
  return segments
    .map((seg) => {
      const translation = translations[seg.id];
      return `[${seg.speaker}] ${seg.timestamp}\n${seg.text}${translation ? `\n${translation}` : ''}`;
    })
    .join('\n\n');
}

/**
 * 完整 TXT 导出（含总结 + 转录）
 */
export function exportToTxt(
  title: string,
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
  summaries: SummarizeResponse[],
  report?: SessionReportData | null,
): string {
  const parts: string[] = [];

  const summaryText = formatSummaryTxt(summaries, report);
  if (summaryText.trim()) {
    parts.push(`${title}\n${'='.repeat(40)}\n\n${summaryText}`);
  }

  if (segments.length > 0) {
    parts.push(formatTranscriptTxt(segments, translations));
  }

  return parts.filter(Boolean).join('\n\n');
}
