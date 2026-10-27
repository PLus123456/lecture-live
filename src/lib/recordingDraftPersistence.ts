import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { withSessionDraftLock } from '@/lib/sessionDraftLock';
import type { Session } from '@prisma/client';
import {
  STORED_ARTIFACT_STATE,
  STORED_ARTIFACT_TYPE,
  StoredArtifactPublishConflictError,
  StoredArtifactPublishOutcomeUnknownError,
  buildStoredArtifactLogicalKey,
  findBillableStoredArtifactsByOwner,
  getActiveStoredArtifactByLogicalKey,
  getStoredArtifactById,
  markStoredArtifactsDeletePending,
  recordReservedStoredArtifactLocation,
  releaseStoredArtifact,
  reserveStoredArtifact,
  rollbackStoredArtifact,
  settleStoredArtifact,
  type StoredArtifactRow,
} from '@/lib/storage/storedArtifactLedger';

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
  sealToken?: string;
  expectedChunkCount?: number;
}

// manifest 只存元数据——完整性判定用的 receivedSeqs 从 chunks/ 与 ACTIVE 账本联合读取
//（loadRecordingDraftManifest / 清单摘要 / merge 均扫描已发布分片，杜绝并发写入时 manifest 的
// read-modify-write 竞态误判缺片）。
// P1-6：额外维护 chunkCount / maxSeq 作为「写入热路径」的 O(1) 近似计数，专供每片 POST 的响应
// 与配额上限守卫使用——避免旧实现每写一片都 readdir+sort 全目录（4h 录音 O(n²)）。进程若在
// 发布分片之后、更新计数之前崩溃，计数可能偏小，故**绝不**用于完整性/nextSeq 协商；
// 那些路径一律回到磁盘扫描取权威值。
interface StoredManifestMetadata {
  sessionId: string;
  userId: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  // P1-7：seal 时刻（epoch ms）。持久化在 manifest 元数据上，跨请求生效。
  sealedAt?: number;
  sealToken?: string;
  expectedChunkCount?: number;
  // P1-6：维护式近似计数（见上）。缺失（旧版 manifest）时由写入路径一次性扫盘播种。
  chunkCount?: number;
  maxSeq?: number;
  // P4-1：已落盘字节总数，供总量闸使用。与 chunkCount 同为维护式计数，缺失时扫盘播种。
  totalBytes?: number;
}

// P4-1：单会话草稿字节总量上限。
// 上界依据：webm/opus 默认约 128kbps ⇒ 512MiB ≈ 9.3 小时录音，而 PRO 单场上限 4h（≈230MB）、
// FREE 2h，合法录音有 2-4× 余量绝不会触顶；旧代码只有「50000 片 × 2MiB = 97.65GiB/会话」的
// 片数闸，等于没有闸（磁盘先被打爆，finalize 再把主进程 OOM 掉）。
// 同一常量也守着 merge 的整份分配（见 mergeContiguousChunksSequential）——两处必须同值，
// 否则「写得进去却合并不出来」= 用户录音永久卡死。
// 允许用 RECORDING_DRAFT_MAX_TOTAL_BYTES 下调（小盘部署 / 测试）。
const DEFAULT_MAX_DRAFT_TOTAL_BYTES = 512 * 1024 * 1024;

