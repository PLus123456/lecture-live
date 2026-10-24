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
import { SESSION_TRANSCRIPT_LIMITS } from '@/lib/sessionApi';

const MAX_SEGMENTS = 50_000;
// 导出请求体是纯文本 JSON（segments + translations + summaries），导出的就是一场会话的
// 转录产物，而产物本身落盘上限是 SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes（8MB）——
// 合法请求不可能更大。此前是 64MB：限流（30 次 / 10 分钟）在读 body 之前就放行，一个用户
// 并发 30 个 64MB 请求，缓冲 + 解码 + JSON.parse 的峰值足以把 Next 进程顶到 OOM。
// 这里给信封（标题/语言等）留 1MB 余量。精确的段数校验仍在下方。
// 注意：route.ts 只能导出路由处理器/路由配置字段（next build 会校验），常量不导出。
const ABSOLUTE_MAX_BODY_BYTES =
  SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes + 1024 * 1024;

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
