import type { Session } from '@prisma/client';
import fixWebmDuration from 'fix-webm-duration';
import { loadSessionTranscriptBundle } from '@/lib/sessionPersistence';
import type { PersistedTranscriptBundle } from '@/lib/sessionPersistence';

type DurationSessionSource = Pick<
  Session,
  | 'id'
  | 'userId'
  | 'durationMs'
  | 'recordingPath'
  | 'transcriptPath'
  | 'summaryPath'
  | 'serverStartedAt'
  | 'serverPausedMs'
  | 'serverPausedAt'
>;

export function resolveTranscriptDurationMs(
  transcriptBundle: PersistedTranscriptBundle | null | undefined
): number {
  return Array.isArray(transcriptBundle?.segments)
    ? transcriptBundle.segments.reduce<number>((maxDuration, segment) => {
        if (!segment || typeof segment !== 'object') {
          return maxDuration;
        }

        const record = segment as {
          globalEndMs?: unknown;
          endMs?: unknown;
        };

        const rawEndMs =
          typeof record.globalEndMs === 'number'
            ? record.globalEndMs
            : typeof record.endMs === 'number'
              ? record.endMs
              : 0;
        const endMs = Number(rawEndMs);

        return Number.isFinite(endMs)
          ? Math.max(maxDuration, endMs)
          : maxDuration;
      }, 0)
    : 0;
}

export function resolveServerRecordingDurationMs(
  session: Pick<Session, 'serverStartedAt' | 'serverPausedMs' | 'serverPausedAt'>,
  now = new Date()
): number {
  if (!session.serverStartedAt) {
    return 0;
  }

  const startedAtMs = session.serverStartedAt.getTime();
  const pausedMs = Number.isFinite(session.serverPausedMs)
    ? Math.max(0, session.serverPausedMs)
    : 0;
  const pendingPausedMs = session.serverPausedAt
    ? Math.max(0, now.getTime() - session.serverPausedAt.getTime())
    : 0;

  return Math.max(0, now.getTime() - startedAtMs - pausedMs - pendingPausedMs);
}

export async function resolveExpectedRecordingDurationMs(
  session: DurationSessionSource
): Promise<number> {
  const transcriptBundle = await loadSessionTranscriptBundle(session).catch(
    () => null
  );
  const transcriptDurationMs = resolveTranscriptDurationMs(transcriptBundle);
  const serverDurationMs = resolveServerRecordingDurationMs(session);

  return Math.max(session.durationMs ?? 0, transcriptDurationMs, serverDurationMs);
}

export async function normalizeRecordedAudioDuration(options: {
  buffer: Buffer;
  mimeType?: string | null;
  durationMs: number;
}): Promise<Buffer> {
  const normalizedMimeType = (options.mimeType || '').toLowerCase();
  if (!normalizedMimeType.includes('webm') || options.durationMs <= 0) {
    return options.buffer;
  }

  const fixedBlob = await fixWebmDuration(
    new Blob([new Uint8Array(options.buffer)], {
      type: options.mimeType || 'audio/webm',
    }),
    options.durationMs,
    { logger: false }
  );

  return Buffer.from(await fixedBlob.arrayBuffer());
}
