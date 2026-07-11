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
import crypto from 'crypto';
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
  /** 可选：整文件 sha256（前端声明）。merge 时逐字节复算并比对，声明不符则拒（P1-15）。 */
  expectedSha256?: string | null;
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
  expectedSha256?: string | null;
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
      expectedSha256:
        typeof parsed.expectedSha256 === 'string' ? parsed.expectedSha256 : null,
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
 * 判断已存在的 manifest 与本次 init 声明的「分片布局」是否完全一致 —— 只有一致才能续传，
 * 否则旧分片会混入新清单（旧文件较小时旧 seq 让 receivedCount 永远大于 totalChunks，
 * 新上传永远无法 finalize；或旧内容被误当新文件的分片）。
 */
function layoutMatches(
  existing: StoredManifestMetadata,
  input: {
    originalFileName: string;
    originalMimeType: string;
    originalSize: number;
    totalChunks: number;
    chunkSize: number;
    expectedSha256?: string | null;
  }
): boolean {
  const hashMatches =
    // 任一方没声明 hash 时不以 hash 判负（保持向后兼容）；两方都声明才要求一致。
    !existing.expectedSha256 || !input.expectedSha256
      ? true
      : existing.expectedSha256 === input.expectedSha256;
  return (
    existing.originalSize === input.originalSize &&
    existing.totalChunks === input.totalChunks &&
    existing.chunkSize === input.chunkSize &&
    existing.originalFileName === input.originalFileName &&
    existing.originalMimeType === input.originalMimeType &&
    hashMatches
  );
}

/**
 * 原子清空分片目录（换文件/换切片布局时用）：先删整个 chunks 目录再重建，旧 seq 不残留。
 */
async function resetChunks(session: UploadSessionRef) {
  await fs.rm(getChunksDir(session), { recursive: true, force: true });
  await fs.mkdir(getChunksDir(session), { recursive: true });
}

/**
 * 初始化上传会话（第一次 init 调用）。如果已存在则保留 createdAt。
 *
 * P1-14：re-init 时只有当分片布局（大小/片数/片长/文件名/MIME[/hash]）与旧 manifest 完全
 * 一致才允许续传旧分片；任一不一致 → 原子清空旧 chunks 并按新文件重来，杜绝旧分片混入新清单。
 */
export async function initAsyncUpload(
  session: UploadSessionSource,
  input: {
    originalFileName: string;
    originalMimeType: string;
    originalSize: number;
    totalChunks: number;
    chunkSize: number;
    expectedSha256?: string | null;
  }
): Promise<AsyncUploadManifest> {
  const existing = await readMetadata(session);
  const now = Date.now();
  const resume = existing != null && layoutMatches(existing, input);
  if (existing != null && !resume) {
    // 布局变了（换了文件或改了切片方式）：清掉旧分片，视为全新上传。
    await resetChunks(session);
  }
  const metadata: StoredManifestMetadata = {
    sessionId: session.id,
    userId: session.userId,
    originalFileName: input.originalFileName,
    originalMimeType: input.originalMimeType,
    originalSize: input.originalSize,
    totalChunks: input.totalChunks,
    chunkSize: input.chunkSize,
    expectedSha256: input.expectedSha256 ?? null,
    // 续传保留 createdAt；换文件重来则以本次为准。
    createdAt: resume ? existing!.createdAt : now,
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
 *
 * P1-15：合并时精校「实际总字节 === 声明 originalSize」，并逐字节复算 sha256；若 manifest 带
 * expectedSha256 则比对。声明的 originalSize/totalChunks/chunkSize/hash 不可信，任一不符即拒，
 * 杜绝「声明 1 字节实传 20MB」之类绕过大小 / 配额估算。
 */
export async function mergeAsyncUploadChunks(
  session: UploadSessionSource
): Promise<{ filePath: string; manifest: AsyncUploadManifest; sha256: string; totalBytes: number }> {
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

  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  const handle = await fs.open(mergedPath, 'w');
  try {
    for (let seq = 0; seq < manifest.totalChunks; seq++) {
      const chunkPath = getChunkFilePath(session, seq);
      const data = await fs.readFile(chunkPath);
      // 非末片必须恰为 chunkSize；末片必须恰为 originalSize 的余数（不可为 0）。
      const expectedLen =
        seq === manifest.totalChunks - 1
          ? manifest.originalSize - (manifest.totalChunks - 1) * manifest.chunkSize
          : manifest.chunkSize;
      if (data.length !== expectedLen) {
        await handle.close();
        await fs.rm(mergedPath, { force: true });
        throw new Error(
          `Chunk ${seq} length ${data.length} !== expected ${expectedLen}`
        );
      }
      hash.update(data);
      totalBytes += data.length;
      await handle.writeFile(data);
    }
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(mergedPath, { force: true }).catch(() => undefined);
    throw err;
  }
  await handle.close();

  // 实际总字节必须与声明 originalSize 一致（声明不可撒谎）。
  if (totalBytes !== manifest.originalSize) {
    await fs.rm(mergedPath, { force: true }).catch(() => undefined);
    throw new Error(
      `Merged size ${totalBytes} !== declared originalSize ${manifest.originalSize}`
    );
  }

  const sha256 = hash.digest('hex');
  // 前端声明了整文件 hash 则强校验（防篡改 / 传错文件）。
  if (manifest.expectedSha256 && manifest.expectedSha256 !== sha256) {
    await fs.rm(mergedPath, { force: true }).catch(() => undefined);
    throw new Error('Merged file sha256 mismatch with declared expectedSha256');
  }

  return { filePath: mergedPath, manifest, sha256, totalBytes };
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
