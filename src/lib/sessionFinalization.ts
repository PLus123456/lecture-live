import type { Prisma, SessionStatus } from '@prisma/client';
import type { UserPayload } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import {
  mergeRecordingDraftChunks,
  deleteRecordingDraft,
} from '@/lib/recordingDraftPersistence';
import {
  loadTranscriptDraft,
  deleteTranscriptDraft,
} from '@/lib/transcriptDraftPersistence';
import {
  persistSessionAudioArtifact,
  persistSessionTranscriptArtifacts,
  extractTranscriptText,
  loadSessionTranscriptBundle,
  persistSessionReport,
  type PersistedTranscriptBundle,
} from '@/lib/sessionPersistence';
import {
  resolveServerRecordingDurationMs,
  resolveTranscriptDurationMs,
  normalizeRecordedAudioDuration,
} from '@/lib/audio/recordingDuration';
import { clampSessionDurationMs, getBillableMinutes } from '@/lib/billing';
import { callLLM } from '@/lib/llm/gateway';
import { extractAndAccumulateKeywords } from '@/lib/llm/folderKeywords';
import { generateSessionReport } from '@/lib/llm/reportManager';
import { logSystemEvent } from '@/lib/auditLog';
import type { SummaryBlock } from '@/types/summary';

const FINALIZE_LOCK_STALE_MS = 15 * 60_000;

const EMPTY_TRANSCRIPT_BUNDLE: PersistedTranscriptBundle = {
  segments: [],
  summaries: [],
  translations: {},
};

type FinalizeSource = 'user' | 'unload' | 'system_auto_reclaim';

export class FinalizeSessionError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(
      typeof body.error === 'string' ? body.error : 'Failed to finalize session'
    );
    this.name = 'FinalizeSessionError';
    this.status = status;
    this.body = body;
  }
}

interface FinalizeSessionOptions {
  sessionId: string;
  actor: UserPayload | null;
  clientBundle?: PersistedTranscriptBundle | null;
  clientDurationMs?: number;
  clientTitle?: string;
  allowStatusPromotion?: boolean;
  finalizeSource?: FinalizeSource;
}

interface FinalizeSessionResult {
  success: true;
  alreadyCompleted?: boolean;
  recordingPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  durationMs?: number;
  transcriptMissing?: boolean;
  recordingMissing?: boolean;
}

type FinalizeSessionRecord = NonNullable<
  Awaited<ReturnType<typeof loadSessionForFinalize>>
>;

