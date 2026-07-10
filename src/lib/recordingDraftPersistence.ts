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

// manifest.json 只存元数据——receivedSeqs 始终从 chunks/ 目录扫描得到，
// 这样并发写入 chunk 时不会因为 manifest 的 read-modify-write 竞态丢失 seq。
interface StoredManifestMetadata {
  sessionId: string;
  userId: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
}

type DraftSessionSource = Pick<Session, 'id' | 'userId'>;

const CHUNK_FILENAME_RE = /^(\d+)\.chunk$/;

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

/** 扫描 chunks/ 目录得到当前实际已保存的 seq 列表（source of truth） */
async function scanChunkSeqsOnDisk(
  session: DraftSessionSource
): Promise<number[]> {
  try {
    const files = await fs.readdir(getDraftChunksDir(session));
    const seqs: number[] = [];
    for (const file of files) {
      const match = CHUNK_FILENAME_RE.exec(file);
      if (!match) continue;
      const seq = Number.parseInt(match[1], 10);
      if (Number.isInteger(seq) && seq >= 0) {
        seqs.push(seq);
      }
    }
    seqs.sort((a, b) => a - b);
    return seqs;
  } catch {
    return [];
  }
}

async function readStoredManifestMetadata(
  session: DraftSessionSource
): Promise<StoredManifestMetadata | null> {
  const manifestPath = getDraftManifestPath(session);
  if (!(await fileExists(manifestPath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredManifestMetadata>;
    if (
      parsed.sessionId !== session.id ||
      parsed.userId !== session.userId ||
      typeof parsed.mimeType !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      mimeType: parsed.mimeType,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

async function writeStoredManifestMetadata(
  session: DraftSessionSource,
  metadata: StoredManifestMetadata
) {
  await ensureDraftDir(session);
  await fs.writeFile(
    getDraftManifestPath(session),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  );
}

export async function loadRecordingDraftManifest(
  session: DraftSessionSource
): Promise<RecordingDraftManifest | null> {
  const metadata = await readStoredManifestMetadata(session);
  if (!metadata) {
    return null;
  }
  const receivedSeqs = await scanChunkSeqsOnDisk(session);
  return { ...metadata, receivedSeqs };
}

export async function listRecordingDraftSeqs(
  session: DraftSessionSource
): Promise<number[]> {
  return scanChunkSeqsOnDisk(session);
}

export async function persistRecordingDraftChunk(
  session: DraftSessionSource,
  options: { seq: number; mimeType: string; data: Buffer }
): Promise<RecordingDraftManifest> {
  await ensureDraftDir(session);
  await fs.writeFile(getChunkFilePath(session, options.seq), options.data);

  const now = Date.now();
  const existing = await readStoredManifestMetadata(session);
  const metadata: StoredManifestMetadata = {
    sessionId: session.id,
    userId: session.userId,
    mimeType: options.mimeType || existing?.mimeType || 'audio/webm',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await writeStoredManifestMetadata(session, metadata);

  const receivedSeqs = await scanChunkSeqsOnDisk(session);
  return { ...metadata, receivedSeqs };
}

export async function mergeRecordingDraftChunks(
  session: DraftSessionSource
): Promise<{
  buffer: Buffer;
  manifest: RecordingDraftManifest;
  hasGap: boolean;
} | null> {
  const manifest = await loadRecordingDraftManifest(session);
  if (!manifest || manifest.receivedSeqs.length === 0) {
    return null;
  }

  // seq 空洞检测：媒体容器（webm/mp4）的分片必须连续，缺中间块会让音频在空洞处起
  // 解码损坏。只合并从最小 seq 起的最长连续前缀，保证产出的音频可完整播放，丢弃空洞
  // 之后的段（它们因前面缺块本就无法正常解码）。有空洞时告警，供上层记录/后续补救，
  // 而不是像旧代码那样静默拼出一段中途损坏、用户无从察觉的录音（审计 medium）。
  const seqs = [...manifest.receivedSeqs].sort((a, b) => a - b);
  const contiguous: number[] = [];
  let expected = seqs[0];
  for (const seq of seqs) {
    if (seq === expected) {
      contiguous.push(seq);
      expected += 1;
    } else {
      break;
    }
  }
  const hasGap = contiguous.length < seqs.length;
  if (hasGap) {
    console.warn(
      `[recordingDraft] seq 空洞：共 ${seqs.length} 片但仅前 ${contiguous.length} 片连续` +
        `（自 seq ${seqs[0]} 起，缺 seq ${expected}），session=${session.id}，` +
        `只合并连续前缀以保证可播放`
    );
  }

  const buffers = await Promise.all(
    contiguous.map((seq) => fs.readFile(getChunkFilePath(session, seq)))
  );

  return {
    buffer: Buffer.concat(buffers),
    manifest,
    hasGap,
  };
}

export async function deleteRecordingDraft(
  session: DraftSessionSource
): Promise<void> {
  await fs.rm(getDraftDir(session), { recursive: true, force: true });
}
