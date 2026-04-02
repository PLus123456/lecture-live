import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { loadSessionTranscriptBundle, loadSessionReport } from '@/lib/sessionPersistence';
import { summaryBlockToResponse } from '@/lib/summary';
import type { SummaryBlock, SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';

/**
 * GET /api/sessions/[id]/export-data
 * 返回会话的原始导出数据（segment、translation、summary、report）
 * 供客户端导出使用
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const persisted = await loadSessionTranscriptBundle(session);
  const segments = Array.isArray(persisted?.segments) ? persisted.segments : [];
  const translations = (persisted?.translations ?? {}) as Record<string, string>;
  const rawSummaries = Array.isArray(persisted?.summaries) ? persisted.summaries : [];

  // 将 SummaryBlock 转换为 SummarizeResponse
  const summaries: SummarizeResponse[] = rawSummaries
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((s) => {
      if (isSummaryBlock(s)) return summaryBlockToResponse(s);
      return s as unknown as SummarizeResponse;
    });

  let report: SessionReportData | null = null;
  try {
    report = (await loadSessionReport(session)) as SessionReportData | null;
  } catch {
    // 报告不存在不影响导出
  }

  return NextResponse.json({
    segments,
    translations,
    summaries,
    report,
    hasRecording: Boolean(session.recordingPath),
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