function resolveMaxDraftTotalBytes(): number {
  const raw = Number.parseInt(
    process.env.RECORDING_DRAFT_MAX_TOTAL_BYTES ?? '',
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DRAFT_TOTAL_BYTES;
}

export const MAX_DRAFT_TOTAL_BYTES = resolveMaxDraftTotalBytes();

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

/** P4-1：草稿总字节数触顶（写入侧）或合并结果超上限（收尾侧），路由据此返回 413。 */
export class RecordingDraftTooLargeError extends Error {
  totalBytes: number;
  limitBytes: number;
  constructor(totalBytes: number) {
    super(
      `Recording draft exceeds ${MAX_DRAFT_TOTAL_BYTES} bytes (would be ${totalBytes})`
    );
    this.name = 'RecordingDraftTooLargeError';
    this.totalBytes = totalBytes;
    this.limitBytes = MAX_DRAFT_TOTAL_BYTES;
  }
}

type DraftSessionSource = Pick<Session, 'id' | 'userId'>;

const CHUNK_FILENAME_RE = /^(\d+)(?:\.([a-zA-Z0-9-]+))?\.chunk$/;

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

function getDraftManifestLogicalKey(session: DraftSessionSource) {
  return buildStoredArtifactLogicalKey(
    'draft',
    `${session.id}:manifest`,
    STORED_ARTIFACT_TYPE.RECORDING_DRAFT
  );
}

function getChunkFilePath(session: DraftSessionSource, seq: number, version?: string) {
  return path.join(
    getDraftChunksDir(session),
    `${String(seq).padStart(8, '0')}${version ? `.${version}` : ''}.chunk`
  );
}

function getDraftLocalReference(session: DraftSessionSource, fileName: string) {
  return `local:recording-drafts/${normalizeSessionId(session.id)}/${fileName}`;
}

function pathForRecordingDraftReference(
  session: DraftSessionSource,
  reference: string | null
): string | null {
  const prefix = `local:recording-drafts/${normalizeSessionId(session.id)}/`;
  if (!reference?.startsWith(prefix)) return null;
  const relative = reference.slice(prefix.length);
  if (
    !/^[a-zA-Z0-9._/-]+$/.test(relative) ||
    relative.split('/').some((part) => !part || part === '..')
  ) {
    return null;
  }
  const resolved = path.resolve(getDraftDir(session), relative);
  const root = `${path.resolve(getDraftDir(session))}${path.sep}`;
  return resolved.startsWith(root) ? resolved : null;
}

async function resolveDraftManifestPath(
  session: DraftSessionSource
): Promise<string | null> {
  const active = await getActiveStoredArtifactByLogicalKey(
    getDraftManifestLogicalKey(session)
  );
  if (!active) return getDraftManifestPath(session);
  if (
    active.userId !== session.userId ||
    active.ownerType !== 'draft' ||
    active.ownerId !== session.id ||
    active.artifactType !== STORED_ARTIFACT_TYPE.RECORDING_DRAFT ||
    active.storage !== 'local'
  ) {
    return null;
  }
  const resolved = pathForRecordingDraftReference(session, active.reference);
  if (!resolved) throw new Error('Invalid draft artifact reference');
  try {
    await fs.access(resolved);
  } catch (error) {
    throw new Error('Referenced draft file is unavailable; preserving recovery state', { cause: error });
  }
  return resolved;
}

async function ensureDraftDir(session: DraftSessionSource) {
  await fs.mkdir(getDraftChunksDir(session), { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 只把完整发布的版本暴露给清单；旧固定文件名继续兼容。 */
async function scanChunkFilesOnDisk(session: DraftSessionSource): Promise<Map<number, string>> {
  let files: string[];
  try {
    files = await fs.readdir(getDraftChunksDir(session));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const artifacts = await findBillableStoredArtifactsByOwner('draft', session.id);
  const trackedReferences = new Set(artifacts.map((row) => row.reference));
  const activeReferences = new Set(artifacts.filter((row) =>
    row.artifactType === STORED_ARTIFACT_TYPE.RECORDING_DRAFT && row.state === STORED_ARTIFACT_STATE.ACTIVE
  ).map((row) => row.reference));
  const result = new Map<number, string>();
  for (const file of files) {
    const match = CHUNK_FILENAME_RE.exec(file);
    if (!match) continue;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq) || seq < 0) continue;
    const reference = getDraftLocalReference(session, `chunks/${file}`);
    if ((match[2] || trackedReferences.has(reference)) && !activeReferences.has(reference)) continue;
    // 同一序号升级成版本文件后优先新版本，旧预留回收只能碰旧路径。
    if (match[2] || !result.has(seq)) result.set(seq, path.join(getDraftChunksDir(session), file));
  }
  return result;
}

async function scanChunkSeqsOnDisk(session: DraftSessionSource): Promise<number[]> {
  return [...(await scanChunkFilesOnDisk(session)).keys()].sort((a, b) => a - b);
}

/**
 * P4-1：扫盘播种维护式计数（片数 / maxSeq / 总字节）。仅在 manifest 缺计数字段时走一次
 * （旧版 manifest / 服务重启后遇既有草稿），此后由写入路径按增量维护，热路径零 readdir。
 */
async function scanChunkStatsOnDisk(
  session: DraftSessionSource
): Promise<{ count: number; maxSeq: number; totalBytes: number }> {
  const files = await scanChunkFilesOnDisk(session);
  const seqs = [...files.keys()].sort((a, b) => a - b);
  let totalBytes = 0;
  for (const seq of seqs) {
    const stat = await fs.stat(files.get(seq)!);
    totalBytes += stat.size;
  }
  return {
    count: seqs.length,
    maxSeq: seqs.length > 0 ? seqs[seqs.length - 1] : -1,
    totalBytes,
  };
}

async function readStoredManifestMetadata(
  session: DraftSessionSource
): Promise<StoredManifestMetadata | null> {
  const manifestPath = await resolveDraftManifestPath(session);
  if (!manifestPath) return null;
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
      throw new Error('Invalid recording draft metadata');
    }
    return {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      mimeType: parsed.mimeType,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.sealedAt === 'number' ? { sealedAt: parsed.sealedAt } : {}),
      ...(typeof parsed.sealToken === 'string' ? { sealToken: parsed.sealToken } : {}),
      ...(Number.isSafeInteger(parsed.expectedChunkCount) && parsed.expectedChunkCount! >= 0
        ? { expectedChunkCount: parsed.expectedChunkCount } : {}),
      ...(typeof parsed.chunkCount === 'number' ? { chunkCount: parsed.chunkCount } : {}),
      ...(typeof parsed.maxSeq === 'number' ? { maxSeq: parsed.maxSeq } : {}),
      ...(typeof parsed.totalBytes === 'number' ? { totalBytes: parsed.totalBytes } : {}),
    };
  } catch (error) {
    throw new Error('Recording draft metadata could not be read; preserving draft', { cause: error });
  }
}

