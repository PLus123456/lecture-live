/**
 * PDF 导出模块
 * 通过生成样式化 HTML 并使用浏览器原生打印功能生成 PDF
 * 这种方式完美支持 CJK 字符，无需额外字体文件
 */
import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import type { ExportTranscriptSegment } from './types';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
  @page {
    size: A4;
    margin: 2cm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Noto Serif SC", "Source Han Serif SC", Georgia, "Times New Roman", serif;
    color: #2D2D2D;
    line-height: 1.7;
    font-size: 11pt;
    background: #fff;
  }
  .page-title {
    font-size: 22pt;
    color: #9B4D3C;
    font-weight: bold;
    margin-bottom: 8px;
    border-bottom: 3px solid #9B4D3C;
    padding-bottom: 10px;
  }
  .meta { font-size: 9pt; color: #666; margin-bottom: 4px; }
  .divider {
    border: none;
    border-top: 1px solid #D4C9BE;
    margin: 20px 0;
  }
  h2 {
    font-size: 15pt;
    color: #2D2D2D;
    border-bottom: 1px solid #D4C9BE;
    padding-bottom: 6px;
    margin: 24px 0 12px;
  }
  h3 {
    font-size: 12pt;
    color: #666;
    margin: 16px 0 8px;
  }
  .overview {
    background: #F5F0EB;
    padding: 12px 16px;
    border-radius: 4px;
    font-style: italic;
    margin-bottom: 16px;
  }
  ul { padding-left: 20px; margin-bottom: 12px; }
  li { margin-bottom: 4px; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 10pt;
  }
  th {
    background: #9B4D3C;
    color: #fff;
    text-align: left;
    padding: 8px 12px;
    font-weight: bold;
  }
  td {
    padding: 6px 12px;
    border-bottom: 1px solid #D4C9BE;
  }
  tr:nth-child(even) td { background: #F5E6E0; }
  .segment {
    margin-bottom: 12px;
    page-break-inside: avoid;
  }
  .seg-header {
    font-size: 10pt;
    margin-bottom: 2px;
  }
  .seg-speaker { color: #9B4D3C; font-weight: bold; }
  .seg-time { color: #999; font-style: italic; font-size: 9pt; }
  .seg-text { margin-left: 16px; }
  .seg-translation {
    margin-left: 16px;
    background: #F5F0EB;
    padding: 4px 8px;
    border-radius: 3px;
    color: #666;
    font-style: italic;
    font-size: 10pt;
    margin-top: 2px;
  }
  .time-badge {
    display: inline-block;
    background: #F5E6E0;
    color: #9B4D3C;
    padding: 4px 12px;
    border-radius: 4px;
    font-weight: bold;
    margin: 16px 0 8px;
    font-size: 11pt;
  }
  .question-list { list-style-type: decimal; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

function buildTranscriptHtml(
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
): string {
  if (segments.length === 0) return '';
  let html = '<h2>转录文本</h2>';
  for (const seg of segments) {
    html += '<div class="segment">';
    html += `<div class="seg-header"><span class="seg-speaker">[${escapeHtml(seg.speaker)}]</span> <span class="seg-time">${escapeHtml(seg.timestamp)}</span></div>`;
    html += `<div class="seg-text">${escapeHtml(seg.text)}</div>`;
    if (translations[seg.id]) {
      html += `<div class="seg-translation">› ${escapeHtml(translations[seg.id])}</div>`;
    }
    html += '</div>';
  }
  return html;
}

function buildSummaryHtml(
  summaries: SummarizeResponse[],
  report?: SessionReportData | null,
): string {
  let html = '<h2>内容总结</h2>';

  if (report?.significance?.isWorthSummarizing && report.report) {
    const r = report.report;
    if (r.overview) {
      html += `<div class="overview">${escapeHtml(r.overview)}</div>`;
    }
    if (r.sections?.length) {
      for (const section of r.sections) {
        html += `<h3>${escapeHtml(section.title)}</h3><ul>`;
        for (const point of section.points ?? []) {
          html += `<li>${escapeHtml(point)}</li>`;
        }
        html += '</ul>';
      }
    }
    if (r.conclusions?.length) {
      html += '<h3>结论</h3><ul>';
      for (const c of r.conclusions) html += `<li>✓ ${escapeHtml(c)}</li>`;
      html += '</ul>';
    }
    if (r.actionItems?.length) {
      html += '<h3>待办事项</h3><ul>';
      for (const item of r.actionItems) html += `<li>☐ ${escapeHtml(item)}</li>`;
      html += '</ul>';
    }
    if (r.keyTerms && Object.keys(r.keyTerms).length > 0) {
      html += '<h3>关键术语</h3><table><tr><th>术语</th><th>定义</th></tr>';
      for (const [term, def] of Object.entries(r.keyTerms)) {
        html += `<tr><td><strong>${escapeHtml(term)}</strong></td><td>${escapeHtml(def)}</td></tr>`;
      }
      html += '</table>';
    }
  }

  const overallSummaries = summaries.filter((s) => !s.timeRange);
  for (const summary of overallSummaries) {
    if (summary.keyPoints?.length) {
      html += '<h3>要点</h3><ul>';
      for (const p of summary.keyPoints) html += `<li>${escapeHtml(p)}</li>`;
      html += '</ul>';
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      html += '<table><tr><th>术语</th><th>定义</th></tr>';
      for (const [term, def] of Object.entries(summary.definitions)) {
        html += `<tr><td><strong>${escapeHtml(term)}</strong></td><td>${escapeHtml(def)}</td></tr>`;
      }
      html += '</table>';
    }
  }

  return html;
}

function buildTimedSummaryHtml(summaries: SummarizeResponse[]): string {
  const timed = summaries.filter((s) => s.timeRange);
  if (timed.length === 0) return '';

  let html = '<h2>分时总结</h2>';
  for (const summary of timed) {
    html += `<div class="time-badge">⏱ ${escapeHtml(summary.timeRange!)}</div>`;
    if (summary.summary) {
      html += `<p>${escapeHtml(summary.summary)}</p>`;
    }
    if (summary.keyPoints?.length) {
      html += '<ul>';
      for (const p of summary.keyPoints) html += `<li>${escapeHtml(p)}</li>`;
      html += '</ul>';
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      html += '<table><tr><th>术语</th><th>定义</th></tr>';
      for (const [term, def] of Object.entries(summary.definitions)) {
        html += `<tr><td><strong>${escapeHtml(term)}</strong></td><td>${escapeHtml(def)}</td></tr>`;
      }
      html += '</table>';
    }
    if (summary.suggestedQuestions?.length) {
      html += '<h3>复习问题</h3><ol class="question-list">';
      for (const q of summary.suggestedQuestions) html += `<li>${escapeHtml(q)}</li>`;
      html += '</ol>';
    }
  }
  return html;
}

export interface PdfExportOptions {
  title: string;
  date: string;
  sourceLang: string;
  targetLang: string;
  segments?: ExportTranscriptSegment[];
  translations?: Record<string, string>;
  summaries?: SummarizeResponse[];
  report?: SessionReportData | null;
  includeTranscript?: boolean;
  includeSummary?: boolean;
  includeTimedSummary?: boolean;
}

/**
 * 生成 PDF：打开新窗口显示样式化 HTML 并自动触发打印
 * 用户在打印对话框中选择"另存为 PDF"即可
 */
export function exportPdf(options: PdfExportOptions): void {
  const {
    title, date, sourceLang, targetLang,
    segments = [], translations = {}, summaries = [],
    report,
    includeTranscript = true, includeSummary = true, includeTimedSummary = true,
  } = options;

  const dateStr = new Date(date).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  let bodyHtml = `
    <div class="page-title">${escapeHtml(title)}</div>
    <div class="meta">日期：${escapeHtml(dateStr)}</div>
    <div class="meta">语言：${escapeHtml(sourceLang)} → ${escapeHtml(targetLang)}</div>
    <div class="meta">导出时间：${escapeHtml(new Date().toLocaleString('zh-CN'))}</div>
    <hr class="divider">
  `;

  if (includeSummary) {
    bodyHtml += buildSummaryHtml(summaries, report);
    bodyHtml += '<hr class="divider">';
  }

  if (includeTimedSummary) {
    const timedHtml = buildTimedSummaryHtml(summaries);
    if (timedHtml) {
      bodyHtml += timedHtml;
      bodyHtml += '<hr class="divider">';
    }
  }

  if (includeTranscript) {
    bodyHtml += buildTranscriptHtml(segments, translations);
  }

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} - LectureLive</title>
  <style>${CSS}</style>
</head>
<body>${bodyHtml}</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    // 弹窗被阻止，回退到 blob 下载 HTML
    const blob = new Blob([fullHtml], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'lecture'}.html`;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  printWindow.document.write(fullHtml);
  printWindow.document.close();

  // 等待渲染完成后自动打印
  printWindow.onload = () => {
    setTimeout(() => {
      printWindow.print();
    }, 300);
  };
}
