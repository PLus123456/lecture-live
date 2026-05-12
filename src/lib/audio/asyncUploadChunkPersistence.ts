/**
 * 文件上传分片持久化（async 转录路径专用）。
 *
 * 与 recordingDraftPersistence 的区别：
 * - 独立目录 data/async-uploads/{sessionId}/chunks/，避免和录音草稿冲突
 * - 接受任意 audio/video MIME（具体合法性由 uploadValidation 在 finalize 时判定）
 * - manifest 记录原始文件名 + 总分片数（前端 init 时声明），用于完整性校验
 *
 * 并发安全：和 recordingDraftPersistence 同样的策略 —— receivedSeqs 始终
 * 扫盘得到，manifest.json 只存元数据，避免 read-modify-write 竞态。
 */
import fs from 'fs/promises';
import path from 'path';
import type { Session } from '@prisma/client';

const UPLOADS_ROOT = path.join(process.cwd(), 'data', 'async-uploads');

export interface AsyncUploadManifest {
  sessionId: string;
  userId: string;
  originalFileName: string;
  originalMimeType: string;
  originalSize: number;
  totalChunks: number;
  chunkSize: number;
  createdAt: number;
  updatedAt: number;
  receivedSeqs: number[];
}

interface StoredManifestMetadata {
  sessionId: string;
  userId: string;
  originalFileName: string;
  originalMimeType: string;
  originalSize: number;
  totalChunks: number;
  chunkSize: number;
  createdAt: number;
  updatedAt: number;
}

type UploadSessionSource = Pick<Session, 'id' | 'userId'>;
type UploadSessionRef = Pick<Session, 'id'>;

const CHUNK_FILENAME_RE = /^(\d+)\.chunk$/;

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function getUploadDir(session: UploadSessionRef) {
  return path.join(UPLOADS_ROOT, normalizeSessionId(session.id));
}

function getChunksDir(session: UploadSessionRef) {
  return path.join(getUploadDir(session), 'chunks');
}

function getManifestPath(session: UploadSessionRef) {
  return path.join(getUploadDir(session), 'manifest.json');
}

function getMergedFilePath(session: UploadSessionRef, ext: string) {
  return path.join(getUploadDir(session), `merged${ext}`);
}

function getChunkFilePath(session: UploadSessionRef, seq: number) {
  return path.join(getChunksDir(session), `${String(seq).padStart(8, '0')}.chunk`);
}

