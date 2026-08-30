import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { withRequestLogging } from '@/lib/requestLogger';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getBillableMinutes, getMaxSessionDurationMs } from '@/lib/billing';
import { getSiteSettings } from '@/lib/siteSettings';
import { logger } from '@/lib/logger';
import { processFullTranscribe } from '@/lib/audio/fullTranscribeProcessor';
import {
  measureAuthoritativeRecordingDurationMs,
  RECORDING_DURATION_LIMIT_GRACE_MS,
  RecordingDurationMeasurementError,
} from '@/lib/audio/recordingDuration';
import {
  claimFullTranscribeTask,
  failFullTranscribeClaim,
  FULL_TRANSCRIBE_ACTIVE_STATES,
  registerFullTranscribeReservation,
} from '@/lib/audio/fullTranscribeAdmission';
import {
  cleanupFullTranscribeWorkDir,
  FullTranscribeInputTooLargeError,
  FullTranscribeInputUnavailableError,
  prepareFullTranscribeInput,
  type PreparedFullTranscribeInput,
} from '@/lib/audio/fullTranscribeInput';

const SONIOX_MAX_DURATION_MS = 300 * 60_000;

class FullTranscribePreparationError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'FullTranscribePreparationError';
  }
}

// 完整版补全转录触发：claim/资源准入必须先于任何录音读取，之后才以服务端媒体实测时长
// 原子登记配额预留并启动后台管线。小正数 durationMs 与历史客户端值均不作为计价依据。
export const POST = withRequestLogging(
  'sessions:full-transcribe',
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await verifyAuth(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimited = await enforceRateLimit(req, {
      scope: 'sessions:full-transcribe',
      limit: 6,
      windowMs: 10 * 60_000,
      key: `user:${user.id}`,
    });
    if (rateLimited) return rateLimited;

    // 便宜的快照检查只用于尽早返回；真正的所有权/状态/录音/并发判断全部在 claim 锁内重验。
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    try {
      assertOwnership(user.id, session.userId);
    } catch {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    if (session.status !== 'COMPLETED' && session.status !== 'ARCHIVED') {
      return NextResponse.json(
        { error: 'Session must be finalized before generating a full transcript' },
        { status: 409 }
      );
    }
    if (!session.recordingPath) {
      return NextResponse.json(
        { error: 'Session has no recording to transcribe' },
        { status: 409 }
      );
    }
    if (
      session.fullTranscribeStatus &&
      FULL_TRANSCRIBE_ACTIVE_STATES.includes(
        session.fullTranscribeStatus as (typeof FULL_TRANSCRIBE_ACTIVE_STATES)[number]
      )
    ) {
      return NextResponse.json(
        { status: session.fullTranscribeStatus, alreadyRunning: true },
        { status: 200 }
      );
    }

    let claim;
    try {
      claim = await claimFullTranscribeTask(id, user.id);
    } catch (error) {
      logger.error({ error, sessionId: id }, 'full transcribe claim failed');
      return NextResponse.json(
        { error: 'Failed to start full transcription' },
        { status: 500 }
      );
    }

    if (claim.outcome !== 'claimed') {
      switch (claim.outcome) {
        case 'notfound':
          return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        case 'forbidden':
          return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        case 'not_finalized':
          return NextResponse.json(
            { error: 'Session must be finalized before generating a full transcript' },
            { status: 409 }
          );
        case 'no_recording':
          return NextResponse.json(
            { error: 'Session has no recording to transcribe' },
            { status: 409 }
          );
        case 'already_running':
          return NextResponse.json(
            { status: claim.status ?? 'pending', alreadyRunning: true },
            { status: 200 }
          );
        case 'user_busy':
          return NextResponse.json(
            { error: 'Another full transcription is already active for this user' },
            { status: 429, headers: { 'Retry-After': '30' } }
          );
        case 'global_busy':
          return NextResponse.json(
            { error: 'Full transcription capacity is temporarily exhausted' },
            { status: 503, headers: { 'Retry-After': '30' } }
          );
      }
    }

    let prepared: PreparedFullTranscribeInput | null = null;
    let measuredDurationMs = 0;
    try {
      // Security ordering invariant: the durable claim and user/global admission above must win
      // before resolve/open/stat/download/probe touches attacker-sized media.
      prepared = await prepareFullTranscribeInput(claim.session, claim.claimId);
      measuredDurationMs = await measureAuthoritativeRecordingDurationMs(
        prepared.inputPath,
        { tempRoot: prepared.workDir }
      );
      if (!Number.isFinite(measuredDurationMs) || measuredDurationMs <= 0) {
        throw new FullTranscribePreparationError(
          'Cannot determine the recording duration; full transcription is unavailable for this session',
          409
        );
      }
      measuredDurationMs = Math.trunc(measuredDurationMs);

      const roleLimitMs = getMaxSessionDurationMs(user.role);
      if (
        roleLimitMs != null &&
        measuredDurationMs > roleLimitMs + RECORDING_DURATION_LIMIT_GRACE_MS
      ) {
        throw new FullTranscribePreparationError(
          'Recording duration exceeds the limit for this account',
          409
        );
      }
      if (measuredDurationMs > SONIOX_MAX_DURATION_MS) {
        throw new FullTranscribePreparationError(
          'Recording duration exceeds the 300-minute full transcription limit',
          409
        );
      }

      const { async_upload_billing_multiplier } = await getSiteSettings();
      if (
        !Number.isFinite(async_upload_billing_multiplier) ||
        async_upload_billing_multiplier < 0
      ) {
        throw new Error('Invalid async upload billing multiplier');
      }
      const estimatedMinutes = Math.max(
        0,
        Math.ceil(
          getBillableMinutes(measuredDurationMs) * async_upload_billing_multiplier
        )
      );
      const reservation = await registerFullTranscribeReservation({
        sessionId: id,
        userId: user.id,
        claimId: claim.claimId,
        durationMs: measuredDurationMs,
        estimatedMinutes,
      });

      if (reservation.outcome === 'insufficient_quota') {
        await cleanupFullTranscribeWorkDir(id, claim.claimId);
        return NextResponse.json(
          { error: 'Insufficient transcription quota', estimatedMinutes },
          { status: 402 }
        );
      }
      if (reservation.outcome === 'claim_lost') {
        await cleanupFullTranscribeWorkDir(id, claim.claimId);
        return NextResponse.json(
          { error: 'Full transcription claim is no longer active' },
          { status: 409 }
        );
      }

      // Ownership of the claim-scoped temp directory transfers to the processor here. Local
      // recordings remain outside workDir and are never deleted by processor cleanup.
      void processFullTranscribe({
        sessionId: id,
        claimId: claim.claimId,
        input: prepared,
        authoritativeDurationMs: measuredDurationMs,
      });

      return NextResponse.json({ status: 'pending', estimatedMinutes });
    } catch (error) {
      await cleanupFullTranscribeWorkDir(id, claim.claimId);

      let publicMessage = 'Failed to prepare full transcription';
      let status = 500;
      if (error instanceof FullTranscribeInputTooLargeError) {
        publicMessage = 'Recording is too large for full transcription';
        status = 413;
      } else if (error instanceof FullTranscribeInputUnavailableError) {
        publicMessage = 'Session recording not found or empty';
        status = 409;
      } else if (error instanceof RecordingDurationMeasurementError) {
        publicMessage =
          'Cannot determine the recording duration; full transcription is unavailable for this session';
        status = 409;
      } else if (error instanceof FullTranscribePreparationError) {
        publicMessage = error.message;
        status = error.status;
      }

      await failFullTranscribeClaim({
        sessionId: id,
        claimId: claim.claimId,
        error: publicMessage,
        durationMs: measuredDurationMs > 0 ? measuredDurationMs : undefined,
      }).catch(() => undefined);
      logger.error({ error, sessionId: id, claimId: claim.claimId }, publicMessage);
      return NextResponse.json({ error: publicMessage }, { status });
    }
  }
);
