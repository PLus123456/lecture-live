import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sanitizeToken } from '@/lib/security';
import { loadSessionAudioArtifact } from '@/lib/sessionPersistence';

const PLAYBACK_STATUSES = new Set(['COMPLETED', 'ARCHIVED']);

// 公开 API：通过分享 token 获取已完成会话的音频（无需认证）
// 严格限流防止流量滥用
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: rawToken } = await params;

  // 严格限流：10 次 / 10 分钟 / IP — 防止被刷流量
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:view:audio',
    limit: 10,
    windowMs: 10 * 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  let token: string;
  try {
    token = sanitizeToken(rawToken);
  } catch {
    return Response.json(
      { error: 'Invalid share token' },
      { status: 400, headers: secureHeaders() }
    );
  }

  if (token.length > 128) {
    return Response.json(
      { error: 'Invalid share token' },
      { status: 400, headers: secureHeaders() }
    );
  }

  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      session: {
        select: {
          id: true,
          userId: true,
          status: true,
          recordingPath: true,
          transcriptPath: true,
          summaryPath: true,
        },
      },
    },
  });

  if (!link || (link.expiresAt && link.expiresAt < new Date())) {
    return Response.json(
      { error: 'Share link not found or expired' },
      { status: 404, headers: secureHeaders() }
    );
  }

  // 只有已完成/已归档的会话才能通过此接口获取音频
  if (!PLAYBACK_STATUSES.has(link.session.status)) {
    return Response.json(
      { error: 'Session is not completed yet' },
      { status: 409, headers: secureHeaders() }
    );
  }

  try {
    const artifact = await loadSessionAudioArtifact(link.session);
    if (!artifact) {
      return Response.json(
        { error: 'Audio not found' },
        { status: 404, headers: secureHeaders() }
      );
    }

    const data = artifact.data;
    const totalSize = data.length;

    // 支持 Range 请求（音频流式播放）
    const range = req.headers.get('range');
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const rawEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const end = Math.min(rawEnd, totalSize - 1);
        if (
          Number.isNaN(start) ||
          Number.isNaN(end) ||
          start < 0 ||
          end < start ||
          start >= totalSize
        ) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }

        const chunk = data.subarray(start, end + 1);
        return new Response(new Uint8Array(chunk), {
          status: 206,
          headers: {
            'Content-Type': artifact.contentType,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': String(chunk.length),
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          },
        });
      }
    }

    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': artifact.contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    console.error('Share audio load error:', error);
    return Response.json(
      { error: 'Audio not found' },
      { status: 404, headers: secureHeaders() }
    );
  }
}

function secureHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
