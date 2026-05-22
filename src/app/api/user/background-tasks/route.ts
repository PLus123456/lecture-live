import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withRequestLogging } from '@/lib/requestLogger';
import { JOB_STATUS } from '@/lib/jobQueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 主页"New Session"按钮旁的小指示器，让用户实时看到后台正在跑什么。
// 汇总三类来源：JobQueue（生成报告/标题等）、Session.FINALIZING、文件转录 async pipeline。
const ACTIVE_ASYNC_STATUSES = [
  'uploading_chunks',
  'transcoding',
  'uploading_to_soniox',
  'transcribing',
  'finalizing',
] as const;

const ACTIVE_JOB_STATUSES = [JOB_STATUS.SUBMITTED, JOB_STATUS.PROCESSING];

export const GET = withRequestLogging('user:background-tasks', async (req: Request) => {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 客户端会轮询（活跃 10s / 闲置 30s），限流防滥用
  const rateLimited = await enforceRateLimit(req, {
    scope: 'user:background-tasks',
    limit: 120,
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

  const [jobs, finalizingSessions, asyncSessions] = await Promise.all([
    prisma.jobQueue.findMany({
      where: {
        userId: user.id,
        status: { in: ACTIVE_JOB_STATUSES },
      },
      select: {
        id: true,
        type: true,
        status: true,
        sessionId: true,
        createdAt: true,
        startedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.session.findMany({
      where: { userId: user.id, status: 'FINALIZING' },
      select: { id: true, title: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.session.findMany({
      where: {
        userId: user.id,
        asyncTranscribeStatus: { in: [...ACTIVE_ASYNC_STATUSES] },
      },
      select: {
        id: true,
        title: true,
        asyncTranscribeStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  const jobSessionIds = Array.from(
    new Set(jobs.map((j) => j.sessionId).filter((id): id is string => Boolean(id))),
  );
  const sessionTitles: Record<string, string> = {};
  if (jobSessionIds.length > 0) {
    const linkedSessions = await prisma.session.findMany({
      where: { id: { in: jobSessionIds }, userId: user.id },
      select: { id: true, title: true },
    });
    for (const s of linkedSessions) {
      sessionTitles[s.id] = s.title;
    }
  }

  const jobsWithTitle = jobs.map((j) => ({
    ...j,
    sessionTitle: j.sessionId ? sessionTitles[j.sessionId] ?? null : null,
  }));

  const totalCount = jobs.length + finalizingSessions.length + asyncSessions.length;
  const response = NextResponse.json({
    jobs: jobsWithTitle,
    finalizingSessions,
    asyncTranscribingSessions: asyncSessions,
    hasActiveTasks: totalCount > 0,
    totalCount,
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
