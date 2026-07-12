import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertSessionReadAccess } from '@/lib/security';
import { withRequestLogging } from '@/lib/requestLogger';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveUserFeatureFlags } from '@/lib/userRoles';
import { getEnhanceWorkerConfig } from '@/lib/audio/enhanceWorkerClient';
import { runAudioEnhanceTick } from '@/lib/audio/enhanceProcessor';

// 音频增强状态查询（回放页轮询）。与异步文件转录同惯例：前端轮询顺便驱动后端状态机
// 推进一轮（fire-and-forget），即使 ws 进程的周期 loop 不在也能走完整个流程。
export const GET = withRequestLogging(
  'sessions:enhance-status',
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await verifyAuth(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimited = await enforceRateLimit(req, {
      scope: 'sessions:enhance-status',
      limit: 120,
      windowMs: 10 * 60_000,
      key: `user:${user.id}`,
    });
    if (rateLimited) {
      return rateLimited;
    }

    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        recordingPath: true,
        enhancedAudioPath: true,
        audioEnhanceStatus: true,
        audioEnhanceError: true,
        status: true,
      },
    });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    try {
      assertSessionReadAccess(user, session.userId);
    } catch {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // 进行中则顺手推进一轮状态机（含派发/对账/收割），加速完成
    if (
      session.audioEnhanceStatus === 'pending' ||
      session.audioEnhanceStatus === 'processing'
    ) {
      void runAudioEnhanceTick();
    }

    // available：当前用户能否对该会话发起增强（回放页据此显隐入口）
    const config = await getEnhanceWorkerConfig();
    let available = false;
    if (config && session.recordingPath) {
      const owner = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { role: true, customGroupId: true },
      });
      const flags = owner ? await resolveUserFeatureFlags(owner) : null;
      available = Boolean(flags?.allowAudioEnhance);
    }

    return NextResponse.json({
      status: session.audioEnhanceStatus,
      error: session.audioEnhanceError,
      enhancedAudioReady: Boolean(session.enhancedAudioPath),
      available,
    });
  }
);