async function ensureDir(session: UploadSessionRef) {
  await fs.mkdir(getChunksDir(session), { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function scanChunkSeqsOnDisk(session: UploadSessionSource): Promise<number[]> {
  try {
    const files = await fs.readdir(getChunksDir(session));
    const seqs: number[] = [];
    for (const file of files) {
      const match = CHUNK_FILENAME_RE.exec(file);
      if (!match) continue;
      const seq = Number.parseInt(match[1], 10);
      if (Number.isInteger(seq) && seq >= 0) seqs.push(seq);
    }
    seqs.sort((a, b) => a - b);
    return seqs;
  } catch {
    return [];
  }
}

async function readMetadata(session: UploadSessionSource): Promise<StoredManifestMetadata | null> {
  const manifestPath = getManifestPath(session);
  if (!(await fileExists(manifestPath))) return null;

  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredManifestMetadata>;
    if (
      parsed.sessionId !== session.id ||
      parsed.userId !== session.userId ||
      typeof parsed.originalFileName !== 'string' ||
      typeof parsed.originalMimeType !== 'string' ||
      typeof parsed.originalSize !== 'number' ||
      typeof parsed.totalChunks !== 'number' ||
      typeof parsed.chunkSize !== 'number' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      originalFileName: parsed.originalFileName,
      originalMimeType: parsed.originalMimeType,
      originalSize: parsed.originalSize,
      totalChunks: parsed.totalChunks,
      chunkSize: parsed.chunkSize,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

async function writeMetadata(session: UploadSessionSource, metadata: StoredManifestMetadata) {
  await ensureDir(session);
  await fs.writeFile(getManifestPath(session), JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * 初始化上传会话（第一次 init 调用）。如果已存在则保留 createdAt。
 */
export async function initAsyncUpload(
  session: UploadSessionSource,
  input: {
    originalFileName: string;
    originalMimeType: string;
    originalSize: number;
    totalChunks: number;
    chunkSize: number;
  }
): Promise<AsyncUploadManifest> {
  const existing = await readMetadata(session);
  const now = Date.now();
  const metadata: StoredManifestMetadata = {
    sessionId: session.id,
    userId: session.userId,
    originalFileName: input.originalFileName,
    originalMimeType: input.originalMimeType,
    originalSize: input.originalSize,
    totalChunks: input.totalChunks,
    chunkSize: input.chunkSize,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeMetadata(session, metadata);
  const receivedSeqs = await scanChunkSeqsOnDisk(session);
  return { ...metadata, receivedSeqs };
}

export async function loadAsyncUploadManifest(
  session: UploadSessionSource
): Promise<AsyncUploadManifest | null> {
  const metadata = await readMetadata(session);
  if (!metadata) return null;
  const receivedSeqs = await scanChunkSeqsOnDisk(session);
  return { ...metadata, receivedSeqs };
}

export async function persistAsyncUploadChunk(
  session: UploadSessionSource,
  options: { seq: number; data: Buffer }
): Promise<AsyncUploadManifest> {
  const existing = await readMetadata(session);
  if (!existing) {
    throw new Error('Upload not initialized');
  }
  if (options.seq < 0 || options.seq >= existing.totalChunks) {
    throw new Error('seq out of range');
  }

  await ensureDir(session);
  // 写到临时文件再 rename，避免并发写同 seq 时半截内容
  const finalPath = getChunkFilePath(session, options.seq);
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, options.data);
  await fs.rename(tempPath, finalPath);

  const now = Date.now();
  await writeMetadata(session, { ...existing, updatedAt: now });

  const receivedSeqs = await scanChunkSeqsOnDisk(session);
  return { ...existing, updatedAt: now, receivedSeqs };
}

/**
 * 合并所有分片到一个文件，返回合并后文件路径。
 * 调用前应确保 receivedSeqs.length === totalChunks。
 *
 * 用流式 append 而不是 Buffer.concat —— 几个 GB 文件全 buffer 进内存会爆。
 */
export async function mergeAsyncUploadChunks(
  session: UploadSessionSource
): Promise<{ filePath: string; manifest: AsyncUploadManifest }> {
  const manifest = await loadAsyncUploadManifest(session);
  if (!manifest) {
    throw new Error('Upload not initialized');
  }
  if (manifest.receivedSeqs.length !== manifest.totalChunks) {
    throw new Error(
      `Missing chunks: have ${manifest.receivedSeqs.length} of ${manifest.totalChunks}`
    );
  }

  // 保留原扩展名（ffmpeg 自动识别格式时可用，作为兜底；它主要靠魔数嗅探）
  const ext = path.extname(manifest.originalFileName).toLowerCase() || '.bin';
  const mergedPath = getMergedFilePath(session, ext);

  // 已存在则先删
  await fs.rm(mergedPath, { force: true });

  const handle = await fs.open(mergedPath, 'w');
  try {
    for (let seq = 0; seq < manifest.totalChunks; seq++) {
      const chunkPath = getChunkFilePath(session, seq);
      const data = await fs.readFile(chunkPath);
      await handle.writeFile(data);
    }
  } finally {
    await handle.close();
  }

  return { filePath: mergedPath, manifest };
}

export async function deleteAsyncUpload(session: UploadSessionRef): Promise<void> {
  await fs.rm(getUploadDir(session), { recursive: true, force: true });
}

/**
 * 只清理 chunks（保留 merged + manifest）。finalize 后 chunks 不再需要，但
 * merged 文件可能还要传给 ffmpeg，所以单独保留。
 */
export async function deleteAsyncUploadChunksOnly(
  session: UploadSessionRef
): Promise<void> {
  await fs.rm(getChunksDir(session), { recursive: true, force: true });
}
