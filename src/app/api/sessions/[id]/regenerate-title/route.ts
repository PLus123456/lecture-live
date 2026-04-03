// POST /api/sessions/:id/regenerate-title — 手动重新生成会话标题（中英文）

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership } from '@/lib/security';
import { callLLM } from '@/lib/llm/gateway';
import { enforceRateLimit } from '@/lib/rateLimit';
import { generateSessionTitle } from '@/lib/llm/reportManager';
import { trackJob, JOB_TYPE } from '@/lib/jobQueue';
import {
  extractTranscriptText,
  loadSessionTranscriptBundle,
} from '@/lib/sessionPersistence';
import type { SummaryBlock } from '@/types/summary';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { id: sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  try {
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
    if (fullTranscript.trim().length < 50) {
      return NextResponse.json(
        { error: 'Transcript too short for title generation' },
        { status: 400 }
      );
    }

    const summaryBlocks = (bundle.summaries ?? []) as SummaryBlock[];

    // 通过 trackJob 追踪，队列面板可见
    const result = await trackJob(
      {
        type: JOB_TYPE.TITLE_GENERATION,
        sessionId,
        userId: user.id,
        triggeredBy: `user:${user.id}`,
        params: { originalTitle: session.title },
      },
      async () => {
        const generated = await generateSessionTitle({
          transcript: fullTranscript,
          summaryBlocks,
          courseName: session.courseName ?? '',
          language: session.targetLang || 'zh',
          callLLM: (system: string, userMsg: string) =>
            callLLM(system, userMsg, { purpose: 'FINAL_SUMMARY' }),
        });

        if (!generated) {
          throw new Error('Title generation returned no result');
        }

        await prisma.session.update({
          where: { id: sessionId },
          data: { title: generated.zh, titleEn: generated.en },
        });

        return { zh: generated.zh, en: generated.en };
      }
    );

    await invalidateSessionsApiCache(user.id);

    return NextResponse.json({
      success: true,
      title: result.zh,
      titleEn: result.en,
    });
  } catch (error) {
    console.error('Title regeneration error:', error);
    return NextResponse.json(
      { error: 'Failed to regenerate title' },
      { status: 500 }
    );
  }
}
