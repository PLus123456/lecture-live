// POST /api/llm/report — 录音结束后生成结构化会议报告
// 包含意义评估 + 报告生成，结果持久化到文件系统

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership } from '@/lib/security';
import { callLLM } from '@/lib/llm/gateway';
import { enforceRateLimit } from '@/lib/rateLimit';
import { generateSessionReport } from '@/lib/llm/reportManager';
import {
  extractTranscriptText,
  loadSessionTranscriptBundle,
  persistSessionReport,
  loadSessionReport,
} from '@/lib/sessionPersistence';
import type { SummaryBlock } from '@/types/summary';

export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'llm:report',
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimited) return rateLimited;

  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { sessionId } = await req.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    try {
      assertOwnership(user.id, session.userId);
    } catch {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // 加载转录数据
    const bundle = await loadSessionTranscriptBundle(session);
    if (!bundle || bundle.segments.length === 0) {
      return NextResponse.json(
        { error: 'No transcript data available' },
        { status: 400 }
      );
    }

    const fullTranscript = extractTranscriptText(bundle);
    const summaryBlocks = (bundle.summaries ?? []) as SummaryBlock[];

    // 生成报告（包含意义评估）
    const reportData = await generateSessionReport({
      sessionId,
      transcript: fullTranscript,
      sessionTitle: session.title,
      courseName: session.courseName ?? '',
      durationMs: session.durationMs,
      date: session.createdAt.toISOString().split('T')[0],
      summaryBlocks,
      language: session.targetLang || 'zh',
      callLLM: (system: string, userMsg: string) =>
        callLLM(system, userMsg, { purpose: 'FINAL_SUMMARY' }),
    });

    // 持久化报告
    const stored = await persistSessionReport(session, reportData);
    await prisma.session.update({
      where: { id: sessionId },
      data: { reportPath: stored.path },
    });
    await invalidateSessionsApiCache(user.id);

    return NextResponse.json({
      success: true,
      reportPath: stored.path,
      significance: reportData.significance,
      hasReport: reportData.report !== null,
    });
  } catch (error) {
    console.error('Report generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 }
    );
  }
}

// GET /api/llm/report?sessionId=xxx — 获取已生成的报告
export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const report = await loadSessionReport(session);
  if (!report) {
    return NextResponse.json({ report: null });
  }

  return NextResponse.json({ report });
}