export async function finalizeSession(
  options: FinalizeSessionOptions
): Promise<FinalizeSessionResult> {
  let session = await loadSessionForFinalize(options.sessionId);
  if (!session) {
    throw new FinalizeSessionError(404, { error: 'Session not found' });
  }

  if (options.actor) {
    try {
      assertOwnership(options.actor.id, session.userId);
    } catch {
      throw new FinalizeSessionError(403, { error: 'Access denied' });
    }
  }

  if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
    return {
      success: true,
      alreadyCompleted: true,
      recordingPath: session.recordingPath,
      transcriptPath: session.transcriptPath,
      summaryPath: session.summaryPath,
      durationMs: session.durationMs,
    };
  }

  if (session.status !== 'FINALIZING') {
    const canPromote =
      options.allowStatusPromotion === true &&
      (session.status === 'RECORDING' || session.status === 'PAUSED');

    if (!canPromote) {
      throw new FinalizeSessionError(409, {
        error: `Session status must be FINALIZING, got ${session.status}`,
      });
    }

    await promoteSessionToFinalizing(session);
    session = await loadSessionForFinalize(options.sessionId);
    if (!session) {
      throw new FinalizeSessionError(404, { error: 'Session not found' });
    }

    if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
      return {
        success: true,
        alreadyCompleted: true,
        recordingPath: session.recordingPath,
        transcriptPath: session.transcriptPath,
        summaryPath: session.summaryPath,
        durationMs: session.durationMs,
      };
    }

    if (session.status !== 'FINALIZING') {
      throw new FinalizeSessionError(409, {
        error: `Session status must be FINALIZING, got ${session.status}`,
      });
    }
  }

  const lockAcquired = await prisma.session.updateMany({
    where: {
      id: options.sessionId,
      status: 'FINALIZING',
      OR: [
        { finalizeLockedAt: null },
        {
          finalizeLockedAt: {
            lt: new Date(Date.now() - FINALIZE_LOCK_STALE_MS),
          },
        },
      ],
    },
    data: {
      finalizeLockedAt: new Date(),
    },
  });

  if (lockAcquired.count === 0) {
    const latest = await prisma.session.findUnique({
      where: { id: options.sessionId },
      select: {
        status: true,
        finalizeLockedAt: true,
        recordingPath: true,
        transcriptPath: true,
        summaryPath: true,
        durationMs: true,
      },
    });

    if (latest?.status === 'COMPLETED' || latest?.status === 'ARCHIVED') {
      return {
        success: true,
        alreadyCompleted: true,
        recordingPath: latest.recordingPath,
        transcriptPath: latest.transcriptPath,
        summaryPath: latest.summaryPath,
        durationMs: latest.durationMs,
      };
    }

    throw new FinalizeSessionError(409, {
      error: 'Session is already being finalized',
    });
  }

  try {
    let transcriptPath = session.transcriptPath;
    let summaryPath = session.summaryPath;
    let bundle: PersistedTranscriptBundle | null = null;
    let transcriptMissing = false;

    if (!transcriptPath) {
      bundle = await resolveTranscriptBundle(session, options.clientBundle);
      if (!bundle || bundle.segments.length === 0) {
        bundle = {
          segments: [],
          summaries: [],
          translations: {},
        };
        transcriptMissing = true;
      }
    } else {
      bundle = await loadSessionTranscriptBundle(session).catch(() => null);
    }

    const normalizedClientDurationMs =
      typeof options.clientDurationMs === 'number' &&
      Number.isFinite(options.clientDurationMs) &&
      options.clientDurationMs > 0
        ? options.clientDurationMs
        : undefined;
    const transcriptDurationMs = resolveTranscriptDurationMs(bundle);
    const serverDurationMs = resolveServerRecordingDurationMs(session);
    const legacyDurationFallbackMs =
      !session.serverStartedAt &&
      transcriptDurationMs === 0 &&
      (session.durationMs ?? 0) === 0
        ? Math.max(0, normalizedClientDurationMs ?? 0)
        : 0;
    const resolvedDurationMs = Math.max(
      session.durationMs ?? 0,
      transcriptDurationMs,
      serverDurationMs,
      legacyDurationFallbackMs
    );
    const finalDurationMs = clampSessionDurationMs(
      resolvedDurationMs,
      session.user.role
    );
    const billableMinutes = getBillableMinutes(finalDurationMs);

    if (
      normalizedClientDurationMs &&
      Math.abs(normalizedClientDurationMs - finalDurationMs) >= 60_000
    ) {
      console.warn(
        `[finalize] duration mismatch session=${session.id} client=${normalizedClientDurationMs}ms server=${serverDurationMs}ms transcript=${transcriptDurationMs}ms final=${finalDurationMs}ms`
      );
    }

    let recordingPath = session.recordingPath;
    let recordingMissing = false;

    if (!recordingPath) {
      const merged = await mergeRecordingDraftChunks(session);
      if (merged) {
        const normalizedBuffer = await normalizeRecordedAudioDuration({
          buffer: merged.buffer,
          mimeType: merged.manifest.mimeType,
          durationMs: finalDurationMs,
        });

        const storedAudio = await persistSessionAudioArtifact(
          session,
          normalizedBuffer,
          merged.manifest.mimeType
        );
        recordingPath = storedAudio.path;
        await deleteRecordingDraft(session).catch(() => undefined);
      } else {
        recordingMissing = true;
      }
    }

    if (!transcriptPath) {
      const stored = await persistSessionTranscriptArtifacts(
        session,
        bundle ?? EMPTY_TRANSCRIPT_BUNDLE
      );
      transcriptPath = stored.transcript.path;
      summaryPath = stored.summary.path;
      await deleteTranscriptDraft(session).catch(() => undefined);
    }

    const normalizedTitle =
      typeof options.clientTitle === 'string' && options.clientTitle.trim()
        ? options.clientTitle.trim().slice(0, 160)
        : undefined;
    const shouldDeduct = billableMinutes > 0 && session.user.role !== 'ADMIN';
    const updatedSession = await prisma.$transaction(async (tx) => {
      const updated = await tx.session.update({
        where: { id: options.sessionId },
        data: {
          status: 'COMPLETED',
          recordingPath,
          transcriptPath,
          summaryPath,
          finalizeLockedAt: null,
          serverPausedAt: null,
          durationMs: finalDurationMs,
          ...(normalizedTitle ? { title: normalizedTitle } : {}),
        },
      });

      if (shouldDeduct) {
        await tx.user.update({
          where: { id: session.userId },
          data: {
            transcriptionMinutesUsed: { increment: billableMinutes },
          },
        });
      }

      return updated;
    });

    if (transcriptMissing) {
      logSystemEvent(
        'session.finalize.transcript_missing',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          source: options.finalizeSource ?? 'user',
          durationMs: finalDurationMs,
        })
      );
    }

    if (recordingMissing) {
      logSystemEvent(
        'session.finalize.recording_missing',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          source: options.finalizeSource ?? 'user',
          durationMs: finalDurationMs,
        })
      );
    }

    if (options.finalizeSource === 'system_auto_reclaim') {
      logSystemEvent(
        'session.auto_reclaimed',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          durationMs: finalDurationMs,
          billableMinutes,
          transcriptMissing,
          recordingMissing,
        })
      );
    }

    if (transcriptPath && summaryPath) {
      const folderIds = session.folders.map((folder) => folder.folderId);
      void runBackgroundLLMTasks({
        sessionId: session.id,
        userId: session.userId,
        transcriptPath,
        summaryPath,
        recordingPath,
        title: updatedSession.title,
        courseName: session.courseName ?? '',
        durationMs: updatedSession.durationMs,
        createdAt: session.createdAt,
        targetLang: session.targetLang || 'zh',
        folderIds,
        bundle,
      });
    }

    return {
      success: true,
      recordingPath,
      transcriptPath,
      summaryPath,
      durationMs: updatedSession.durationMs ?? undefined,
      transcriptMissing,
      recordingMissing,
    };
  } catch (error) {
    await releaseFinalizeLock(options.sessionId);
    if (error instanceof FinalizeSessionError) {
      throw error;
    }
    throw error;
  }
}

