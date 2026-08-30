/**
 * 完整版补全转录后台管线。
 *
 * 路由已在读取录音前取得 durable claim，并把本地 path 或单次有界下载得到的 temp path 交给
 * 本管线。这里绝不再次从 recordingPath 下载/整包 readFile，避免同一任务的双重 I/O 与 heap 放大。
 */
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  probeDurationSec,
  transcodeToMp3,
  validateMediaContainer,
} from '@/lib/audio/ffmpegTranscode';
import type { PreparedFullTranscribeInput } from '@/lib/audio/fullTranscribeInput';
import { resolveAndPersistTaskRegion } from '@/lib/soniox/env';
import {
  uploadSonioxFile,
  createSonioxTranscription,
  deleteSonioxFile,
  deleteSonioxTranscription,
} from '@/lib/soniox/asyncFile';
import { failFullTranscribeAttempt } from '@/lib/audio/fullTranscribeAdmission';

const SONIOX_MAX_DURATION_SEC = 300 * 60;

class PipelineHaltError extends Error {
  constructor() {
    super('Full transcribe halted: claim is no longer active');
    this.name = 'PipelineHaltError';
  }
}

export interface FullTranscribeProcessRequest {
  sessionId: string;
  claimId: string;
  input: PreparedFullTranscribeInput;
  authoritativeDurationMs: number;
}

/** Every transition is bound to the attempt id so a stale worker cannot mutate a retrigger. */
async function setFullStatus(
  sessionId: string,
  claimId: string,
  next: string,
  allowedFrom: string[],
  extra?: Record<string, unknown>
): Promise<boolean> {
  const res = await prisma.session.updateMany({
    where: {
      id: sessionId,
      fullTranscribeClaimId: claimId,
      fullTranscribeStatus: { in: allowedFrom },
    },
    data: { fullTranscribeStatus: next, ...(extra ?? {}) },
  });
  return res.count === 1;
}

/**
 * Fire-and-forget processing after the trigger route has claimed, measured, and reserved quota.
 * All terminal paths remove only this claim's work directory. Any processing failure marks this
 * attempt failed and releases its registered reservation exactly once.
 */
export async function processFullTranscribe(
  request: FullTranscribeProcessRequest
): Promise<void> {
  const { sessionId, claimId, input, authoritativeDurationMs } = request;
  let uploadedFileId: string | null = null;
  let createdTranscriptionId: string | null = null;
  let sonioxConfig: Awaited<ReturnType<typeof resolveAndPersistTaskRegion>> | null = null;

  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.fullTranscribeClaimId !== claimId) {
      throw new PipelineHaltError();
    }

    if (!(await setFullStatus(sessionId, claimId, 'transcoding', ['pending']))) {
      throw new PipelineHaltError();
    }

    if (!Number.isFinite(authoritativeDurationMs) || authoritativeDurationMs <= 0) {
      throw new Error('Authoritative recording duration is missing');
    }
    const inputDurationSec = authoritativeDurationMs / 1000;
    if (inputDurationSec > SONIOX_MAX_DURATION_SEC) {
      throw new Error(
        `Duration ${Math.round(inputDurationSec / 60)} min exceeds Soniox 300-min limit`
      );
    }

    await fs.mkdir(input.workDir, { recursive: true });
    // Revalidate immediately before ffmpeg. The route already did this during authoritative
    // measurement; the second check is cheap defense against a local artifact changing in between.
    await validateMediaContainer(input.inputPath);

    const mp3Path = path.join(input.workDir, 'audio.mp3');
    const transcodeResult = await transcodeToMp3({
      inputPath: input.inputPath,
      outputPath: mp3Path,
      durationSec: inputDurationSec,
      bitrateKbps: 128,
    });

    // The durable lease may have been reclaimed while this worker waited for the shared ffmpeg
    // slot or transcoded. Re-check before any paid remote work and refresh the lease timestamp.
    if (
      !(await setFullStatus(sessionId, claimId, 'transcoding', ['transcoding'], {
        fullTranscribeStartedAt: new Date(),
      }))
    ) {
      throw new PipelineHaltError();
    }

    const durationSec =
      (await probeDurationSec(mp3Path)) || transcodeResult.durationSec || inputDurationSec;
    if (!durationSec) {
      throw new Error('Cannot detect audio duration — recording may be corrupted');
    }
    if (durationSec > SONIOX_MAX_DURATION_SEC) {
      throw new Error(
        `Duration ${Math.round(durationSec / 60)} min exceeds Soniox 300-min limit`
      );
    }

    // 按任务固定 region；后续 poll/finalize/cancel 都读取持久化值。
    sonioxConfig = await resolveAndPersistTaskRegion(sessionId, session.sonioxRegion);
    if (!sonioxConfig) throw new Error('Soniox credentials not configured');

    const sonioxFile = await uploadSonioxFile(sonioxConfig, mp3Path, {
      filename: `${sessionId}-full.mp3`,
      clientReferenceId: `${sessionId}-full`,
    });
    uploadedFileId = sonioxFile.id;

    // Upload can itself be long. If the attempt was reclaimed meanwhile, delete the just-created
    // file in the catch path and never create a Soniox transcription for a stale claim.
    if (
      !(await setFullStatus(sessionId, claimId, 'transcoding', ['transcoding'], {
        fullTranscribeStartedAt: new Date(),
      }))
    ) {
      throw new PipelineHaltError();
    }

    const translation =
      session.targetLang && session.targetLang !== session.sourceLang
        ? ({ type: 'one_way', target_language: session.targetLang } as const)
        : undefined;

    const job = await createSonioxTranscription(sonioxConfig, {
      fileId: sonioxFile.id,
      languageHints: session.sourceLang ? [session.sourceLang] : undefined,
      enableLanguageIdentification: true,
      enableSpeakerDiarization: true,
      translation,
      clientReferenceId: `${sessionId}-full`,
    });
    createdTranscriptionId = job.id;

    if (
      !(await setFullStatus(sessionId, claimId, 'transcribing', ['transcoding'], {
        fullSonioxFileId: sonioxFile.id,
        fullSonioxTranscriptionId: job.id,
      }))
    ) {
      throw new PipelineHaltError();
    }
  } catch (error) {
    // Until the final transcribing CAS succeeds the Soniox IDs exist only in this worker, so every
    // error — including claim loss — must clean them before returning.
    if (sonioxConfig) {
      if (createdTranscriptionId) {
        await deleteSonioxTranscription(sonioxConfig, createdTranscriptionId).catch(
          () => undefined
        );
      }
      if (uploadedFileId) {
        await deleteSonioxFile(sonioxConfig, uploadedFileId).catch(() => undefined);
      }
    }

    if (error instanceof PipelineHaltError) return;

    const message = error instanceof Error ? error.message : 'Full transcribe failed';
    logger.error({ error, sessionId, claimId }, 'full transcribe pipeline failed');
    await failFullTranscribeAttempt({
      sessionId,
      claimId,
      allowedStatuses: ['pending', 'transcoding'],
      error: message,
    }).catch(() => false);
  } finally {
    // input.workDir is generated internally from sessionId+claimId; it never contains a local
    // recording path. Cloudreve input lives inside it and is removed with the MP3.
    await fs.rm(input.workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
