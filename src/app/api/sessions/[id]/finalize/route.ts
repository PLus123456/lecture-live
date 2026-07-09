import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withRequestLogging } from '@/lib/requestLogger';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { validatePersistedTranscriptBundle } from '@/lib/sessionApi';
import {
  finalizeSession,
  FinalizeSessionError,
} from '@/lib/sessionFinalization';
import { logAction } from '@/lib/auditLog';

export const POST = withRequestLogging(
  'sessions:finalize',
  async (
    req: Request,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;
    const user = await verifyAuth(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 幂等短路：已 COMPLETED/ARCHIVED 的会话跳过按次限流，直接交给 finalizeSession 的
    // alreadyCompleted 早退返回成功（其内部仍做归属校验）。避免 429 风暴冷却期内、合法的
    // 收尾补发（前端 FINALIZING 轮询重试、多标签）被 10/分限流误伤而「收不了尾」。
    const preCheck = await prisma.session.findUnique({
      where: { id },
      select: { status: true },
    });
    const alreadyDone =
      preCheck?.status === 'COMPLETED' || preCheck?.status === 'ARCHIVED';

    if (!alreadyDone) {
      const rateLimited = await enforceRateLimit(req, {
        scope: 'sessions:finalize',
        limit: 10,
        windowMs: 60_000,
        key: `user:${user.id}`,
      });
      if (rateLimited) return rateLimited;
    }

    const { searchParams } = new URL(req.url);
    const finalizeSource =
      searchParams.get('source') === 'unload' ? 'unload' : 'user';

    let clientBundle: ReturnType<typeof validatePersistedTranscriptBundle> = null;
    let clientDurationMs: number | undefined;
    let clientTitle: string | undefined;

    try {
      const body = await req.json();
      clientBundle = validatePersistedTranscriptBundle(body);
      if (typeof body.durationMs === 'number' && body.durationMs > 0) {
        clientDurationMs = body.durationMs;
      }
      if (typeof body.title === 'string' && body.title.trim()) {
        clientTitle = body.title.trim().slice(0, 160);
      }
    } catch {
      // Empty body is allowed. Server-side draft data is the primary source of truth.
    }

    try {
      const result = await finalizeSession({
        sessionId: id,
        actor: user,
        clientBundle,
        clientDurationMs,
        clientTitle,
        allowStatusPromotion: true,
        finalizeSource,
      });

      logAction(req, 'session.finalize', {
        user,
        detail: `${clientTitle || id} (${finalizeSource})`,
      });

      await invalidateSessionsApiCache(user.id);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof FinalizeSessionError) {
        return NextResponse.json(error.body, { status: error.status });
      }

      console.error('Session finalize error:', error);
      return NextResponse.json(
        { error: 'Failed to finalize session' },
        { status: 500 }
      );
    }
  }
);
