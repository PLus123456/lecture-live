/**
 * 客户端导出编排器
 * 处理内容选择、格式生成、多文件打包下载
 */
import JSZip from 'jszip';
import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import { sanitizeDownloadFilenameBase } from '@/lib/fileNames';
import type { ExportTranscriptSegment } from './types';
import { exportMarkdown } from './markdown';
import { exportToSrt } from './srt';
import { exportJson } from './json';
import { generateDocx } from './docx';
import { exportPdf } from './pdf';

/** 用户可选择的内容类型 */
export type ContentType = 'transcript' | 'summary' | 'timedSummary' | 'recording';
type TextContentType = Exclude<ContentType, 'recording'>;

/** 支持的导出格式 */
export type ExportFileFormat = 'docx' | 'pdf' | 'md' | 'txt' | 'srt' | 'json';

/** 文档合并模式 */
export type DocumentMode = 'single' | 'separate';

export interface ExportPayload {
  title: string;
  date: string;
  sourceLang: string;
  targetLang: string;
  segments: ExportTranscriptSegment[];
  translations: Record<string, string>;
  summaries: SummarizeResponse[];
  report?: SessionReportData | null;
}

export interface ExportOptions {
  contents: ContentType[];
  format: ExportFileFormat;
  documentMode: DocumentMode;
  payload: ExportPayload;
  /** 录音下载回调，返回 Blob */
  fetchRecording?: () => Promise<Blob | null>;
}

interface GeneratedFile {
  name: string;
  blob: Blob;
}

export interface ExportPlan {
  textContents: TextContentType[];
  includeRecording: boolean;
  textDownloadFileCount: number;
  downloadFileCount: number;
  usesPrintDialog: boolean;
  willZip: boolean;
}

/** 判断所选内容是否需要文本内容（排除纯录音场景） */
export function hasTextContent(contents: ContentType[]): boolean {
  return contents.some((c) => c !== 'recording');
}

/** 判断某个格式是否仅适用于特定内容 */
export function isFormatAvailable(format: ExportFileFormat, contents: ContentType[]): boolean {
  // SRT 只在选了转录文本时可用
  if (format === 'srt') return contents.includes('transcript');
  // 所有其它格式只要有文本内容就可用
  if (format === 'recording' as string) return false;
  return hasTextContent(contents);
}

/** 文本内容数量（用于判断是否需要 single/separate 选择） */
export function textContentCount(contents: ContentType[]): number {
  return contents.filter((c) => c !== 'recording').length;
}

export function normalizeContentsForFormat(
  contents: ContentType[],
  format: ExportFileFormat,
): ContentType[] {
  if (format !== 'srt') {
    return contents;
  }

  return contents.filter((content) => content === 'transcript' || content === 'recording');
}

function getTextContents(contents: ContentType[]): TextContentType[] {
  return contents.filter((content): content is TextContentType => content !== 'recording');
}

export function buildExportPlan(
  contents: ContentType[],
  format: ExportFileFormat,
  documentMode: DocumentMode,
): ExportPlan {
  const normalizedContents = normalizeContentsForFormat(contents, format);
  const textContents = getTextContents(normalizedContents);
  const includeRecording = normalizedContents.includes('recording');

  let textDownloadFileCount = 0;

  if (textContents.length > 0) {
    if (documentMode === 'single' || textContents.length === 1) {
      textDownloadFileCount = 1;
    } else if (format === 'srt') {
      textDownloadFileCount = textContents.includes('transcript') ? 1 : 0;
    } else {
      textDownloadFileCount = textContents.length;
    }
  }

  const downloadFileCount = textDownloadFileCount + (includeRecording ? 1 : 0);

  return {
    textContents,
    includeRecording,
    textDownloadFileCount,
    downloadFileCount,
    usesPrintDialog: false,
    willZip: downloadFileCount >= 2,
  };
}

// ─── Markdown 生成 ───