// Web 上传与 WS 回收必须共享文件系统锁；同一锁也保护转录快照和草稿清理。
async function withManifestLock<T>(
  session: DraftSessionSource,
  fn: () => Promise<T>
): Promise<T> {
  return withSessionDraftLock(session.id, fn);
}

/**
 * P7-5：临界区内的原子 read-modify-write —— mutator 拿到的一定是**当前**磁盘状态，
 * 返回 null 表示放弃写入。所有会改 manifest 的路径都必须走这里，不许在锁外读快照再回写。
 */
async function updateStoredManifestMetadata<T>(
  session: DraftSessionSource,
  mutator: (
    current: StoredManifestMetadata | null
  ) => Promise<{ metadata: StoredManifestMetadata; result: T } | null> | {
    metadata: StoredManifestMetadata;
    result: T;
  } | null
): Promise<T | null> {
  return withManifestLock(session, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await readStoredManifestMetadata(session);
      const next = await mutator(current);
      if (!next) {
        return null;
      }
      try {
        await writeStoredManifestMetadata(session, next.metadata);
        return next.result;
      } catch (error) {
        if (
          !(error instanceof StoredArtifactPublishConflictError) ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    return null;
  });
}

// 原子写 manifest：先写同目录唯一临时文件，再 rename 覆盖目标（同分区 rename 是原子操作，
// 与 transcriptDraftPersistence.writeFileAtomic 同款）。直接对同一路径并发 writeFile 不原子——
// open(O_TRUNC) 与 write 是两步，多写者交错时短 JSON 盖在长 JSON 上会留下尾部残留的坏文件，
// JSON.parse 失败→元数据读为 null→收尾把有分片的草稿当「无草稿」丢录音、seal 状态被隐藏。
// tmp+rename 保证 manifest.json 任一时刻都是某个写者的完整版本（进程被杀/磁盘满同样不留半截）。
async function writeStoredManifestMetadata(
  session: DraftSessionSource,
  metadata: StoredManifestMetadata
) {
  await ensureDraftDir(session);
  const serialized = JSON.stringify(metadata, null, 2);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const generation = crypto.randomUUID();
  const fileName = `manifest-${generation}.json`;
  const manifestPath = path.join(getDraftDir(session), fileName);
  const reference = getDraftLocalReference(session, fileName);
  const reservation = await reserveStoredArtifact({
    userId: session.userId,
    ownerType: 'draft',
    ownerId: session.id,
    sessionId: session.id,
    artifactType: STORED_ARTIFACT_TYPE.RECORDING_DRAFT,
    expectedBytes: bytes,
    logicalKey: getDraftManifestLogicalKey(session),
  });
  const tmpPath = `${manifestPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  let previous: StoredArtifactRow | null = null;
  try {
    // Publish the final immutable reference to the reservation before touching the
    // filesystem, so a crash after rename is still discoverable by TTL cleanup.
    await recordReservedStoredArtifactLocation(reservation.id, {
      actualBytes: bytes,
      storage: 'local',
      reference,
    });
    await fs.writeFile(tmpPath, serialized, 'utf-8');
    await fs.rename(tmpPath, manifestPath);
    const settled = await settleStoredArtifact(reservation.id, {
      actualBytes: bytes,
      storage: 'local',
      reference,
      expectedPreviousArtifactId: reservation.replacesArtifactId,
    });
    previous = settled.previous;
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    let row: StoredArtifactRow | null;
    try {
      row = await getStoredArtifactById(reservation.id);
    } catch {
      throw new StoredArtifactPublishOutcomeUnknownError();
    }
    const committed =
      row?.state === STORED_ARTIFACT_STATE.ACTIVE &&
      row.reference === reference &&
      row.identityKey === reservation.logicalKey;
    if (!committed) {
      const definitelyNotCommitted =
        row?.state === STORED_ARTIFACT_STATE.RESERVED &&
        row.reference === reference;
      if (definitelyNotCommitted) {
        const deleted = await fs
          .rm(manifestPath, { force: true })
          .then(() => true)
          .catch(() => false);
        if (deleted) {
          await rollbackStoredArtifact(reservation.id).catch(() => undefined);
        }
        throw error;
      }
      throw new StoredArtifactPublishOutcomeUnknownError();
    }
    previous = reservation.replacesArtifactId
      ? await getStoredArtifactById(reservation.replacesArtifactId).catch(
          () => null
        )
      : null;
  }

  if (previous) {
    const previousPath = pathForRecordingDraftReference(
      session,
      previous.reference
    );
    if (previousPath) {
      const deleted = await fs
        .rm(previousPath, { force: true })
        .then(() => true)
        .catch(() => false);
      if (deleted) {
        await releaseStoredArtifact(previous.id, 'REPLACED').catch(
          () => undefined
        );
      }
    }
  }
}

export async function loadRecordingDraftManifest(
  session: DraftSessionSource
): Promise<RecordingDraftManifest | null> {
  return withSessionDraftLock(session.id, async () => {
    const metadata = await readStoredManifestMetadata(session);
    if (!metadata) {
      return null;
    }
    const receivedSeqs = await scanChunkSeqsOnDisk(session);
    return { ...metadata, receivedSeqs };
  });
}

/**
 * P0-4：读草稿清单摘要（供客户端冷启动/续录 recorder.start() 前 GET，把起始 seq 设为 nextSeq）。
 * 无草稿时返回 maxSeq=-1、nextSeq=0（全新会话从 0 开始）。
 */
export async function getRecordingDraftManifestSummary(
  session: DraftSessionSource
): Promise<RecordingDraftManifestSummary> {
  return withSessionDraftLock(session.id, async () => {
    const metadata = await readStoredManifestMetadata(session);
    const seqs = await scanChunkSeqsOnDisk(session);
    const maxSeq = seqs.length > 0 ? seqs[seqs.length - 1] : -1;
    return {
      maxSeq,
      nextSeq: maxSeq + 1,
      revision: metadata?.updatedAt ?? 0,
      sealed: Boolean(metadata?.sealedAt),
    };
  });
}

export async function isRecordingDraftSealed(
  session: DraftSessionSource
): Promise<boolean> {
  return withSessionDraftLock(session.id, async () => {
    const metadata = await readStoredManifestMetadata(session);
    return Boolean(metadata?.sealedAt);
  });
}

/**
 * P1-7 阶段①：封存草稿。此后任何分片写入（persistRecordingDraftChunk）与 transcript 草稿写入
 * 一律被 409 拒绝，杜绝收尾读取快照后到达的迟到写在 merge/删草稿之间丢数据。幂等：已 seal
 * 不改 sealedAt。若草稿元数据尚不存在则创建（确保后续迟到写也被封住）。
 */
export async function sealRecordingDraft(
  session: DraftSessionSource,
  expectedChunkCount?: number,
  sealToken?: string
): Promise<RecordingDraftManifestSummary> {
  const now = Date.now();
  // P7-5：在锁内读当前 manifest 再写，且**保留**已维护的计数字段——旧实现整份重建元数据，
  // 把 chunkCount/maxSeq/totalBytes 一并抹掉，seal 之后的写入路径又得扫盘重新播种。
  await updateStoredManifestMetadata(session, (existing) => ({
    metadata: {
      ...(existing ?? {}),
      sessionId: session.id,
      userId: session.userId,
      mimeType: existing?.mimeType ?? 'audio/webm',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sealedAt: existing?.sealedAt ?? now,
      ...(sealToken ? { sealToken } : {}),
      ...(expectedChunkCount !== undefined ? {
        expectedChunkCount: Math.max(existing?.expectedChunkCount ?? 0, expectedChunkCount),
      } : {}),
    },
    result: true,
  }));
  return getRecordingDraftManifestSummary(session);
}

/**
 * P1-7 释放封存：收尾未提交（草稿缺片/CAS 落空/出错）时解除 seal，让客户端得以补传缺失分片后
 * 重试收尾，避免「seal 后缺片 → 永久 409 → 无法补传」的死锁。仅在草稿仍存在时生效。
 */
export async function unsealRecordingDraft(
  session: DraftSessionSource,
  sealToken?: string
): Promise<void> {
  await updateStoredManifestMetadata(session, (existing) => {
    if (!existing || !existing.sealedAt || (sealToken && existing.sealToken !== sealToken)) {
      return null;
    }
    const { sealedAt: _sealedAt, sealToken: _sealToken, ...rest } = existing;
    void _sealedAt;
    void _sealToken;
    return { metadata: { ...rest, updatedAt: Date.now() }, result: true };
  });
}

export async function listRecordingDraftSeqs(
  session: DraftSessionSource
): Promise<number[]> {
  return scanChunkSeqsOnDisk(session);
}

async function readChunkIfExists(chunkPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(chunkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function persistRecordingDraftChunk(
  session: DraftSessionSource,
  options: { seq: number; mimeType: string; data: Buffer; guard?: () => Promise<boolean> }
): Promise<{ idempotent: boolean; chunkCount: number; maxSeq: number }> {
  await ensureDraftDir(session);

  // P7-5：整段「读 manifest → 判 seal → 写分片 → 回写 manifest」都在同一把会话锁内。
  // 锁外读快照的旧写法有两个洞：① 回写会抹掉期间落地的 sealedAt（seal 栅栏永久失效）；
  // ② seal 落在「判 seal」与「写分片」之间时，分片仍会落盘，随后被 deleteRecordingDraft 一起删。
  const result = await withManifestLock(session, async () => {
    const existing = await readStoredManifestMetadata(session);

    // P1-7：已封存的草稿拒绝任何新分片（收尾 seal 之后到达的迟到写）。
    if (existing?.sealedAt || (options.guard && !(await options.guard()))) {
      throw new RecordingDraftSealedError();
    }

    // P1-6：热路径 O(1) 计数——正常情况下直接沿用 manifest 里维护的 chunkCount/maxSeq；仅当元数据
    // 缺该计数（旧版 manifest / 服务重启后遇既有草稿）时一次性扫盘播种，此后按增量维护，杜绝旧实现
    // 每写一片都 readdir+sort 全目录的 O(n²)。
    let baseCount: number;
    let baseMaxSeq: number;
    let baseBytes: number;
    if (
      typeof existing?.chunkCount === 'number' &&
      typeof existing?.maxSeq === 'number' &&
      typeof existing?.totalBytes === 'number'
    ) {
      baseCount = existing.chunkCount;
      baseMaxSeq = existing.maxSeq;
      baseBytes = existing.totalBytes;
    } else {
      const seeded = await scanChunkStatsOnDisk(session);
      baseCount = seeded.count;
      baseMaxSeq = seeded.maxSeq;
      baseBytes = seeded.totalBytes;
    }

    // P0-4：append-only —— 按 (sessionId, seq) 键写盘，目标 seq 已存在时绝不覆盖：
    // 内容(长度+字节)完全一致 → 幂等成功（网络重试）；不一致 → 冲突 409。旧代码无条件
    // writeFile 覆盖，导致冷设备续录从 seq 0 重传时把服务端已有录音开头覆盖损坏（审计 P0-4）。
    const logicalKey = buildStoredArtifactLogicalKey(
      'draft', `${session.id}:chunk:${options.seq}`, STORED_ARTIFACT_TYPE.RECORDING_DRAFT
    );
    const activeChunk = await getActiveStoredArtifactByLogicalKey(logicalKey);
    const priorPath = activeChunk?.state === STORED_ARTIFACT_STATE.ACTIVE
      ? pathForRecordingDraftReference(session, activeChunk.reference)
      : getChunkFilePath(session, options.seq);
    const priorChunk = priorPath ? await readChunkIfExists(priorPath) : null;
    let idempotent = false;
    if (priorChunk) {
      if (priorChunk.length === options.data.length && priorChunk.equals(options.data)) {
        idempotent = true;
      } else {
        throw new RecordingDraftChunkConflictError(options.seq);
      }
    }
    // 磁盘文件存在但账本未 ACTIVE 不能直接回成功：旧 RESERVED 会在 TTL 后删除它。
    // 重新发布到唯一版本路径，旧预留即使并发回收也碰不到这份已确认的新副本。
    if (!priorChunk || activeChunk?.state !== STORED_ARTIFACT_STATE.ACTIVE) {
      // P4-1：总量闸必须在**落盘之前**判 —— 片数闸（50000×2MiB≈97.65GiB）等于没闸。
      const projectedBytes = baseBytes + options.data.length;
      if (projectedBytes > MAX_DRAFT_TOTAL_BYTES) {
        throw new RecordingDraftTooLargeError(projectedBytes);
      }
      const reservation = await reserveStoredArtifact({
        userId: session.userId,
        ownerType: 'draft',
        ownerId: session.id,
        sessionId: session.id,
        artifactType: STORED_ARTIFACT_TYPE.RECORDING_DRAFT,
        expectedBytes: options.data.length,
        logicalKey,
      });
      const chunkPath = getChunkFilePath(session, options.seq, reservation.id);
      const reference = getDraftLocalReference(session, `chunks/${path.basename(chunkPath)}`);
      let previous: StoredArtifactRow | null = null;
      try {
        await recordReservedStoredArtifactLocation(reservation.id, {
          actualBytes: options.data.length,
          storage: 'local',
          reference,
        });
        const temporaryPath = `${chunkPath}.${reservation.id}.tmp`;
        try {
          await fs.writeFile(temporaryPath, options.data, { flag: 'wx' });
          await fs.rename(temporaryPath, chunkPath);
        } finally {
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
        const settled = await settleStoredArtifact(reservation.id, {
          actualBytes: options.data.length,
          storage: 'local',
          reference,
          expectedPreviousArtifactId: reservation.replacesArtifactId,
        });
        previous = settled.previous;
      } catch (error) {
        let row: StoredArtifactRow | null;
        try {
          row = await getStoredArtifactById(reservation.id);
        } catch {
          throw new StoredArtifactPublishOutcomeUnknownError();
        }
        const committed =
          row?.state === STORED_ARTIFACT_STATE.ACTIVE &&
          row.reference === reference &&
          row.identityKey === reservation.logicalKey;
        if (!committed) {
          const definitelyNotCommitted =
            row?.state === STORED_ARTIFACT_STATE.RESERVED &&
            row.reference === reference;
          if (definitelyNotCommitted) {
            const deleted = await fs
              .rm(chunkPath, { force: true })
              .then(() => true)
              .catch(() => false);
            if (deleted) {
              await rollbackStoredArtifact(reservation.id).catch(
                () => undefined
              );
            }
            throw error;
          }
          throw new StoredArtifactPublishOutcomeUnknownError();
        }
        previous = reservation.replacesArtifactId
          ? await getStoredArtifactById(reservation.replacesArtifactId).catch(
              () => null
            )
          : null;
      }
      // The old physical chunk was already absent (priorChunk === null), so it is
      // safe to retire its stale ledger row without touching the newly-written path.
      if (previous) {
        await releaseStoredArtifact(previous.id, 'REPLACED').catch(
          () => undefined
        );
      }
    }

    if (idempotent && activeChunk?.state !== STORED_ARTIFACT_STATE.ACTIVE) {
      const adopted = await scanChunkStatsOnDisk(session);
      baseCount = adopted.count;
      baseMaxSeq = adopted.maxSeq;
      baseBytes = adopted.totalBytes;
    }
    // 新写入的分片才递增计数；幂等重传（seq 已在盘）不重复计。
    const chunkCount = idempotent ? baseCount : baseCount + 1;
    const maxSeq = idempotent ? baseMaxSeq : Math.max(baseMaxSeq, options.seq);
    const totalBytes = idempotent ? baseBytes : baseBytes + options.data.length;

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
      totalBytes,
    };

    await writeStoredManifestMetadata(session, metadata);

    return { idempotent, chunkCount, maxSeq };
  });

  return result;
}

/**
 * P4-1：O(1) 读草稿用量（只读 manifest，不扫盘）。供路由在写入前做存储配额准入判定——
 * 旧代码只在 `seq === 0` 查配额，而 seq 不要求连续，从 seq=1 起传即完全跳过唯一的闸。
 * `exists=false` 表示这是本会话的第一片（不论 seq 是几），路由据此无条件查配额。
 */
export async function getRecordingDraftUsage(
  session: DraftSessionSource
): Promise<{ exists: boolean; chunkCount: number; totalBytes: number }> {
  const metadata = await readStoredManifestMetadata(session);
  if (!metadata) {
    return { exists: false, chunkCount: 0, totalBytes: 0 };
  }
  if (
    typeof metadata.chunkCount === 'number' &&
    typeof metadata.totalBytes === 'number'
  ) {
    return {
      exists: true,
      chunkCount: metadata.chunkCount,
      totalBytes: metadata.totalBytes,
    };
  }
  const stats = await scanChunkStatsOnDisk(session);
  return { exists: true, chunkCount: stats.count, totalBytes: stats.totalBytes };
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
  const hasGap = contiguous.length < seqs.length ||
    (manifest.expectedChunkCount !== undefined && contiguous.length !== manifest.expectedChunkCount);
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

  const files = await scanChunkFilesOnDisk(session);
  const paths = seqs.map((seq) => {
    const file = files.get(seq);
    if (!file) throw new Error(`Recording chunk ${seq} disappeared; preserving draft`);
    return file;
  });
  const sizes: number[] = [];
  let total = 0;
  for (const chunkPath of paths) {
    const stat = await fs.stat(chunkPath);
    sizes.push(stat.size);
    total += stat.size;
  }

  // P4-1：整份分配前先判总量。收尾链在 merge 之后还要经 normalizeRecordedAudioDuration 的
  // 数份整份拷贝，2GB 容器上几百 MB 的草稿就够把主进程 OOM 掉——宁可 413 让草稿留在盘上
  // 等人工/重试处理，也不能把整个进程带走（草稿不删，数据可恢复）。
  if (total > MAX_DRAFT_TOTAL_BYTES) {
    throw new RecordingDraftTooLargeError(total);
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
  return withSessionDraftLock(session.id, async () => {
    const artifacts = await findBillableStoredArtifactsByOwner('draft', session.id);
    const recordingArtifacts = artifacts.filter(
      (artifact) =>
        artifact.artifactType === STORED_ARTIFACT_TYPE.RECORDING_DRAFT
    );
    await markStoredArtifactsDeletePending(
      recordingArtifacts.map((artifact) => artifact.id)
    );
    await fs.rm(getDraftDir(session), { recursive: true, force: true });
    for (const artifact of recordingArtifacts) {
      await releaseStoredArtifact(artifact.id);
    }
  });
}

/** P4-1：草稿目录清扫的默认年龄阈值（48h）。远大于任何一次合法录音 + 补传窗口。 */
export const DEFAULT_DRAFT_SWEEP_MAX_AGE_MS = 48 * 60 * 60_000;

/**
 * P4-1：清扫过期的录音草稿目录。
 * 全仓此前**没有任何东西**碰 data/recording-drafts：billingMaintenance 的 reclaim 只覆盖
 * RECORDING/PAUSED/FINALIZING，`CREATED` 会话永不回收 —— 只要不进 RECORDING 就能一直往草稿目录
 * 里灌字节且永久驻留。这里按 manifest.updatedAt（读不到则退回目录 mtime）删掉超龄草稿。
 * 仅清理数据库中已不存在的会话；尚存会话的草稿无论多旧都保留恢复入口。
 */
export async function sweepStaleRecordingDrafts(options?: {
  maxAgeMs?: number;
  now?: number;
}): Promise<{ scanned: number; removed: number }> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_DRAFT_SWEEP_MAX_AGE_MS;
  const now = options?.now ?? Date.now();

  let entries: string[];
  try {
    entries = await fs.readdir(DRAFTS_ROOT);
  } catch {
    return { scanned: 0, removed: 0 };
  }

  let scanned = 0;
  let removed = 0;
  for (const entry of entries) {
    const dir = path.join(DRAFTS_ROOT, entry);
    let lastTouched: number | null = null;
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      lastTouched = stat.mtimeMs;
    } catch {
      continue;
    }
    scanned += 1;

    try {
      const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { updatedAt?: unknown };
      if (typeof parsed.updatedAt === 'number') {
        // manifest 与目录 mtime 取较新者：manifest 损坏/陈旧时不至于误删仍在写的草稿。
        lastTouched = Math.max(lastTouched, parsed.updatedAt);
      }
    } catch {
      // 无 manifest / 解析失败：退回目录 mtime。
    }

    if (now - lastTouched < maxAgeMs) {
      continue;
    }
    try {
      await withSessionDraftLock(entry, async () => {
        // 存在会话就保留恢复材料。年龄不证明已成功发布，缺头/缺尾的 FINALIZING
        // 可能等待原设备数天后补传；DB 不可用也必须保留，不能当成「无会话」。
        const owner = await prisma.session.findUnique({ where: { id: entry }, select: { id: true } });
        if (owner) return;
        const artifacts = await findBillableStoredArtifactsByOwner('draft', entry);
        const recordingArtifacts = artifacts.filter(
          (artifact) => artifact.artifactType === STORED_ARTIFACT_TYPE.RECORDING_DRAFT
        );
        await markStoredArtifactsDeletePending(recordingArtifacts.map((artifact) => artifact.id));
        await fs.rm(dir, { recursive: true, force: true });
        for (const artifact of recordingArtifacts) await releaseStoredArtifact(artifact.id);
        removed += 1;
      });
    } catch {
      // 单个目录删除失败不阻断整轮清扫。
    }
  }

  return { scanned, removed };
}
