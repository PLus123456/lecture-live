import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { exportToMarkdown } from '@/lib/export/markdown';
import { exportToSrt } from '@/lib/export/srt';
import { exportToJson } from '@/lib/export/json';
import { exportToTxt } from '@/lib/export/txt';
import { toExportSegments } from '@/lib/export/types';
import {
  parseExportFormat,
  sanitizeHeaderFilename,
  sanitizeTextInput,
} from '@/lib/security';
import { parseJsonWithLimit } from '@/lib/requestBodyLimit';

const MAX_SEGMENTS = 50_000;
// 导出请求体是纯文本 JSON（segments + translations + summaries）。MAX_SEGMENTS=50k
// 配上每段文本，合理上限在几十 MB；这里用 64MB 绝对硬上限做 OOM 兜底，挡掉在
// req.json() 把整个 body 缓冲进内存之前的明显超大请求。精确的段数校验仍在下方。
const ABSOLUTE_MAX_BODY_BYTES = 64 * 1024 * 1024;

interface ExportRequestBody {
  format: 'markdown' | 'srt' | 'json' | 'txt';
  title: string;
  date: string;
  sourceLang: string;
  targetLang: string;
  segments: unknown[];
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

  const rateLimited = await enforceRateLimit(req, {
    scope: 'export',
    limit: 30,
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // L58：body 上限必须靠**流式累计字节**，不能只看声明长度。
  // 旧写法 `Number(req.headers.get('content-length') ?? '')` 在 chunked 请求（无该头）
  // 下得 0 —— `Number.isFinite(0)` 为真、`0 > 64MB` 为假 → 预检整段被跳过，随后
  // `req.json()` 把任意大的 body 缓冲进内存。这里改为读一块记一块，越线立刻断流。
  const parsedBody = await parseJsonWithLimit<ExportRequestBody>(
    req,
    ABSOLUTE_MAX_BODY_BYTES,
  );
  if (!parsedBody.ok) {
    return parsedBody.reason === 'too-large'
      ? NextResponse.json({ error: 'Request body too large' }, { status: 413 })
      : NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const body: ExportRequestBody = parsedBody.value;
    if (Array.isArray(body.segments) && body.segments.length > MAX_SEGMENTS) {
      return NextResponse.json(
        { error: `Too many segments (max ${MAX_SEGMENTS})` },
        { status: 400 },
      );
    }
    const format = parseExportFormat(body.format);
    const title = sanitizeTextInput(body.title, {
      maxLength: 120,
      fallback: 'Lecture Recording',
    });
    const safeFilenameBase = sanitizeHeaderFilename(title, 'lecture-recording');
    const segments = toExportSegments(Array.isArray(body.segments) ? body.segments : []);
    let content: string;
    let filename: string;
    let mimeType: string;

    switch (format) {
      case 'markdown':
        content = exportToMarkdown(
          title, body.date, body.sourceLang, body.targetLang,
          segments, body.translations, body.summaries
        );
        filename = `${safeFilenameBase}.md`;
        mimeType = 'text/markdown';
        break;

      case 'srt':
        content = exportToSrt(segments, body.translations);
        filename = `${safeFilenameBase}.srt`;
        mimeType = 'text/plain';
        break;

      case 'json':
        content = exportToJson(
          title, body.date, segments, body.translations, body.summaries, body.sourceLang, body.targetLang
        );
        filename = `${safeFilenameBase}.json`;
        mimeType = 'application/json';
        break;

      case 'txt':
        content = exportToTxt(title, segments, body.translations, body.summaries);
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
