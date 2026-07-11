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
  // P1-7：草稿被收尾流程封存（seal）的时刻；非空表示不再接受任何分片写入。
  sealedAt?: number;
}

// manifest.json 只存元数据——完整性判定用的 receivedSeqs 始终从 chunks/ 目录扫描得到
//（loadRecordingDraftManifest / 清单摘要 / merge 均以磁盘为权威，杜绝并发写入时 manifest 的
// read-modify-write 竞态误判缺片）。
// P1-6：额外维护 chunkCount / maxSeq 作为「写入热路径」的 O(1) 近似计数，专供每片 POST 的响应
// 与配额上限守卫使用——避免旧实现每写一片都 readdir+sort 全目录（4h 录音 O(n²)）。并发突发下
// 该计数可能短暂偏小（多写者各自 read-modify-write 互相覆盖），故**绝不**用于完整性/nextSeq 协商；
// 那些路径一律回到磁盘扫描取权威值。
interface StoredManifestMetadata {
  sessionId: string;
  userId: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  // P1-7：seal 时刻（epoch ms）。持久化在 manifest 元数据上，跨请求生效。
  sealedAt?: number;
  // P1-6：维护式近似计数（见上）。缺失（旧版 manifest）时由写入路径一次性扫盘播种。
  chunkCount?: number;
  maxSeq?: number;
}

/** P0-4：草稿清单摘要，供客户端冷启动/续录前协商起始 seq（nextSeq = 服务端 maxSeq+1）。 */
export interface RecordingDraftManifestSummary {
  // 已保存的最大 seq；无任何分片时为 -1。
  maxSeq: number;
  // 客户端下一个应写入的 seq（= maxSeq + 1）；全新会话为 0。
  nextSeq: number;
  // 单调递增的修订号（取 manifest updatedAt），供客户端检测服务端草稿是否被并发改动。
  revision: number;
  // 是否已被 seal（收尾封存）；true 时任何写入会被 409。
  sealed: boolean;
}

/** P0-4：目标 seq 已存在且内容不同——绝不覆盖已上传分片，路由据此返回 409。 */
export class RecordingDraftChunkConflictError extends Error {
  seq: number;
  constructor(seq: number) {
    super(`Recording draft chunk seq ${seq} already exists with different content`);
    this.name = 'RecordingDraftChunkConflictError';
    this.seq = seq;
  }
}