function generateTranscriptMd(payload: ExportPayload): string {
  const lines: string[] = [`# ${payload.title} - 转录文本\n`];
  for (const seg of payload.segments) {
    lines.push(`**[${seg.speaker}] ${seg.timestamp}**`);
    lines.push(seg.text);
    if (payload.translations[seg.id]) {
      lines.push(`> ${payload.translations[seg.id]}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function generateSummaryMd(payload: ExportPayload): string {
  const lines: string[] = [`# ${payload.title} - 内容总结\n`];

  if (payload.report?.significance?.isWorthSummarizing && payload.report.report) {
    const r = payload.report.report;
    if (r.overview) lines.push(`> ${r.overview}\n`);
    for (const section of r.sections ?? []) {
      lines.push(`## ${section.title}`);
      for (const p of section.points ?? []) lines.push(`- ${p}`);
      lines.push('');
    }
    if (r.conclusions?.length) {
      lines.push('## 结论');
      for (const c of r.conclusions) lines.push(`- ✓ ${c}`);
      lines.push('');
    }
    if (r.actionItems?.length) {
      lines.push('## 待办事项');
      for (const item of r.actionItems) lines.push(`- [ ] ${item}`);
      lines.push('');
    }
    if (r.keyTerms && Object.keys(r.keyTerms).length) {
      lines.push('## 关键术语');
      lines.push('| 术语 | 定义 |');
      lines.push('|------|------|');
      for (const [t, d] of Object.entries(r.keyTerms)) {
        lines.push(`| ${t.replace(/\|/g, '\\|')} | ${d.replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }
  }

  const overallSummaries = payload.summaries.filter((s) => !s.timeRange);
  for (const summary of overallSummaries) {
    if (summary.summary) {
      lines.push(summary.summary);
      lines.push('');
    }
    if (summary.keyPoints?.length) {
      lines.push('## 要点');
      for (const p of summary.keyPoints) lines.push(`- ${p}`);
      lines.push('');
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      lines.push('## 术语');
      lines.push('| 术语 | 定义 |');
      lines.push('|------|------|');
      for (const [term, definition] of Object.entries(summary.definitions)) {
        lines.push(`| ${term.replace(/\|/g, '\\|')} | ${definition.replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }
    if (summary.suggestedQuestions?.length) {
      lines.push('## 复习问题');
      summary.suggestedQuestions.forEach((question, index) => {
        lines.push(`${index + 1}. ${question}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateTimedSummaryMd(payload: ExportPayload): string {
  const timed = payload.summaries.filter((s) => s.timeRange);
  if (timed.length === 0) return '';

  const lines: string[] = [`# ${payload.title} - 分时总结\n`];
  for (const summary of timed) {
    lines.push(`## ⏱ ${summary.timeRange}`);
    if (summary.summary) lines.push(`${summary.summary}\n`);
    if (summary.keyPoints?.length) {
      for (const p of summary.keyPoints) lines.push(`- ${p}`);
      lines.push('');
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      lines.push('### 术语');
      lines.push('| 术语 | 定义 |');
      lines.push('|------|------|');
      for (const [term, definition] of Object.entries(summary.definitions)) {
        lines.push(`| ${term.replace(/\|/g, '\\|')} | ${definition.replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }
    if (summary.suggestedQuestions?.length) {
      lines.push('### 复习问题');
      summary.suggestedQuestions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ─── TXT 生成 ───

function generateTranscriptTxt(payload: ExportPayload): string {
  return payload.segments
    .map((seg) => {
      const translation = payload.translations[seg.id];
      return `[${seg.speaker}] ${seg.timestamp}\n${seg.text}${translation ? `\n${translation}` : ''}`;
    })
    .join('\n\n');
}

function generateSummaryTxt(payload: ExportPayload): string {
  const lines: string[] = [`${payload.title} - 内容总结`, '='.repeat(40), ''];

  if (payload.report?.significance?.isWorthSummarizing && payload.report.report) {
    const r = payload.report.report;
    if (r.overview) lines.push(r.overview, '');
    for (const section of r.sections ?? []) {
      lines.push(section.title, '-'.repeat(20));
      for (const p of section.points ?? []) lines.push(`• ${p}`);
      lines.push('');
    }
    if (r.conclusions?.length) {
      lines.push('结论：');
      for (const conclusion of r.conclusions) lines.push(`• ${conclusion}`);
      lines.push('');
    }
    if (r.actionItems?.length) {
      lines.push('待办事项：');
      for (const actionItem of r.actionItems) lines.push(`□ ${actionItem}`);
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

  const overallSummaries = payload.summaries.filter((s) => !s.timeRange);
  for (const summary of overallSummaries) {
    if (summary.summary) {
      lines.push(summary.summary, '');
    }
    if (summary.keyPoints?.length) {
      lines.push('要点：');
      for (const p of summary.keyPoints) lines.push(`• ${p}`);
      lines.push('');
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      lines.push('术语：');
      for (const [term, definition] of Object.entries(summary.definitions)) {
        lines.push(`${term}: ${definition}`);
      }
      lines.push('');
    }
    if (summary.suggestedQuestions?.length) {
      lines.push('复习问题：');
      summary.suggestedQuestions.forEach((question, index) => {
        lines.push(`${index + 1}. ${question}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateTimedSummaryTxt(payload: ExportPayload): string {
  const timed = payload.summaries.filter((s) => s.timeRange);
  if (timed.length === 0) return '';

  const lines: string[] = [`${payload.title} - 分时总结`, '='.repeat(40), ''];
  for (const summary of timed) {
    lines.push(`[${summary.timeRange}]`);
    if (summary.summary) lines.push(summary.summary);
    if (summary.keyPoints?.length) {
      for (const p of summary.keyPoints) lines.push(`• ${p}`);
    }
    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      lines.push('术语：');
      for (const [term, definition] of Object.entries(summary.definitions)) {
        lines.push(`${term}: ${definition}`);
      }
    }
    if (summary.suggestedQuestions?.length) {
      lines.push('复习问题：');
      summary.suggestedQuestions.forEach((question, index) => {
        lines.push(`${index + 1}. ${question}`);
      });
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── 单一文件格式生成（合并模式） ───

function splitSummariesByType(summaries: ExportPayload['summaries']) {
  return {
    overallSummaries: summaries.filter((summary) => !summary.timeRange),
    timedSummaries: summaries.filter((summary) => summary.timeRange),
  };
}

function buildSingleFilePayload(
  payload: ExportPayload,
  includeTranscript: boolean,
  includeSummary: boolean,
  includeTimedSummary: boolean,
): ExportPayload {
  const { overallSummaries, timedSummaries } = splitSummariesByType(payload.summaries);
  const selectedSummaries = [
    ...(includeSummary ? overallSummaries : []),
    ...(includeTimedSummary ? timedSummaries : []),
  ];

  return {
    ...payload,
    segments: includeTranscript ? payload.segments : [],
    translations: includeTranscript ? payload.translations : {},
    summaries: selectedSummaries,
    report: includeSummary ? payload.report : null,
  };
}

async function generateSingleFile(
  format: ExportFileFormat,
  contents: ContentType[],
  payload: ExportPayload,
): Promise<GeneratedFile> {
  const baseName = sanitizeDownloadFilenameBase(payload.title, 'lecture');
  const includeTranscript = contents.includes('transcript');
  const includeSummary = contents.includes('summary');
  const includeTimedSummary = contents.includes('timedSummary');
  const singleFilePayload = buildSingleFilePayload(
    payload,
    includeTranscript,
    includeSummary,
    includeTimedSummary,
  );

  switch (format) {
    case 'docx': {
      const blob = await generateDocx({
        ...singleFilePayload,
        includeTranscript,
        includeSummary,
        includeTimedSummary,
      });
      return { name: `${baseName}.docx`, blob };
    }

    case 'pdf': {
      const blob = await exportPdf({
        ...singleFilePayload,
        includeTranscript,
        includeSummary,
        includeTimedSummary,
      });
      return { name: `${baseName}.pdf`, blob };
    }

    case 'md': {
      const md = exportMarkdown(
        singleFilePayload.title,
        singleFilePayload.segments,
        singleFilePayload.translations,
        singleFilePayload.summaries,
        singleFilePayload.report,
        singleFilePayload.sourceLang,
        singleFilePayload.targetLang,
        {
          includeTranscriptSection: includeTranscript,
          includeSummarySection: singleFilePayload.summaries.length > 0,
        },
        singleFilePayload.date,
      );
      return {
        name: `${baseName}.md`,
        blob: new Blob([md], { type: 'text/markdown; charset=utf-8' }),
      };
    }

    case 'txt': {
      const parts: string[] = [];
      if (includeSummary) parts.push(generateSummaryTxt(singleFilePayload));
      if (includeTimedSummary) parts.push(generateTimedSummaryTxt(singleFilePayload));
      if (includeTranscript) parts.push(generateTranscriptTxt(singleFilePayload));
      return {
        name: `${baseName}.txt`,
        blob: new Blob([parts.filter(Boolean).join('\n\n')], { type: 'text/plain; charset=utf-8' }),
      };
    }

    case 'srt': {
      const srt = exportToSrt(singleFilePayload.segments, singleFilePayload.translations);
      return {
        name: `${baseName}.srt`,
        blob: new Blob([srt], { type: 'text/srt; charset=utf-8' }),
      };
    }

    case 'json': {
      const json = exportJson(
        singleFilePayload.title,
        singleFilePayload.segments,
        singleFilePayload.translations,
        singleFilePayload.summaries,
        singleFilePayload.sourceLang,
        singleFilePayload.targetLang,
        singleFilePayload.report,
        singleFilePayload.date,
      );
      return {
        name: `${baseName}.json`,
        blob: new Blob([json], { type: 'application/json; charset=utf-8' }),
      };
    }
  }
}

// ─── 多文件格式生成（分开模式） ───

async function generateSeparateFiles(
  format: ExportFileFormat,
  contents: ContentType[],
  payload: ExportPayload,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  const baseName = sanitizeDownloadFilenameBase(payload.title, 'lecture');
  const includeTranscript = contents.includes('transcript');
  const includeSummary = contents.includes('summary');
  const includeTimedSummary = contents.includes('timedSummary');

  switch (format) {
    case 'docx': {
      if (includeTranscript) {
        const blob = await generateDocx({
          ...payload,
          includeTranscript: true,
          includeSummary: false,
          includeTimedSummary: false,
        });
        files.push({ name: `${baseName}_转录.docx`, blob });
      }
      if (includeSummary) {
        const overallSummaries = payload.summaries.filter((s) => !s.timeRange);
        const blob = await generateDocx({
          ...payload,
          segments: [],
          summaries: overallSummaries,
          includeTranscript: false,
          includeSummary: true,
          includeTimedSummary: false,
        });
        files.push({ name: `${baseName}_总结.docx`, blob });
      }
      if (includeTimedSummary) {
        const timedSummaries = payload.summaries.filter((s) => s.timeRange);
        const blob = await generateDocx({
          ...payload,
          segments: [],
          summaries: timedSummaries,
          includeTranscript: false,
          includeSummary: false,
          includeTimedSummary: true,
        });
        files.push({ name: `${baseName}_分时总结.docx`, blob });
      }
      break;
    }

    case 'pdf': {
      if (includeTranscript) {
        const blob = await exportPdf({
          ...payload,
          includeTranscript: true,
          includeSummary: false,
          includeTimedSummary: false,
        });
        files.push({ name: `${baseName}_转录.pdf`, blob });
      }
      if (includeSummary) {
        const overallSummaries = payload.summaries.filter((s) => !s.timeRange);
        const blob = await exportPdf({
          ...payload,
          segments: [],
          summaries: overallSummaries,
          includeTranscript: false,
          includeSummary: true,
          includeTimedSummary: false,
        });
        files.push({ name: `${baseName}_总结.pdf`, blob });
      }
      if (includeTimedSummary) {
        const timedSummaries = payload.summaries.filter((s) => s.timeRange);
        const blob = await exportPdf({
          ...payload,
          segments: [],
          summaries: timedSummaries,
          includeTranscript: false,
          includeSummary: false,
          includeTimedSummary: true,
        });
        files.push({ name: `${baseName}_分时总结.pdf`, blob });
      }
      break;
    }

    case 'md': {
      if (includeTranscript) {
        files.push({
          name: `${baseName}_转录.md`,
          blob: new Blob([generateTranscriptMd(payload)], { type: 'text/markdown; charset=utf-8' }),
        });
      }
      if (includeSummary) {
        files.push({
          name: `${baseName}_总结.md`,
          blob: new Blob([generateSummaryMd(payload)], { type: 'text/markdown; charset=utf-8' }),
        });
      }
      if (includeTimedSummary) {
        const content = generateTimedSummaryMd(payload);
        if (content) {
          files.push({
            name: `${baseName}_分时总结.md`,
            blob: new Blob([content], { type: 'text/markdown; charset=utf-8' }),
          });
        }
      }
      break;
    }

    case 'txt': {
      if (includeTranscript) {
        files.push({
          name: `${baseName}_转录.txt`,
          blob: new Blob([generateTranscriptTxt(payload)], { type: 'text/plain; charset=utf-8' }),
        });
      }
      if (includeSummary) {
        files.push({
          name: `${baseName}_总结.txt`,
          blob: new Blob([generateSummaryTxt(payload)], { type: 'text/plain; charset=utf-8' }),
        });
      }
      if (includeTimedSummary) {
        const content = generateTimedSummaryTxt(payload);
        if (content) {
          files.push({
            name: `${baseName}_分时总结.txt`,
            blob: new Blob([content], { type: 'text/plain; charset=utf-8' }),
          });
        }
      }
      break;
    }

    case 'srt': {
      // SRT 只有转录
      if (includeTranscript) {
        const srt = exportToSrt(payload.segments, payload.translations);
        files.push({
          name: `${baseName}.srt`,
          blob: new Blob([srt], { type: 'text/srt; charset=utf-8' }),
        });
      }
      break;
    }

    case 'json': {
      if (includeTranscript) {
        const json = exportJson(
          `${payload.title} - 转录`,
          payload.segments,
          payload.translations,
          [],
          payload.sourceLang,
          payload.targetLang,
          undefined,
          payload.date,
        );
        files.push({
          name: `${baseName}_转录.json`,
          blob: new Blob([json], { type: 'application/json; charset=utf-8' }),
        });
      }
      if (includeSummary) {
        const overallSummaries = payload.summaries.filter((s) => !s.timeRange);
        const json = exportJson(
          `${payload.title} - 总结`,
          [],
          {},
          overallSummaries,
          payload.sourceLang,
          payload.targetLang,
          payload.report,
          payload.date,
        );
        files.push({
          name: `${baseName}_总结.json`,
          blob: new Blob([json], { type: 'application/json; charset=utf-8' }),
        });
      }
      if (includeTimedSummary) {
        const timedSummaries = payload.summaries.filter((s) => s.timeRange);
        const json = exportJson(
          `${payload.title} - 分时总结`,
          [],
          {},
          timedSummaries,
          payload.sourceLang,
          payload.targetLang,
          undefined,
          payload.date,
        );
        files.push({
          name: `${baseName}_分时总结.json`,
          blob: new Blob([json], { type: 'application/json; charset=utf-8' }),
        });
      }
      break;
    }
  }

  return files;
}

// ─── 触发文件下载 ───

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function bundleAsZip(files: GeneratedFile[], zipName: string): Promise<void> {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, file.blob);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(zipBlob, zipName);
}

async function resolveRecordingBlob(
  includeRecording: boolean,
  fetchRecording?: () => Promise<Blob | null>,
): Promise<Blob | null> {
  if (!includeRecording) {
    return null;
  }

  if (!fetchRecording) {
    throw new Error('Missing recording fetcher');
  }

  const recordingBlob = await fetchRecording();
  if (!recordingBlob || recordingBlob.size === 0) {
    throw new Error('Recording download failed');
  }

  return recordingBlob;
}

// ─── 主导出函数 ───

export async function executeExport(options: ExportOptions): Promise<void> {
  const { contents, format, documentMode, payload, fetchRecording } = options;
  const normalizedContents = normalizeContentsForFormat(contents, format);
  const plan = buildExportPlan(normalizedContents, format, documentMode);
  const allFiles: GeneratedFile[] = [];
  const safeBaseName = sanitizeDownloadFilenameBase(payload.title, 'lecture');

  // 并行执行：文本文件生成 + 录音下载
  const textFilesPromise = (async () => {
    if (plan.textContents.length === 0) return;
    if (documentMode === 'single' || plan.textContents.length === 1) {
      const file = await generateSingleFile(format, plan.textContents, payload);
      if (file.name) allFiles.push(file);
    } else {
      const files = await generateSeparateFiles(format, plan.textContents, payload);
      allFiles.push(...files);
    }
  })();

  const [recordingBlob] = await Promise.all([
    resolveRecordingBlob(plan.includeRecording, fetchRecording),
    textFilesPromise,
  ]);

  // 获取录音文件
  if (recordingBlob) {
    const ext = recordingBlob.type.includes('webm') ? 'webm'
      : recordingBlob.type.includes('mp4') ? 'mp4'
      : recordingBlob.type.includes('ogg') ? 'ogg'
      : 'webm';
    allFiles.push({
      name: `${safeBaseName}_录音.${ext}`,
      blob: recordingBlob,
    });
  }

  // 3. 下载
  if (allFiles.length === 0) {
    throw new Error('No export files generated');
  }

  if (!plan.willZip && allFiles.length === 1) {
    triggerDownload(allFiles[0].blob, allFiles[0].name);
  } else {
    await bundleAsZip(allFiles, `${safeBaseName}_导出.zip`);
  }
}
