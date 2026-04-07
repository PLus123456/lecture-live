import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sanitizeToken } from '@/lib/security';
import { loadSessionTranscriptBundle, loadSessionReport } from '@/lib/sessionPersistence';
import { summaryBlockToResponse } from '@/lib/summary';
import { toExportSegments } from '@/lib/export/types';
import type { SummaryBlock, SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';

const PLAYBACK_STATUSES = new Set(['COMPLETED', 'ARCHIVED']);

function secureResponse(body: unknown, init?: ResponseInit) {
  const res = NextResponse.json(body, init);
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.headers.set('Pragma', 'no-cache');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

// 公开 API：通过分享 token 获取导出数据（无需认证）
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: rawToken } = await params;
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:view:export-data',
    limit: 20,
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
          title: true,
          sourceLang: true,
          targetLang: true,
          createdAt: true,
          transcriptPath: true,
          summaryPath: true,
          reportPath: true,
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

  if (!PLAYBACK_STATUSES.has(link.session.status)) {
    return secureResponse(
      { error: 'Session is not completed yet' },
      { status: 409 }
    );
  }

  const persisted = await loadSessionTranscriptBundle(link.session);
  const rawSegments = Array.isArray(persisted?.segments) ? persisted.segments : [];
  const segments = toExportSegments(rawSegments);
  const translations = (persisted?.translations ?? {}) as Record<string, string>;
  const rawSummaries = Array.isArray(persisted?.summaries) ? persisted.summaries : [];

  const summaries: SummarizeResponse[] = rawSummaries
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((s) => {
      if (isSummaryBlock(s)) return summaryBlockToResponse(s);
      return s as unknown as SummarizeResponse;
    });

  let report: SessionReportData | null = null;
  try {
    report = (await loadSessionReport(link.session)) as SessionReportData | null;
  } catch {
    // 报告不存在不影响导出
  }

  // 安全：不暴露 userId、路径等敏感字段
  return secureResponse({
    title: link.session.title,
    date: link.session.createdAt.toISOString(),
    sourceLang: link.session.sourceLang,
    targetLang: link.session.targetLang,
    segments,
    translations,
    summaries,
    report,
    hasRecording: Boolean(link.session.recordingPath),
  });
}

function isSummaryBlock(value: unknown): value is SummaryBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const timeRange = v.timeRange;
  return (
    typeof v.id === 'string' &&
    typeof v.blockIndex === 'number' &&
    Boolean(timeRange) &&
    typeof timeRange === 'object' &&
    typeof (timeRange as Record<string, unknown>).startMs === 'number' &&
    typeof (timeRange as Record<string, unknown>).endMs === 'number'
  );
}
