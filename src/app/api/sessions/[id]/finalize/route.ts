import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withRequestLogging } from '@/lib/requestLogger';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import {
  admitSessionFinalizePayload,
  readBoundedSessionJson,
  SessionTranscriptPayloadError,
} from '@/lib/sessionApi';
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

    // 幂等短路：已 COMPLETED/ARCHIVED 的会话先在下方做归属校验，然后
    // 直接返回 alreadyCompleted，不解析必定不会被采纳的请求体。这既避免合法重试被
    // 10/分限流误伤，也不会暴露一条无限制的大 JSON 解析通道。
    const preCheck = await prisma.session.findUnique({
      where: { id },
      select: {
        status: true,
        userId: true,
        recordingPath: true,
        transcriptPath: true,
        summaryPath: true,
        durationMs: true,
      },
    });
    const alreadyDone =
      preCheck?.status === 'COMPLETED' || preCheck?.status === 'ARCHIVED';

    // Completed retries never adopt their body. Authorize and answer from the
    // pre-check before parsing it, preserving cheap idempotence without giving
    // completed/foreign IDs an unlimited 8 MiB JSON parsing lane.
    if (alreadyDone && preCheck) {
      if (preCheck.userId !== user.id) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
      const { searchParams } = new URL(req.url);
      const source = searchParams.get('source') === 'unload' ? 'unload' : 'user';
      logAction(req, 'session.finalize', {
        user,
        detail: `${id} (${source}, already completed)`,
      });
      await invalidateSessionsApiCache(user.id);
      return NextResponse.json({
        success: true,
        alreadyCompleted: true,
        recordingPath: preCheck.recordingPath,
        transcriptPath: preCheck.transcriptPath,
        summaryPath: preCheck.summaryPath,
        durationMs: preCheck.durationMs,
      });
    }

    const rateLimited = await enforceRateLimit(req, {
      scope: 'sessions:finalize',
      limit: 10,
      windowMs: 60_000,
      key: `user:${user.id}`,
    });
    if (rateLimited) return rateLimited;

    const { searchParams } = new URL(req.url);
    const finalizeSource =
      searchParams.get('source') === 'unload' ? 'unload' : 'user';

    let clientBundle: ReturnType<
      typeof admitSessionFinalizePayload
    >['clientBundle'] = null;
    let clientDurationMs: number | undefined;
    let clientTitle: string | undefined;

    try {
      const body = await readBoundedSessionJson(req, { allowEmpty: true });
      if (body) {
        const admitted = admitSessionFinalizePayload(body);
        clientBundle = admitted.clientBundle;
        clientDurationMs = admitted.clientDurationMs;
        clientTitle = admitted.clientTitle;
      }
    } catch (error) {
      if (error instanceof SessionTranscriptPayloadError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: 'Invalid finalize payload' }, { status: 400 });
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
