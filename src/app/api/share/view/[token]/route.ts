import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sanitizeToken } from '@/lib/security';

const LIVE_VIEWABLE_STATUSES = new Set([
  'CREATED',
  'RECORDING',
  'PAUSED',
  'FINALIZING',
  'COMPLETED',
]);

// 安全：为公开分享 API 响应添加防缓存和安全 headers
function secureResponse(body: unknown, init?: ResponseInit) {
  const res = NextResponse.json(body, init);
  // 禁止缓存：防止代理或浏览器缓存分享数据
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.headers.set('Pragma', 'no-cache');
  // 防止 MIME 嗅探
  res.headers.set('X-Content-Type-Options', 'nosniff');
  // 安全：防止 share token 通过 Referer header 泄露
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: rawToken } = await params;
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:view',
    limit: 120,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  let token: string;
  try {
    token = sanitizeToken(rawToken);
  } catch {
    // 安全：不暴露 token 格式细节
    return secureResponse(
      { error: 'Invalid share token' },
      { status: 400 }
    );
  }

  // 安全：token 长度限制防止超长查询攻击
  if (token.length > 128) {
    return secureResponse(
      { error: 'Invalid share token' },
      { status: 400 }
    );
  }

  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      session: {
        select: {
          // 安全：只选择必要的公开字段，不暴露 userId、路径等敏感信息
          id: true,
          title: true,
          sourceLang: true,
          targetLang: true,
          status: true,
          createdAt: true,
          durationMs: true,
        },
      },
    },
  });

  if (!link) {
    // 安全：对不存在和过期的 token 返回相同错误，防止枚举
    return secureResponse(
      { error: 'Share link not found or expired' },
      { status: 404 }
    );
  }

  // 已完成的会话：即使分享链接已标记为非活跃（录音结束自动关闭），仍允许访问
  const isCompletedSession = link.session.status === 'COMPLETED';

  if (!isCompletedSession) {
    // 安全：对不存在、已禁用、已过期的 token 统一返回 404，防止状态枚举
    if (!link.isLive) {
      return secureResponse(
        { error: 'Share link not found or expired' },
        { status: 404 }
      );
    }

    if (link.expiresAt && link.expiresAt < new Date()) {
      return secureResponse(
        { error: 'Share link not found or expired' },
        { status: 404 }
      );
    }

    if (!LIVE_VIEWABLE_STATUSES.has(link.session.status)) {
      return secureResponse(
        { error: 'Session is not available for live viewing' },
        { status: 409 }
      );
    }
  }

  return secureResponse({
    sessionId: link.sessionId,
    session: link.session,
    isLive: link.isLive,
  });
}