async function loadSessionForFinalize(sessionId: string) {
  return prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      folders: {
        select: { folderId: true },
      },
      user: {
        select: {
          role: true,
          email: true,
        },
      },
    },
  });
}

async function promoteSessionToFinalizing(session: FinalizeSessionRecord) {
  const promotion = await prisma.session.updateMany({
    where: {
      id: session.id,
      status: session.status,
    },
    data: buildFinalizePromotionData(session),
  });

  if (promotion.count > 0) {
    return;
  }

  const latest = await prisma.session.findUnique({
    where: { id: session.id },
    select: { status: true },
  });

  if (latest?.status === 'COMPLETED' || latest?.status === 'ARCHIVED') {
    return;
  }

  if (latest?.status !== 'FINALIZING') {
    throw new FinalizeSessionError(409, {
      error: `Session status must be FINALIZING, got ${latest?.status ?? 'UNKNOWN'}`,
    });
  }
}

function buildFinalizePromotionData(session: {
  status: SessionStatus;
  serverPausedAt: Date | null;
}): Prisma.SessionUpdateManyMutationInput {
  const data: Prisma.SessionUpdateManyMutationInput = {
    status: 'FINALIZING',
  };

  if (session.status === 'PAUSED' && session.serverPausedAt) {
    const pendingPausedMs = Math.max(
      0,
      Date.now() - session.serverPausedAt.getTime()
    );
    data.serverPausedAt = null;
    if (pendingPausedMs > 0) {
      data.serverPausedMs = { increment: pendingPausedMs };
    }
  }

  return data;
}

