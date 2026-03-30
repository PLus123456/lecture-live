import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership, sanitizeHeaderFilename } from '@/lib/security';
import { exportMarkdown } from '@/lib/export/markdown';
import { exportToSrt } from '@/lib/export/srt';
import { exportJson } from '@/lib/export/json';
import { normalizeExportFormat } from '@/lib/sessionApi';
import { loadSessionTranscriptBundle, loadSessionReport } from '@/lib/sessionPersistence';
import { summaryBlockToResponse } from '@/lib/summary';
import type { ExportTranscriptSegment } from '@/lib/export/types';
import type { SummaryBlock, SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
  });

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const format = normalizeExportFormat(body.format);
  const sourceLang = typeof body.sourceLang === 'string' ? body.sourceLang : (session.sourceLang ?? 'en');
  const targetLang = typeof body.targetLang === 'string' ? body.targetLang : (session.targetLang ?? 'zh');
  if (!format) {
    return NextResponse.json(
      { error: 'Unsupported format' },
      { status: 400 }
    );
  }

  const persisted = await loadSessionTranscriptBundle(session);
  const segments = toExportSegments(
    Array.isArray(body.segments) ? body.segments : persisted?.segments ?? []
  );
  const translations = toStringRecord(
    isPlainObject(body.translations)
      ? body.translations
      : persisted?.translations ?? {}
  );
  const summaries = normalizeSummaries(
    Array.isArray(body.summaries) ? body.summaries : persisted?.summaries ?? []
  );

  // 加载会话报告（用于 Markdown 导出）
  let report: SessionReportData | null = null;
  try {
    report = (await loadSessionReport(session)) as SessionReportData | null;
  } catch {
    // 报告加载失败不影响导出
  }

  if (segments.length === 0) {
    return NextResponse.json(
      { error: 'No transcript data available to export' },
      { status: 409 }
    );
  }

  let content: string;
  let contentType: string;
  const safeBase = sanitizeHeaderFilename(session.title, 'lecture-recording');

  switch (format) {
    case 'markdown':
      content = exportMarkdown(session.title, segments, translations, summaries, report, sourceLang, targetLang);
      contentType = 'text/markdown; charset=utf-8';
      break;
    case 'srt':
      content = exportToSrt(segments, translations);
      contentType = 'text/srt; charset=utf-8';
      break;
    case 'json':
      content = exportJson(session.title, segments, translations, summaries, sourceLang, targetLang);
      contentType = 'application/json; charset=utf-8';
      break;
    case 'txt':
      content = segments
        .map((segment) => {
          const translation = translations[segment.id];
          return `[${segment.speaker}] ${segment.timestamp}\n${segment.text}${
            translation ? `\n${translation}` : ''
          }`;
        })
        .join('\n\n');
      contentType = 'text/plain; charset=utf-8';
      break;
    default:
      return NextResponse.json(
        { error: 'Unsupported format' },
        { status: 400 }
      );
  }

  const ext = format === 'markdown' ? 'md' : format;
  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(`${safeBase}.${ext}`)}"`,
    },
  });
}

function toExportSegments(input: unknown[]): ExportTranscriptSegment[] {
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

function normalizeSummaries(input: unknown[]): SummarizeResponse[] {
  return input
    .filter(isPlainObject)
    .map((summary) => {
      if (isSummaryBlock(summary)) {
        return summaryBlockToResponse(summary);
      }

      return {
        keyPoints: Array.isArray(summary.keyPoints)
          ? summary.keyPoints.filter((entry): entry is string => typeof entry === 'string')
          : [],
        definitions: toStringRecord(summary.definitions),
        summary: typeof summary.summary === 'string' ? summary.summary : undefined,
        suggestedQuestions: Array.isArray(summary.suggestedQuestions)
          ? summary.suggestedQuestions.filter(
              (entry): entry is string => typeof entry === 'string'
            )
          : undefined,
        timeRange: typeof summary.timeRange === 'string' ? summary.timeRange : undefined,
        timestamp: typeof summary.timestamp === 'number' ? summary.timestamp : Date.now(),
      };
    });
}

function isSummaryBlock(value: unknown): value is SummaryBlock {
  if (!isPlainObject(value)) {
    return false;
  }

  const timeRange = value.timeRange;
  return (
    typeof value.id === 'string' &&
    typeof value.blockIndex === 'number' &&
    isPlainObject(timeRange) &&
    typeof timeRange.startMs === 'number' &&
    typeof timeRange.endMs === 'number'
  );
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === 'string')
      .map(([key, entry]) => [key, entry as string])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
