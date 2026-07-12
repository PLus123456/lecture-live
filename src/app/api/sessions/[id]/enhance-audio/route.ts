import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { withRequestLogging } from '@/lib/requestLogger';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveUserFeatureFlags } from '@/lib/userRoles';
import { getEnhanceWorkerConfig } from '@/lib/audio/enhanceWorkerClient';
import {
  enqueueAudioEnhance,
  runAudioEnhanceTick,
} from '@/lib/audio/enhanceProcessor';
import { JOB_TYPE, JOB_STATUS } from '@/lib/jobQueue';

// 手动触发录音音频增强（响度归一化 + 降噪，外部 worker 异步处理）。
// 免费增值路径：不扣配额、不预留分钟；重资源消耗由站点开关 + 用户组能力开关双重门禁。
export const POST = withRequestLogging(
  'sessions:enhance-audio',
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await verifyAuth(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimited = await enforceRateLimit(req, {
      scope: 'sessions:enhance-audio',
      limit: 10,
      windowMs: 10 * 60_000,
      key: `user:${user.id}`,
    });
    if (rateLimited) {
      return rateLimited;
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

    // 站点级开关 + worker 配置齐备
    const config = await getEnhanceWorkerConfig();
    if (!config) {
      return NextResponse.json(
        { error: 'Audio enhancement is not enabled on this site' },
        { status: 403 }
      );
    }
    // 用户组能力开关（组配置为唯一真源；缺省禁止）
    const owner = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { role: true, customGroupId: true },
    });
    const flags = owner ? await resolveUserFeatureFlags(owner) : null;
    if (!flags?.allowAudioEnhance) {
      return NextResponse.json(
        { error: 'Your group does not allow audio enhancement' },
        { status: 403 }
      );
    }

    if (session.status !== 'COMPLETED' && session.status !== 'ARCHIVED') {
      return NextResponse.json(
        { error: 'Session must be finalized before enhancing audio' },
        { status: 409 }
      );
    }
    if (!session.recordingPath) {
      return NextResponse.json(
        { error: 'Session has no recording to enhance' },
        { status: 409 }
      );
    }

    // 幂等：已有在途任务直接返回现状（enqueueAudioEnhance 内部同样兜底，这里提早给出准确响应）
    const active = await prisma.jobQueue.findFirst({
      where: {
        type: JOB_TYPE.AUDIO_ENHANCE,
        sessionId: id,
        status: { in: [JOB_STATUS.SUBMITTED, JOB_STATUS.PROCESSING] },
      },
      select: { id: true },
    });
    if (active) {
      return NextResponse.json({
        status: session.audioEnhanceStatus ?? 'pending',
        alreadyRunning: true,
      });
    }

    const jobId = await enqueueAudioEnhance({
      sessionId: id,
      userId: session.userId,
      triggeredBy: user.id === session.userId ? 'user' : `admin:${user.id}`,
    });
    if (!jobId) {
      return NextResponse.json(
        { error: 'Failed to enqueue enhancement job' },
        { status: 500 }
      );
    }

    // 立即踢一次调度（不等 ws 进程的周期 tick），fire-and-forget
    void runAudioEnhanceTick();

    return NextResponse.json({ status: 'pending', jobId });
  }
);