/** P1-7：草稿已被 seal（收尾封存），拒绝迟到的分片写入，路由据此返回 409。 */
export class RecordingDraftSealedError extends Error {
  constructor() {
    super('Recording draft is sealed; no further chunks accepted');
    this.name = 'RecordingDraftSealedError';
  }
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
      ...(typeof parsed.sealedAt === 'number' ? { sealedAt: parsed.sealedAt } : {}),
      ...(typeof parsed.chunkCount === 'number' ? { chunkCount: parsed.chunkCount } : {}),
      ...(typeof parsed.maxSeq === 'number' ? { maxSeq: parsed.maxSeq } : {}),
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

/**
 * P0-4：读草稿清单摘要（供客户端冷启动/续录 recorder.start() 前 GET，把起始 seq 设为 nextSeq）。
 * 无草稿时返回 maxSeq=-1、nextSeq=0（全新会话从 0 开始）。
 */
export async function getRecordingDraftManifestSummary(
  session: DraftSessionSource
): Promise<RecordingDraftManifestSummary> {
  const metadata = await readStoredManifestMetadata(session);
  const seqs = await scanChunkSeqsOnDisk(session);
  const maxSeq = seqs.length > 0 ? seqs[seqs.length - 1] : -1;
  return {
    maxSeq,
    nextSeq: maxSeq + 1,
    revision: metadata?.updatedAt ?? 0,
    sealed: Boolean(metadata?.sealedAt),
  };
}

export async function isRecordingDraftSealed(
  session: DraftSessionSource
): Promise<boolean> {
  const metadata = await readStoredManifestMetadata(session);
  return Boolean(metadata?.sealedAt);
}

/**
 * P1-7 阶段①：封存草稿。此后任何分片写入（persistRecordingDraftChunk）与 transcript 草稿写入
 * 一律被 409 拒绝，杜绝收尾读取快照后到达的迟到写在 merge/删草稿之间丢数据。幂等：已 seal
 * 不改 sealedAt。若草稿元数据尚不存在则创建（确保后续迟到写也被封住）。
 */
export async function sealRecordingDraft(
  session: DraftSessionSource
): Promise<RecordingDraftManifestSummary> {
  const now = Date.now();
  const existing = await readStoredManifestMetadata(session);
  const metadata: StoredManifestMetadata = {
    sessionId: session.id,
    userId: session.userId,
    mimeType: existing?.mimeType ?? 'audio/webm',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sealedAt: existing?.sealedAt ?? now,
  };
  await writeStoredManifestMetadata(session, metadata);
  return getRecordingDraftManifestSummary(session);
}

/**
 * P1-7 释放封存：收尾未提交（草稿缺片/CAS 落空/出错）时解除 seal，让客户端得以补传缺失分片后
 * 重试收尾，避免「seal 后缺片 → 永久 409 → 无法补传」的死锁。仅在草稿仍存在时生效。
 */
export async function unsealRecordingDraft(
  session: DraftSessionSource
): Promise<void> {
  const existing = await readStoredManifestMetadata(session);
  if (!existing || !existing.sealedAt) {
    return;
  }
  const { sealedAt: _sealedAt, ...rest } = existing;
  void _sealedAt;
  await writeStoredManifestMetadata(session, { ...rest, updatedAt: Date.now() });
}

export async function listRecordingDraftSeqs(
  session: DraftSessionSource
): Promise<number[]> {
  return scanChunkSeqsOnDisk(session);
}

async function readChunkIfExists(chunkPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(chunkPath);
  } catch {
    return null;
  }
}

