import fs from 'fs/promises';
import path from 'path';
import { resolveSessionAudioLocation } from '@/lib/sessionPersistence';
import { CloudreveStorage } from '@/lib/storage/cloudreve';

const DEFAULT_MAX_INPUT_BYTES = 512 * 1024 * 1024;
const HARD_MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TMP_ROOT = path.join(process.cwd(), 'data', 'full-transcribe-tmp');

export class FullTranscribeInputTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Recording exceeds the full-transcribe input limit (${maxBytes} bytes)`);
    this.name = 'FullTranscribeInputTooLargeError';
  }
}

export class FullTranscribeInputUnavailableError extends Error {
  constructor(message = 'Session recording not found or empty') {
    super(message);
    this.name = 'FullTranscribeInputUnavailableError';
  }
}

export interface PreparedFullTranscribeInput {
  inputPath: string;
  workDir: string;
  contentType: string;
  sizeBytes: number;
  source: 'local' | 'cloudreve';
}

export interface PrepareFullTranscribeInputOptions {
  /** Tests and maintenance may override; production stays under the existing data root. */
  tempRoot?: string;
  maxBytes?: number;
}

function safePathComponent(value: string, fallback: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return sanitized || fallback;
}

export function getFullTranscribeInputLimitBytes(): number {
  const parsed = Number.parseInt(process.env.FULL_TRANSCRIBE_MAX_INPUT_BYTES ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_INPUT_BYTES;
  return Math.min(parsed, HARD_MAX_INPUT_BYTES);
}

export function buildFullTranscribeWorkDir(
  sessionId: string,
  claimId: string | null,
  tempRoot = DEFAULT_TMP_ROOT
): string {
  const safeSessionId = safePathComponent(sessionId, 'session');
  // Legacy in-flight tasks had no claim id and used exactly <root>/<sessionId>.
  if (!claimId) return path.join(tempRoot, safeSessionId);
  const safeClaimId = safePathComponent(claimId, 'claim');
  return path.join(tempRoot, `${safeSessionId}--${safeClaimId}`);
}

export async function cleanupFullTranscribeWorkDir(
  sessionId: string,
  claimId: string | null,
  tempRoot = DEFAULT_TMP_ROOT
): Promise<void> {
  await fs
    .rm(buildFullTranscribeWorkDir(sessionId, claimId, tempRoot), {
      recursive: true,
      force: true,
    })
    .catch(() => undefined);
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'audio/mp4' || normalized === 'video/mp4') return 'mp4';
  if (normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  if (normalized === 'audio/ogg' || normalized === 'video/ogg') return 'ogg';
  return 'webm';
}

function declaredLengthExceedsLimit(value: string | null, maxBytes: number): boolean {
  if (!value || !/^\d+$/.test(value.trim())) return false;
  try {
    return BigInt(value.trim()) > BigInt(maxBytes);
  } catch {
    return false;
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  chunk: Uint8Array
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset
    );
    if (bytesWritten <= 0) throw new Error('Failed to write recording stream');
    offset += bytesWritten;
  }
}

/**
 * Resolve one claimed task's immutable input descriptor without loading it into the JS heap.
 * Local artifacts are passed to ffmpeg by path. Remote artifacts are streamed once into a
 * claim-scoped temp file with both declared-length and actual received-byte enforcement.
 */
export async function prepareFullTranscribeInput(
  session: { id: string; userId: string; recordingPath: string },
  claimId: string,
  options: PrepareFullTranscribeInputOptions = {}
): Promise<PreparedFullTranscribeInput> {
  const requestedMaxBytes = options.maxBytes ?? getFullTranscribeInputLimitBytes();
  const maxBytes =
    Number.isSafeInteger(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.min(requestedMaxBytes, HARD_MAX_INPUT_BYTES)
      : DEFAULT_MAX_INPUT_BYTES;
  const tempRoot = options.tempRoot ?? DEFAULT_TMP_ROOT;
  const workDir = buildFullTranscribeWorkDir(session.id, claimId, tempRoot);
  const location = await resolveSessionAudioLocation(session);
  if (!location) throw new FullTranscribeInputUnavailableError();

  if (location.kind === 'local') {
    if (location.size <= 0) throw new FullTranscribeInputUnavailableError();
    if (location.size > maxBytes) throw new FullTranscribeInputTooLargeError(maxBytes);
    await fs.mkdir(tempRoot, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    return {
      inputPath: location.filePath,
      workDir,
      contentType: location.contentType,
      sizeBytes: location.size,
      source: 'local',
    };
  }

  await fs.mkdir(tempRoot, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  const inputPath = path.join(
    workDir,
    `input.${extensionForContentType(location.contentType)}`
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

  try {
    const storage = await CloudreveStorage.create();
    const response = await storage.openDownloadStream(location.remotePath, {
      expectedUserId: location.userId,
    });
    if (declaredLengthExceedsLimit(response.headers.get('content-length'), maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new FullTranscribeInputTooLargeError(maxBytes);
    }
    if (!response.body) throw new FullTranscribeInputUnavailableError();

    reader = response.body.getReader();
    handle = await fs.open(inputPath, 'wx');
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new FullTranscribeInputTooLargeError(maxBytes);
      }
      await writeAll(handle, value);
    }
    if (received <= 0) throw new FullTranscribeInputUnavailableError();
    await handle.close();
    handle = null;

    return {
      inputPath,
      workDir,
      contentType: location.contentType,
      sizeBytes: received,
      source: 'cloudreve',
    };
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await cleanupFullTranscribeWorkDir(session.id, claimId, tempRoot);
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
