import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sanitizeToken } from '@/lib/security';
import { loadSessionTranscriptBundle } from '@/lib/sessionPersistence';

// 安全：为公开分享 API 响应添加防缓存和安全 headers
function secureResponse(body: unknown, init?: ResponseInit) {
  const res = NextResponse.json(body, init);
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.headers.set('Pragma', 'no-cache');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  // 安全：防止 share token 通过 Referer header 泄露
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

// 公开 API：通过分享 token 获取已完成会话的转录数据（无需认证）
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: rawToken } = await params;
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:view:transcript',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  let token: string;
  try {
    token = sanitizeToken(rawToken);
  } catch {
    return secureResponse({ error: 'Invalid share token' }, { status: 400 });
  }

  if (token.length > 128) {
    return secureResponse({ error: 'Invalid share token' }, { status: 400 });
  }

  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      session: {
        select: {
          id: true,
          userId: true,
          status: true,
          transcriptPath: true,
          summaryPath: true,
          recordingPath: true,
        },
      },
    },
  });

  if (!link || (link.expiresAt && link.expiresAt < new Date())) {
    return secureResponse(
      { error: 'Share link not found or expired' },
      { status: 404 }
    );
  }

  // 只有已完成/已归档的会话才能通过此接口获取转录数据
  const isPlaybackReady =
    link.session.status === 'COMPLETED' || link.session.status === 'ARCHIVED';
  if (!isPlaybackReady) {
    // 未完成的会话仍需检查 isLive
    if (!link.isLive) {
      return secureResponse(
        { error: 'Share link not found or expired' },
        { status: 404 }
      );
    }

    return secureResponse(
      { error: 'Session is not completed yet' },
      { status: 409 }
    );
  }

  // 已完成的会话：即使链接已标记为非活跃也允许访问转录数据

  try {
    const data = await loadSessionTranscriptBundle(link.session);
    if (!data) {
      return secureResponse({ segments: [], summaries: [], translations: {} });
    }
    // 安全：只返回文本数据，不包含任何路径信息
    return secureResponse({
      segments: data.segments,
      summaries: data.summaries,
      translations: data.translations,
    });
  } catch (error) {
    console.error('Load share transcript error:', error);
    return secureResponse({ segments: [], summaries: [], translations: {} });
  }
}
