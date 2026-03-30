import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import type { ExportTranscriptSegment } from './types';

/** v2 simplified export interface */
export function exportMarkdown(
  title: string,
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
  summaries: unknown[],
  report?: SessionReportData | null,
  sourceLang = 'en',
  targetLang = 'zh'
): string {
  return exportToMarkdown(
    title,
    new Date().toISOString(),
    sourceLang,
    targetLang,
    segments,
    translations,
    summaries as SummarizeResponse[],
    report
  );
}

export function exportToMarkdown(
  title: string,
  date: string,
  sourceLang: string,
  targetLang: string,
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
  summaries: SummarizeResponse[],
  report?: SessionReportData | null
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push(`**Date**: ${date}`);
  lines.push(`**Languages**: ${sourceLang} → ${targetLang}`);
  lines.push('');

  // 会议报告（如果存在且有意义）
  if (report?.significance?.isWorthSummarizing && report.report) {
    const r = report.report;
    lines.push('---');
    lines.push('');
    lines.push('## Session Report');
    lines.push('');
    if (r.topic) lines.push(`**Topic**: ${r.topic}`);
    if (Array.isArray(r.participants) && r.participants.length > 0) {
      lines.push(`**Participants**: ${r.participants.join(', ')}`);
    }
    if (r.duration) lines.push(`**Duration**: ${r.duration}`);
    lines.push('');
    if (r.overview) lines.push(`> ${r.overview}`);
    lines.push('');

    if (Array.isArray(r.sections)) {
      for (const section of r.sections) {
        lines.push(`### ${section.title}`);
        for (const point of section.points ?? []) {
          lines.push(`- ${point}`);
        }
        lines.push('');
      }
    }

    if (Array.isArray(r.conclusions) && r.conclusions.length > 0) {
      lines.push('### Conclusions');
      for (const c of r.conclusions) {
        lines.push(`- ✓ ${c}`);
      }
      lines.push('');
    }

    if (Array.isArray(r.actionItems) && r.actionItems.length > 0) {
      lines.push('### Action Items');
      for (const item of r.actionItems) {
        lines.push(`- [ ] ${item}`);
      }
      lines.push('');
    }

    if (r.keyTerms && Object.keys(r.keyTerms).length > 0) {
      lines.push('### Key Terms');
      lines.push('| Term | Definition |');
      lines.push('|------|-----------|');
      for (const [term, def] of Object.entries(r.keyTerms)) {
        const safeTerm = String(term).replace(/\|/g, '\\|');
        const safeDef = String(def).replace(/\|/g, '\\|');
        lines.push(`| ${safeTerm} | ${safeDef} |`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## Transcript');
  lines.push('');

  for (const seg of segments) {
    lines.push(`**[${seg.speaker}] ${seg.timestamp}**`);
    lines.push(seg.text);
    if (translations[seg.id]) {
      lines.push(`> ${translations[seg.id]}`);
    }
    lines.push('');
  }

  if (summaries.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## AI Summary');
    lines.push('');

    for (const summary of summaries) {
      if (summary.timeRange) {
        lines.push(`### ${summary.timeRange}`);
      }

      if (summary.keyPoints && summary.keyPoints.length > 0) {
        lines.push('**Key Points:**');
        for (const point of summary.keyPoints) {
          lines.push(`- ${point}`);
        }
        lines.push('');
      }

      if (summary.definitions && Object.keys(summary.definitions).length > 0) {
        lines.push('**Terms:**');
        lines.push('| Term | Definition |');
        lines.push('|------|-----------|');
        for (const [term, def] of Object.entries(summary.definitions)) {
          const safeTerm = String(term).replace(/\|/g, '\\|');
          const safeDef = String(def).replace(/\|/g, '\\|');
          lines.push(`| ${safeTerm} | ${safeDef} |`);
        }
        lines.push('');
      }

      if (summary.suggestedQuestions && summary.suggestedQuestions.length > 0) {
        lines.push('**Review Questions:**');
        summary.suggestedQuestions.forEach((q, i) => {
          lines.push(`${i + 1}. ${q}`);
        });
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