export async function persistRecordingDraftChunk(
  session: DraftSessionSource,
  options: { seq: number; mimeType: string; data: Buffer }
): Promise<{ idempotent: boolean; chunkCount: number; maxSeq: number }> {
  await ensureDraftDir(session);

  const existing = await readStoredManifestMetadata(session);

  // P1-7：已封存的草稿拒绝任何新分片（收尾 seal 之后到达的迟到写）。
  if (existing?.sealedAt) {
    throw new RecordingDraftSealedError();
  }

  // P1-6：热路径 O(1) 计数——正常情况下直接沿用 manifest 里维护的 chunkCount/maxSeq；仅当元数据
  // 缺该计数（旧版 manifest / 服务重启后遇既有草稿）时一次性扫盘播种，此后按增量维护，杜绝旧实现
  // 每写一片都 readdir+sort 全目录的 O(n²)。
  let baseCount: number;
  let baseMaxSeq: number;
  if (
    typeof existing?.chunkCount === 'number' &&
    typeof existing?.maxSeq === 'number'
  ) {
    baseCount = existing.chunkCount;
    baseMaxSeq = existing.maxSeq;
  } else {
    const seedSeqs = await scanChunkSeqsOnDisk(session);
    baseCount = seedSeqs.length;
    baseMaxSeq = seedSeqs.length > 0 ? seedSeqs[seedSeqs.length - 1] : -1;
  }

  // P0-4：append-only —— 按 (sessionId, seq) 键写盘，目标 seq 已存在时绝不覆盖：
  // 内容(长度+字节)完全一致 → 幂等成功（网络重试）；不一致 → 冲突 409。旧代码无条件
  // writeFile 覆盖，导致冷设备续录从 seq 0 重传时把服务端已有录音开头覆盖损坏（审计 P0-4）。
  const chunkPath = getChunkFilePath(session, options.seq);
  const priorChunk = await readChunkIfExists(chunkPath);
  let idempotent = false;
  if (priorChunk) {
    if (priorChunk.length === options.data.length && priorChunk.equals(options.data)) {
      idempotent = true;
    } else {
      throw new RecordingDraftChunkConflictError(options.seq);
    }
  } else {
    await fs.writeFile(chunkPath, options.data);
  }

  // 新写入的分片才递增计数；幂等重传（seq 已在盘）不重复计。
  const chunkCount = idempotent ? baseCount : baseCount + 1;
  const maxSeq = idempotent ? baseMaxSeq : Math.max(baseMaxSeq, options.seq);

  const now = Date.now();
  const metadata: StoredManifestMetadata = {
    sessionId: session.id,
    userId: session.userId,
    mimeType: options.mimeType || existing?.mimeType || 'audio/webm',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.sealedAt ? { sealedAt: existing.sealedAt } : {}),
    chunkCount,
    maxSeq,
  };

  await writeStoredManifestMetadata(session, metadata);

  return { idempotent, chunkCount, maxSeq };
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

  // 完整性按「从 seq 0 起的连续集合包含」判定（契约2/审计 P0-5）：媒体容器（webm/mp4）的
  // 分片必须从首块 seq 0 起连续，缺任何块（含 leading gap —— 首块不是 seq 0）都会让音频解码
  // 损坏。只合并从 seq 0 起的最长连续前缀，其余丢弃。旧代码用 expected=seqs[0] 起算，会把
  // 「缺开头 seq 0」误判为无空洞（hasGap=false），令上层误删唯一完整副本；这里改从 0 起算，
  // 任何缺口（含 leading gap）都 hasGap=true。
  const seqs = [...manifest.receivedSeqs].sort((a, b) => a - b);
  const contiguous: number[] = [];
  let expected = 0;
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
      `[recordingDraft] seq 空洞：共 ${seqs.length} 片但仅前 ${contiguous.length} 片自 seq 0 起连续` +
        `（缺 seq ${expected}，首块为 seq ${seqs[0]}），session=${session.id}，` +
        `只合并连续前缀以保证可播放`
    );
  }

  const buffer = await mergeContiguousChunksSequential(session, contiguous);

  return {
    buffer,
    manifest,
    hasGap,
  };
}

/**
 * P1-6：顺序流式合并连续前缀分片。逐个 stat 求总长 → 单次分配 → 顺序读入对应 offset，
 * 任一时刻仅持有一个分片缓冲与一个文件描述符。旧实现 `Promise.all(seqs.map(readFile))` 会在
 * 数千~数万分片时一次性打开全部 FD（EMFILE 崩溃），并在内存里同时堆叠 buffers[] 与
 * Buffer.concat 结果（≈双倍峰值内存）。此处顺序读、各分片缓冲读完即可回收，峰值 ≈ 合并结果 + 单片。
 */
async function mergeContiguousChunksSequential(
  session: DraftSessionSource,
  seqs: number[]
): Promise<Buffer> {
  if (seqs.length === 0) {
    return Buffer.alloc(0);
  }

  const paths = seqs.map((seq) => getChunkFilePath(session, seq));
  const sizes: number[] = [];
  let total = 0;
  for (const chunkPath of paths) {
    const stat = await fs.stat(chunkPath);
    sizes.push(stat.size);
    total += stat.size;
  }

  const merged = Buffer.allocUnsafe(total);
  let offset = 0;
  for (let i = 0; i < paths.length; i += 1) {
    // 顺序读：一次仅打开一个分片文件，读入合并缓冲后该分片缓冲即可被 GC 回收。
    const chunk = await fs.readFile(paths[i]);
    chunk.copy(merged, offset);
    offset += chunk.length;
  }

  // sizes 与实际读入一致时 offset 应等于 total；若期间分片被并发改动（不应发生：merge 只在
  // seal 后调用）导致长度不符，截断到实际写入长度，避免返回尾部未初始化内存。
  return offset === total ? merged : merged.subarray(0, offset);
}

export async function deleteRecordingDraft(
  session: DraftSessionSource
): Promise<void> {
  await fs.rm(getDraftDir(session), { recursive: true, force: true });
}
