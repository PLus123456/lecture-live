import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { exportToMarkdown } from '@/lib/export/markdown';
import { exportToSrt } from '@/lib/export/srt';
import { exportToJson } from '@/lib/export/json';
import type { ExportTranscriptSegment } from '@/lib/export/types';
import {
  parseExportFormat,
  sanitizeHeaderFilename,
  sanitizeTextInput,
} from '@/lib/security';

interface ExportRequestBody {
  format: 'markdown' | 'srt' | 'json' | 'txt';
  title: string;
  date: string;
  sourceLang: string;
  targetLang: string;
  segments: ExportTranscriptSegment[];
  translations: Record<string, string>;
  summaries: Array<{
    keyPoints: string[];
    definitions?: Record<string, string>;
    summary?: string;
    suggestedQuestions?: string[];
    timeRange?: string;
    timestamp: number;
  }>;
}

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body: ExportRequestBody = await req.json();
    const format = parseExportFormat(body.format);
    const title = sanitizeTextInput(body.title, {
      maxLength: 120,
      fallback: 'Lecture Recording',
    });
    const safeFilenameBase = sanitizeHeaderFilename(title, 'lecture-recording');
    let content: string;
    let filename: string;
    let mimeType: string;

    switch (format) {
      case 'markdown':
        content = exportToMarkdown(
          title, body.date, body.sourceLang, body.targetLang,
          body.segments, body.translations, body.summaries
        );
        filename = `${safeFilenameBase}.md`;
        mimeType = 'text/markdown';
        break;

      case 'srt':
        content = exportToSrt(body.segments, body.translations);
        filename = `${safeFilenameBase}.srt`;
        mimeType = 'text/plain';
        break;

      case 'json':
        content = exportToJson(
          title, body.date, body.segments, body.translations, body.summaries
        );
        filename = `${safeFilenameBase}.json`;
        mimeType = 'application/json';
        break;

      case 'txt':
        content = body.segments.map((seg) => {
          const translation = body.translations[seg.id];
          return `[${seg.speaker}] ${seg.timestamp}\n${seg.text}${translation ? `\n${translation}` : ''}`;
        }).join('\n\n');
        filename = `${safeFilenameBase}.txt`;
        mimeType = 'text/plain';
        break;

      default:
        return NextResponse.json({ error: 'Unsupported format' }, { status: 400 });
    }

    return new NextResponse(content, {
      headers: {
        'Content-Type': `${mimeType}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
