import fs from 'fs/promises';
import path from 'path';
import type { Session } from '@prisma/client';

const DRAFTS_ROOT = path.join(process.cwd(), 'data', 'recording-drafts');

export interface RecordingDraftManifest {
  sessionId: string;
  userId: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  receivedSeqs: number[];
}

type DraftSessionSource = Pick<Session, 'id' | 'userId'>;

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function getDraftDir(session: DraftSessionSource) {
  return path.join(DRAFTS_ROOT, normalizeSessionId(session.id));
}

function getDraftChunksDir(session: DraftSessionSource) {
  return path.join(getDraftDir(session), 'chunks');
}

function getDraftManifestPath(session: DraftSessionSource) {
  return path.join(getDraftDir(session), 'manifest.json');
}

function getChunkFilePath(session: DraftSessionSource, seq: number) {
  return path.join(
    getDraftChunksDir(session),
    `${String(seq).padStart(8, '0')}.chunk`
  );
}

async function ensureDraftDir(session: DraftSessionSource) {
  await fs.mkdir(getDraftChunksDir(session), { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniqueSortedSeqs(seqs: number[]): number[] {
  return Array.from(new Set(seqs)).sort((a, b) => a - b);
}

async function writeManifest(
  session: DraftSessionSource,
  manifest: RecordingDraftManifest
) {
  await ensureDraftDir(session);
  await fs.writeFile(
    getDraftManifestPath(session),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
}

export async function loadRecordingDraftManifest(
  session: DraftSessionSource
): Promise<RecordingDraftManifest | null> {
  const manifestPath = getDraftManifestPath(session);
  if (!(await fileExists(manifestPath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RecordingDraftManifest>;
    if (
      parsed.sessionId !== session.id ||
      parsed.userId !== session.userId ||
      typeof parsed.mimeType !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number' ||
      !Array.isArray(parsed.receivedSeqs)
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      mimeType: parsed.mimeType,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      receivedSeqs: uniqueSortedSeqs(
        parsed.receivedSeqs.filter((seq): seq is number => Number.isInteger(seq) && seq >= 0)
      ),
    };
  } catch {
    return null;
  }
}

export async function listRecordingDraftSeqs(
  session: DraftSessionSource
): Promise<number[]> {
  const manifest = await loadRecordingDraftManifest(session);
  return manifest?.receivedSeqs ?? [];
}

export async function persistRecordingDraftChunk(
  session: DraftSessionSource,
  options: { seq: number; mimeType: string; data: Buffer }
): Promise<RecordingDraftManifest> {
  await ensureDraftDir(session);
  await fs.writeFile(getChunkFilePath(session, options.seq), options.data);

  const now = Date.now();
  const existing = await loadRecordingDraftManifest(session);
  const manifest: RecordingDraftManifest = {
    sessionId: session.id,
    userId: session.userId,
    mimeType: options.mimeType || existing?.mimeType || 'audio/webm',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    receivedSeqs: uniqueSortedSeqs([...(existing?.receivedSeqs ?? []), options.seq]),
  };

  await writeManifest(session, manifest);
  return manifest;
}

export async function mergeRecordingDraftChunks(
  session: DraftSessionSource
): Promise<{ buffer: Buffer; manifest: RecordingDraftManifest } | null> {
  const manifest = await loadRecordingDraftManifest(session);
  if (!manifest || manifest.receivedSeqs.length === 0) {
    return null;
  }

  const buffers = await Promise.all(
    manifest.receivedSeqs.map((seq) => fs.readFile(getChunkFilePath(session, seq)))
  );

  return {
    buffer: Buffer.concat(buffers),
    manifest,
  };
}

export async function deleteRecordingDraft(
  session: DraftSessionSource
): Promise<void> {
  await fs.rm(getDraftDir(session), { recursive: true, force: true });
}