async function resolveTranscriptBundle(
  session: FinalizeSessionRecord,
  clientBundle?: PersistedTranscriptBundle | null
): Promise<PersistedTranscriptBundle | null> {
  if (clientBundle && clientBundle.segments.length > 0) {
    return clientBundle;
  }

  const draft = await loadTranscriptDraft(session);
  if (draft && draft.segments.length > 0) {
    return {
      segments: draft.segments,
      summaries:
        clientBundle?.summaries?.length && clientBundle.summaries.length > 0
          ? clientBundle.summaries
          : draft.summaries,
      translations:
        clientBundle &&
        Object.keys(clientBundle.translations ?? {}).length > 0
          ? clientBundle.translations
          : draft.translations,
    };
  }

  if (clientBundle) {
    return clientBundle;
  }

  return null;
}

async function releaseFinalizeLock(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      finalizeLockedAt: null,
    },
  }).catch(() => undefined);
}

interface BackgroundTaskParams {
  sessionId: string;
  userId: string;
  transcriptPath: string | null;
  summaryPath: string | null;
  recordingPath: string | null;
  title: string;
  courseName: string;
  durationMs: number | null;
  createdAt: Date;
  targetLang: string;
  folderIds: string[];
  bundle: PersistedTranscriptBundle | null;
}

async function runBackgroundLLMTasks(params: BackgroundTaskParams) {
  if (!params.transcriptPath || !params.summaryPath) {
    return;
  }

  try {
    const sessionForLoad = {
      id: params.sessionId,
      userId: params.userId,
      recordingPath: params.recordingPath,
      transcriptPath: params.transcriptPath,
      summaryPath: params.summaryPath,
    };
    const bundle =
      params.bundle ?? (await loadSessionTranscriptBundle(sessionForLoad));
    if (!bundle || bundle.segments.length === 0) {
      console.warn(`[finalize-bg] ${params.sessionId}: no transcript data, skip LLM`);
      return;
    }

    const fullTranscript = extractTranscriptText(bundle);

    const keywordPromise = Promise.all(
      params.folderIds.map(async (folderId) => {
        try {
          await extractAndAccumulateKeywords(
            params.sessionId,
            folderId,
            fullTranscript,
            callLLM
          );
        } catch (error) {
          console.error(
            `[finalize-bg] keyword extraction failed folder=${folderId}:`,
            error
          );
        }
      })
    );

    const reportPromise = (async () => {
      try {
        const summaryBlocks = (bundle.summaries ?? []) as SummaryBlock[];
        const reportData = await generateSessionReport({
          sessionId: params.sessionId,
          transcript: fullTranscript,
          sessionTitle: params.title,
          courseName: params.courseName,
          durationMs: params.durationMs ?? 0,
          date: params.createdAt.toISOString().split('T')[0],
          summaryBlocks,
          language: params.targetLang,
          callLLM: (system: string, userMessage: string) =>
            callLLM(system, userMessage, { purpose: 'FINAL_SUMMARY' }),
        });

        const stored = await persistSessionReport(sessionForLoad, reportData);
        await prisma.session.update({
          where: { id: params.sessionId },
          data: { reportPath: stored.path },
        });
      } catch (error) {
        console.error('[finalize-bg] report generation failed:', error);
      }
    })();

    await Promise.allSettled([keywordPromise, reportPromise]);
    console.log(`[finalize-bg] ${params.sessionId}: background tasks completed`);
  } catch (error) {
    console.error(
      `[finalize-bg] ${params.sessionId}: background task failed:`,
      error
    );
  }
}
