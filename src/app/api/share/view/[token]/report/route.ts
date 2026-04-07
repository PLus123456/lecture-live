import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sanitizeToken } from '@/lib/security';
import { loadSessionReport } from '@/lib/sessionPersistence';

const PLAYBACK_STATUSES = new Set(['COMPLETED', 'ARCHIVED']);

function secureResponse(body: unknown, init?: ResponseInit) {
  const res = NextResponse.json(body, init);
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.headers.set('Pragma', 'no-cache');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

// 公开 API：通过分享 token 获取已完成会话的报告（无需认证）
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: rawToken } = await params;
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:view:report',
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
          reportPath: true,
          recordingPath: true,
          transcriptPath: true,
          summaryPath: true,
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

  if (!PLAYBACK_STATUSES.has(link.session.status)) {
    return secureResponse(
      { error: 'Session is not completed yet' },
      { status: 409 }
    );
  }

  try {
    const report = await loadSessionReport(link.session);
    return secureResponse({ report: report ?? null });
  } catch (error) {
    console.error('Share report load error:', error);
    return secureResponse({ report: null });
  }
}
