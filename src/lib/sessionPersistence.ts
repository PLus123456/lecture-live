import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import crypto from 'crypto';
import type { Prisma, Session } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  CloudreveStorage,
  type SessionArtifactCategory,
} from '@/lib/storage/cloudreve';
import {
  loadCloudreveContext,
  deleteCloudreveFile,
  type CloudreveDeleteContext,
} from '@/lib/storage/cloudreveFileDelete';
import { logger, serializeError } from '@/lib/logger';
import {
  STORED_ARTIFACT_STATE,
  STORED_ARTIFACT_TYPE,
  type StoredArtifactType,
  findBillableStoredArtifactsByOwner,
  getStoredArtifactById,
  markStoredArtifactOrphan,
  recordReservedStoredArtifactLocation,
  releaseStoredArtifact,
  reserveStoredArtifact,
  rollbackStoredArtifact,
  settleStoredArtifactInTransaction,
  settleStoredArtifact,
  type SettledStoredArtifact,
  type StoredArtifactRow,
} from '@/lib/storage/storedArtifactLedger';
import {
  admitPersistedTranscriptBundle,
  SESSION_TRANSCRIPT_LIMITS,
} from '@/lib/sessionApi';

const DATA_ROOT = path.join(process.cwd(), 'data');
const LOCAL_DIRS: Record<SessionArtifactCategory, string> = {
  recordings: path.join(DATA_ROOT, 'recordings'),
  transcripts: path.join(DATA_ROOT, 'transcripts'),
  summaries: path.join(DATA_ROOT, 'summaries'),
  reports: path.join(DATA_ROOT, 'reports'),
  // 完整版补全转录：与实时 transcripts 完全分离的独立类别，落 data/full-transcripts/{id}.json。
  'full-transcripts': path.join(DATA_ROOT, 'full-transcripts'),
};

const STATIC_ARTIFACT_EXTENSIONS: Record<
  Exclude<SessionArtifactCategory, 'recordings'>,
  string
> = {
  transcripts: 'json',
  summaries: 'json',
  reports: 'json',
  'full-transcripts': 'json',
};

export interface PersistedTranscriptBundle {
  segments: unknown[];
  summaries: unknown[];
  translations: Record<string, string>;
}

export interface PersistedArtifactResult {
  path: string;
  storage: 'local' | 'cloudreve';
}

export interface LoadedBinaryArtifact {
  data: Buffer;
  fileName: string;
  contentType: string;
  path: string | null;
}

type SessionArtifactsSource = Pick<
  Session,
  'id' | 'userId' | 'recordingPath' | 'transcriptPath' | 'summaryPath'
> & {
  reportPath?: string | null;
  fullTranscriptPath?: string | null;
  enhancedAudioPath?: string | null;
};

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function legacyLocalArtifactPath(
  category: SessionArtifactCategory,
  sessionId: string
): string {
  return path.join(LOCAL_DIRS[category], artifactFileName(category, sessionId));
}

function buildLocalArtifactPath(
  category: SessionArtifactCategory,
  fileName: string
): string {
  return path.join(LOCAL_DIRS[category], path.basename(fileName));
}

function buildLocalArtifactReference(
  category: SessionArtifactCategory,
  fileName: string
): string {
  return `local:${category}/${path.basename(fileName)}`;
}

function sanitizeAudioMimeType(mimeType?: string | null): string {
  if (!mimeType) {
    return 'audio/webm';
  }

  const normalized = mimeType.toLowerCase();

  if (normalized.includes('mp4') || normalized.includes('aac')) {
    return 'audio/mp4';
  }

  // C15: 保留 mp3/wav/ogg 真实容器类型，避免把异步上传转码产物(audio/mpeg)与
  // wav/ogg 直传一律塌成 audio/webm 导致导出/下载文件名后缀与真实字节不符、被
  // 严格外部播放器拒收。in-app 回放靠 blob 内容嗅探不受影响，但存储/HTTP 头需正确。
  if (normalized.includes('mpeg') || normalized.includes('mp3')) {
    return 'audio/mpeg';
  }

  if (normalized.includes('wav') || normalized.includes('wave')) {
    return 'audio/wav';
  }

  if (normalized.includes('ogg')) {
    return 'audio/ogg';
  }

  if (normalized.includes('webm')) {
    return 'audio/webm';
  }

  return 'audio/webm';
}

const AUDIO_MIME_TO_EXTENSION: Record<string, string> = {
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

function recordingExtensionForMimeType(mimeType?: string | null): string {
  return AUDIO_MIME_TO_EXTENSION[sanitizeAudioMimeType(mimeType)] ?? 'webm';
}

export function inferRecordingMimeTypeFromReference(
  reference: string | null | undefined
): string {
  if (!reference) {
    return 'audio/webm';
  }

  const normalized = reference.toLowerCase();

  if (normalized.endsWith('.mp4') || normalized.endsWith('.m4a')) {
    return 'audio/mp4';
  }

  if (normalized.endsWith('.mp3') || normalized.endsWith('.mpeg')) {
    return 'audio/mpeg';
  }

  if (normalized.endsWith('.wav')) {
    return 'audio/wav';
  }

  if (normalized.endsWith('.ogg') || normalized.endsWith('.oga')) {
    return 'audio/ogg';
  }

  return 'audio/webm';
}

async function ensureLocalDir(category: SessionArtifactCategory) {
  await fs.mkdir(LOCAL_DIRS[category], { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getCloudreveStorageIfConfigured(): Promise<CloudreveStorage | null> {
  try {
    return await CloudreveStorage.create();
  } catch {
    return null;
  }
}

function parseLocalReference(
  category: SessionArtifactCategory,
  reference: string,
  sessionId: string
): string | null {
  if (!reference.startsWith('local:')) {
    return null;
  }

  const remainder = reference.slice('local:'.length);
  if (!remainder) {
    return legacyLocalArtifactPath(category, sessionId);
  }

  if (remainder.includes('/')) {
    const [prefix, ...rest] = remainder.split('/');
    if (prefix === category && rest.length > 0) {
      return buildLocalArtifactPath(category, rest.join('/'));
    }
  }

  return buildLocalArtifactPath(category, remainder);
}

export async function readArtifactFromReference(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  reference: string | null | undefined,
  options?: { maxBytes?: number }
): Promise<Buffer | null> {
  const maxBytes = options?.maxBytes;
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  let cloudreve: CloudreveStorage | null | undefined;
  const defaultCandidates =
    category === 'recordings'
      ? ([
          'audio/webm',
          'audio/mp4',
          'audio/mpeg',
          'audio/wav',
          'audio/ogg',
        ] as const).map((mimeType) =>
          buildLocalArtifactReference(
            category,
            artifactFileName(category, session.id, { mimeType })
          )
        )
      : [buildLocalArtifactReference(category, artifactFileName(category, session.id))];
  const candidates = reference ? [reference, ...defaultCandidates] : defaultCandidates;

  for (const candidate of candidates) {
    if (candidate.startsWith('local:')) {
      const localPath = parseLocalReference(category, candidate, session.id);
      if (!localPath) {
        continue;
      }
      if (!(await fileExists(localPath))) {
        continue;
      }

      if (maxBytes === undefined) {
        return fs.readFile(localPath);
      }

      try {
        const stat = await fs.stat(localPath);
        if (!stat.isFile() || stat.size > maxBytes) {
          return null;
        }
        return await readLocalFileBounded(localPath, maxBytes);
      } catch {
        continue;
      }
    }

    if (candidate.startsWith('/')) {
      if (cloudreve === undefined) {
        cloudreve = await getCloudreveStorageIfConfigured();
      }

      if (!cloudreve) {
        continue;
      }

      try {
        if (maxBytes !== undefined) {
          const response = await cloudreve.openDownloadStream(candidate, {
            expectedUserId: session.userId,
          });
          return await readResponseBodyBounded(response, maxBytes);
        }
        return await cloudreve.downloadByRemotePath(candidate, session.userId);
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function readLocalFileBounded(
  filePath: string,
  maxBytes: number
): Promise<Buffer | null> {
  const handle = await fs.open(filePath, 'r');
  const chunks: Buffer[] = [];
  const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  let totalBytes = 0;

  try {
    while (true) {
      const remaining = maxBytes + 1 - totalBytes;
      if (remaining <= 0) {
        return null;
      }
      const { bytesRead } = await handle.read(
        scratch,
        0,
        Math.min(scratch.byteLength, remaining),
        null
      );
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        return null;
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
}

async function readResponseBodyBounded(
  response: Response,
  maxBytes: number
): Promise<Buffer | null> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  let output = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return output.subarray(0, totalBytes);
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      if (value.byteLength > maxBytes - totalBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }

      const requiredBytes = totalBytes + value.byteLength;
      if (requiredBytes > output.byteLength) {
        let nextCapacity = Math.max(1, output.byteLength);
        while (nextCapacity < requiredBytes) {
          nextCapacity = Math.min(maxBytes, nextCapacity * 2);
        }
        const grown = Buffer.allocUnsafe(nextCapacity);
        output.copy(grown, 0, 0, totalBytes);
        output = grown;
      }
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(
        output,
        totalBytes
      );
      totalBytes = requiredBytes;
    }
  } finally {
    reader.releaseLock();
  }
}

function artifactFileName(
  category: SessionArtifactCategory,
  sessionId: string,
  options?: { mimeType?: string | null }
): string {
  if (category === 'recordings') {
    return `${normalizeSessionId(sessionId)}.${recordingExtensionForMimeType(
      options?.mimeType
    )}`;
  }

  return `${normalizeSessionId(sessionId)}.${STATIC_ARTIFACT_EXTENSIONS[category]}`;
}

async function inferLocalRecordingMimeType(sessionId: string): Promise<string> {
  const orderedMimeTypes = [
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
  ] as const;
  for (const mimeType of orderedMimeTypes) {
    const exists = await fileExists(
      buildLocalArtifactPath(
        'recordings',
        artifactFileName('recordings', sessionId, { mimeType })
      )
    );
    if (exists) {
      return mimeType;
    }
  }
  return 'audio/webm';
}

const persistenceLogger = logger.child({ component: 'session-persistence' });

const CATEGORY_ARTIFACT_TYPE: Record<
  SessionArtifactCategory,
  StoredArtifactType
> = {
  recordings: STORED_ARTIFACT_TYPE.RECORDING,
  transcripts: STORED_ARTIFACT_TYPE.TRANSCRIPT,
  summaries: STORED_ARTIFACT_TYPE.SUMMARY,
  reports: STORED_ARTIFACT_TYPE.REPORT,
  'full-transcripts': STORED_ARTIFACT_TYPE.FULL_TRANSCRIPT,
};

function categoryForArtifactType(
  artifactType: string
): SessionArtifactCategory | null {
  switch (artifactType) {
    case STORED_ARTIFACT_TYPE.RECORDING:
    case STORED_ARTIFACT_TYPE.ENHANCED_AUDIO:
      return 'recordings';
    case STORED_ARTIFACT_TYPE.TRANSCRIPT:
      return 'transcripts';
    case STORED_ARTIFACT_TYPE.SUMMARY:
      return 'summaries';
    case STORED_ARTIFACT_TYPE.REPORT:
      return 'reports';
    case STORED_ARTIFACT_TYPE.FULL_TRANSCRIPT:
      return 'full-transcripts';
    default:
      return null;
  }
}

function artifactDataBytes(data: Buffer | string): number {
  return Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(data, 'utf8');
}

/**
 * best-effort 物理删除一条 artifact 引用（本地文件或 Cloudreve 远程文件）。
 * reference 形如 `local:{category}/{fileName}`（本地）或 `/{userId}/{category}/{fileName}`
 * （Cloudreve 远程路径，以 `/` 开头）。任何失败仅 warn、绝不抛。
 */
async function deleteArtifactByReference(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  reference: string | null | undefined,
  cloudreveCtx?: CloudreveDeleteContext | null
): Promise<boolean> {
  if (!reference) {
    return true;
  }

  if (reference.startsWith('local:')) {
    const localPath = parseLocalReference(category, reference, session.id);
    if (localPath) {
      try {
        await fs.rm(localPath, { force: true });
        return true;
      } catch (err) {
        persistenceLogger.warn(
          { localPath, err: serializeError(err) },
          '删除本地 artifact 失败；残留由清理工具兜底'
        );
        return false;
      }
    }
    return false;
  }

  if (reference.startsWith('/')) {
    const ctx =
      cloudreveCtx === undefined ? await loadCloudreveContext() : cloudreveCtx;
    if (!ctx) {
      return false;
    }
    return deleteCloudreveFile(reference, ctx);
  }
  return false;
}

export async function persistArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  data: Buffer | string,
  options?: {
    mimeType?: string | null;
    previousReference?: string | null;
    artifactType?: StoredArtifactType;
    reservationKey?: string;
  }
): Promise<PersistedArtifactResult> {
  const fileName = artifactFileName(category, session.id, options);
  const bytes = artifactDataBytes(data);
  const artifactType = options?.artifactType ?? CATEGORY_ARTIFACT_TYPE[category];
  const reservation = await reserveStoredArtifact({
    userId: session.userId,
    ownerType: 'session',
    ownerId: session.id,
    sessionId: session.id,
    artifactType,
    expectedBytes: bytes,
    reservationKey: options?.reservationKey,
  });
  const localPath = buildLocalArtifactPath(category, fileName);
  const localReference = buildLocalArtifactReference(category, fileName);
  let result: PersistedArtifactResult | null = null;
  try {
    await ensureLocalDir(category);
    await fs.writeFile(localPath, data);

    const storage = await getCloudreveStorageIfConfigured();
    if (storage) {
      const remotePath = await storage.upload(session.userId, category, fileName, data);
      // 先记录已创建的远端对象，再清掉本地 staging。即使本地 rm 异常，catch 也能
      // 精确删除远端对象并只在物理删除成功后释放 reservation，避免未记账孤儿。
      result = { path: remotePath, storage: 'cloudreve' };
      // Cloudreve 发布成功后本地文件只是 staging 副本，立即删除；
      // 否则同一逻辑 artifact 有两份物理占用却只有一行账本。
      await fs.rm(localPath, { force: true });
    } else {
      result = { path: localReference, storage: 'local' };
    }

    const settled = await settleStoredArtifact(reservation.id, {
      actualBytes: bytes,
      storage: result.storage,
      reference: result.path,
    });

    const previousReference =
      settled.previous?.reference ?? options?.previousReference ?? null;
    if (
      previousReference &&
      previousReference !== result.path &&
      previousReference !== localReference
    ) {
      const deleted = await deleteArtifactByReference(
        session,
        category,
        previousReference
      );
      if (deleted && settled.previous) {
        await releaseStoredArtifact(settled.previous.id, 'REPLACED');
      }
    } else if (settled.previous) {
      // 固定 key 被原子覆盖，旧物理对象已不再单独存在。
      await releaseStoredArtifact(settled.previous.id, 'REPLACED');
    }
    return result;
  } catch (error) {
    let deleted = true;
    if (result) {
      deleted = await deleteArtifactByReference(
        session,
        category,
        result.path
      ).catch(() => false);
    } else {
      try {
        await fs.rm(localPath, { force: true });
      } catch {
        deleted = false;
      }
    }
    if (deleted) {
      await rollbackStoredArtifact(reservation.id).catch(() => undefined);
    } else {
      await markStoredArtifactOrphan(reservation.id).catch(() => undefined);
    }
    throw error;
  }
}

export async function persistSessionAudioArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId' | 'recordingPath'>,
  data: Buffer,
  mimeType?: string | null
): Promise<PersistedArtifactResult> {
  return persistArtifact(session, 'recordings', data, {
    mimeType,
    previousReference: session.recordingPath,
  });
}

// ── P0-6：artifact 临时对象 + CAS 发布 ─────────────────────────────────────────
// 旧的 persistArtifact 先物理覆盖固定 key `{sessionId}.{ext}` 并删旧文件，再由调用方做
// 数据库状态 guard。并发 finalize 已完成时，路由虽返回 409，但终态物理文件已被覆盖/删除
// （审计 P0-6 问题 A）。下面把写入拆成两阶段：
//   ① stageArtifact —— 写「版本化对象」（唯一文件名，绝不覆盖旧文件），拿到其引用；
//   ② 调用方在事务里 CAS（updateMany 判 count）把 path 指向该引用；
//   ③ CAS 成功 → finalizeStagedArtifactPublish（删旧 previousReference）；
//      CAS 失败 → rollbackStagedArtifact（删掉刚写的版本化对象，绝不动旧 artifact）。

export interface StagedArtifact {
  category: SessionArtifactCategory;
  // 已发布对象的引用；数据库 CAS 应写入此值。
  reference: string;
  // 本地版本化文件引用（Cloudreve 模式下本地也留一份，回滚/比较需单独处理）。
  localReference: string;
  storage: 'local' | 'cloudreve';
  previousReference?: string | null;
  storedArtifactId: string;
  expectedPreviousArtifactId: string | null;
  actualBytes: number;
  artifactType: StoredArtifactType;
}

export interface SettledStagedArtifactPublish {
  staged: StagedArtifact;
  settled: SettledStoredArtifact;
}

export type StagedArtifactPublicationReadback =
  | {
      outcome: 'committed';
      publications: SettledStagedArtifactPublish[];
    }
  | { outcome: 'not_committed'; publications: [] }
  | { outcome: 'unknown'; publications: [] };

/**
 * Classify a transaction error without destroying a generation whose COMMIT
 * may have succeeded but whose acknowledgement was lost. Callers must pass the
 * owner columns read after the error in the same order as `stagedArtifacts`.
 */
export async function readbackStagedArtifactPublication(
  stagedArtifacts: ReadonlyArray<StagedArtifact>,
  ownerReferences: ReadonlyArray<string | null | undefined>
): Promise<StagedArtifactPublicationReadback> {
  if (stagedArtifacts.length !== ownerReferences.length) {
    return { outcome: 'unknown', publications: [] };
  }
  const artifacts = await Promise.all(
    stagedArtifacts.map((staged) =>
      getStoredArtifactById(staged.storedArtifactId)
    )
  );
  const committed = stagedArtifacts.every((staged, index) => {
    const artifact = artifacts[index];
    return (
      ownerReferences[index] === staged.reference &&
      artifact?.state === STORED_ARTIFACT_STATE.ACTIVE &&
      artifact.reference === staged.reference &&
      artifact.storage === staged.storage &&
      artifact.bytes === BigInt(staged.actualBytes)
    );
  });
  if (committed) {
    return {
      outcome: 'committed',
      publications: stagedArtifacts.map((staged, index) => ({
        staged,
        settled: { artifact: artifacts[index]!, previous: null },
      })),
    };
  }

  const definitelyNotCommitted = stagedArtifacts.every((staged, index) => {
    const artifact = artifacts[index];
    return (
      ownerReferences[index] !== staged.reference &&
      artifact?.state === STORED_ARTIFACT_STATE.RESERVED &&
      artifact.reference === staged.reference
    );
  });
  return definitelyNotCommitted
    ? { outcome: 'not_committed', publications: [] }
    : { outcome: 'unknown', publications: [] };
}

function buildVersionedArtifactFileName(
  category: SessionArtifactCategory,
  sessionId: string,
  options?: { mimeType?: string | null }
): string {
  // 版本化后缀：时间戳 + 随机，保证与最终 key 及旧文件都不同名；扩展名保持在末位，
  // 使 inferRecordingMimeTypeFromReference 的按后缀嗅探仍成立。
  const stamp = `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const base = normalizeSessionId(sessionId);
  if (category === 'recordings') {
    return `${base}-${stamp}.${recordingExtensionForMimeType(options?.mimeType)}`;
  }
  return `${base}-${stamp}.${STATIC_ARTIFACT_EXTENSIONS[category]}`;
}

export async function stageArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  data: Buffer | string,
  options?: {
    mimeType?: string | null;
    previousReference?: string | null;
    artifactType?: StoredArtifactType;
    reservationKey?: string;
  }
): Promise<StagedArtifact> {
  const fileName = buildVersionedArtifactFileName(category, session.id, options);
  const bytes = artifactDataBytes(data);
  const artifactType = options?.artifactType ?? CATEGORY_ARTIFACT_TYPE[category];
  const reservation = await reserveStoredArtifact({
    userId: session.userId,
    ownerType: 'session',
    ownerId: session.id,
    sessionId: session.id,
    artifactType,
    expectedBytes: bytes,
    reservationKey: options?.reservationKey,
  });
  const localPath = buildLocalArtifactPath(category, fileName);
  const localReference = buildLocalArtifactReference(category, fileName);
  let physicalReference: string | null = null;
  let physicalStorage: 'local' | 'cloudreve' = 'local';
  try {
    await ensureLocalDir(category);
    physicalReference = localReference;
    await recordReservedStoredArtifactLocation(reservation.id, {
      actualBytes: bytes,
      storage: 'local',
      reference: localReference,
    });
    await fs.writeFile(localPath, data);

    const storage = await getCloudreveStorageIfConfigured();
    if (storage) {
      const remotePath = await storage.upload(session.userId, category, fileName, data);
      physicalReference = remotePath;
      physicalStorage = 'cloudreve';
      await recordReservedStoredArtifactLocation(reservation.id, {
        actualBytes: bytes,
        storage: physicalStorage,
        reference: physicalReference,
      });
      await fs.rm(localPath, { force: true });
    }
    return {
      category,
      reference: physicalReference,
      localReference,
      storage: physicalStorage,
      previousReference: options?.previousReference ?? null,
      storedArtifactId: reservation.id,
      expectedPreviousArtifactId: reservation.replacesArtifactId,
      actualBytes: bytes,
      artifactType,
    };
  } catch (error) {
    let deleted = true;
    if (physicalReference) {
      deleted = await deleteArtifactByReference(
        session,
        category,
        physicalReference
      ).catch(() => false);
    }
    if (physicalReference !== localReference) {
      await fs.rm(localPath, { force: true }).catch(() => undefined);
    }
    if (deleted) {
      await rollbackStoredArtifact(reservation.id).catch(() => undefined);
    } else {
      await markStoredArtifactOrphan(reservation.id).catch(() => undefined);
    }
    throw error;
  }
}

export async function stageSessionAudioArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId' | 'recordingPath'>,
  data: Buffer,
  mimeType?: string | null
): Promise<StagedArtifact> {
  return stageArtifact(session, 'recordings', data, {
    mimeType,
    previousReference: session.recordingPath,
  });
}

/**
 * Settle staged rows inside the caller's owner-row transaction. Owner paths and
 * ledger identity therefore commit together; physical replacement cleanup is
 * deliberately deferred until after commit.
 */
export async function settleStagedArtifactsInTransaction(
  tx: Prisma.TransactionClient,
  stagedArtifacts: ReadonlyArray<StagedArtifact>
): Promise<SettledStagedArtifactPublish[]> {
  const publications: SettledStagedArtifactPublish[] = [];
  for (const staged of stagedArtifacts) {
    const settled = await settleStoredArtifactInTransaction(
      tx,
      staged.storedArtifactId,
      {
        actualBytes: staged.actualBytes,
        storage: staged.storage,
        reference: staged.reference,
        expectedPreviousArtifactId: staged.expectedPreviousArtifactId,
      }
    );
    publications.push({ staged, settled });
  }
  return publications;
}

/** Best-effort post-commit cleanup; failed deletes remain charged ORPHANED. */
export async function completeStagedArtifactPublishes(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  publications: ReadonlyArray<SettledStagedArtifactPublish>
): Promise<PersistedArtifactResult[]> {
  const results: PersistedArtifactResult[] = [];
  for (const { staged, settled } of publications) {
    const previous = settled.previous?.reference ?? staged.previousReference;
    if (
      previous &&
      previous !== staged.reference &&
      previous !== staged.localReference
    ) {
      const deleted = await deleteArtifactByReference(
        session,
        staged.category,
        previous
      );
      if (deleted && settled.previous) {
        await releaseStoredArtifact(settled.previous.id, 'REPLACED').catch(
          () => undefined
        );
      }
    } else if (settled.previous) {
      await releaseStoredArtifact(settled.previous.id, 'REPLACED').catch(
        () => undefined
      );
    }
    results.push({ path: staged.reference, storage: staged.storage });
  }
  return results;
}

/** Atomically publish one or more staged artifacts, then clean replaced objects. */
export async function finalizeStagedArtifactPublishes(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  stagedArtifacts: ReadonlyArray<StagedArtifact>
): Promise<PersistedArtifactResult[]> {
  const publications = await prisma.$transaction((tx) =>
    settleStagedArtifactsInTransaction(tx, stagedArtifacts)
  );
  return completeStagedArtifactPublishes(session, publications);
}

/** Compatibility wrapper for callers that publish one staged object. */
export async function finalizeStagedArtifactPublish(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  staged: StagedArtifact
): Promise<PersistedArtifactResult> {
  const [result] = await finalizeStagedArtifactPublishes(session, [staged]);
  if (!result) throw new Error('staged artifact publication returned no result');
  return result;
}

/** P0-6：CAS 失败回滚 —— 删掉刚写的版本化对象（本地 + 可能的 Cloudreve），绝不动旧 artifact。 */
export async function rollbackStagedArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  staged: StagedArtifact
): Promise<void> {
  let deleted = true;
  if (staged.storage === 'cloudreve' && staged.reference !== staged.localReference) {
    deleted = await deleteArtifactByReference(
      session,
      staged.category,
      staged.reference
    ).catch(() => false);
  }
  const localDeleted = await deleteArtifactByReference(
    session,
    staged.category,
    staged.localReference
  ).catch(() => false);
  deleted = deleted && localDeleted;
  if (deleted) {
    await rollbackStoredArtifact(staged.storedArtifactId);
  } else {
    await markStoredArtifactOrphan(staged.storedArtifactId);
  }
}

/**
 * U4：best-effort 物理删除一个会话的全部产物（本地 data/ + Cloudreve 远程），
 * 覆盖录音/转录/摘要/报告/完整版转录。删 session 行前调用（行一删便再无 path→owner 关联）。
 * 单次加载 Cloudreve 上下文复用。任何失败仅 warn，绝不阻塞 DB 删除。
 */
export async function deleteSessionArtifacts(
  session: SessionArtifactsSource,
  prefetchedLedgerRows?: ReadonlyArray<StoredArtifactRow>
): Promise<void> {
  const ctx = await loadCloudreveContext();
  const targets: Array<[SessionArtifactCategory, string | null | undefined]> = [
    ['recordings', session.recordingPath],
    // 音频增强产物与原录音同在 recordings 类别下（版本化文件名），需单独一条清理
    ['recordings', session.enhancedAudioPath],
    ['transcripts', session.transcriptPath],
    ['summaries', session.summaryPath],
    ['reports', session.reportPath],
    // C3：完整版补全转录产物（本地 data/full-transcripts/ 或 Cloudreve 远程），
    // 与其它产物一并清理，删会话不留孤儿。fullTranscriptPath 为空则被 deleteArtifactByReference 跳过。
    ['full-transcripts', session.fullTranscriptPath],
  ];
  const deletedByReference = new Map<string, boolean>();
  for (const [category, reference] of targets) {
    const deleted = await deleteArtifactByReference(session, category, reference, ctx);
    if (reference) deletedByReference.set(reference, deleted);
  }

  // 账本还可能含有替换失败留下的 ORPHANED 版本，它们不再出现在
  // Session path 列中，但删会话时同样必须清理并释放。
  const ledgerRows =
    prefetchedLedgerRows ??
    (await findBillableStoredArtifactsByOwner('session', session.id));
  for (const row of ledgerRows) {
    if (!row.reference) {
      continue;
    }
    let deleted = deletedByReference.get(row.reference);
    if (deleted === undefined) {
      const category = categoryForArtifactType(row.artifactType);
      deleted = category
        ? await deleteArtifactByReference(session, category, row.reference, ctx)
        : false;
      deletedByReference.set(row.reference, deleted);
    }
    if (deleted) {
      await releaseStoredArtifact(row.id).catch(() => undefined);
    }
  }
}

export async function persistSessionTranscriptArtifacts(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  bundle: PersistedTranscriptBundle
): Promise<{
  transcript: PersistedArtifactResult;
  summary: PersistedArtifactResult;
}> {
  // Shared last-mile boundary: async Soniox finalize and any future internal
  // caller must obey the same persisted object-graph/byte limits as HTTP.
  const staged = await stageSessionTranscriptArtifacts(session, bundle);
  try {
    const [transcript, summary] = await finalizeStagedArtifactPublishes(session, [
      staged.transcript,
      staged.summary,
    ]);
    if (!transcript || !summary) {
      throw new Error('transcript artifact publication was incomplete');
    }
    return { transcript, summary };
  } catch (error) {
    // Atomic settle either publishes both or leaves both RESERVED. Remove both
    // staged objects on failure so a quota error can never leak the first half.
    await Promise.all([
      rollbackStagedArtifact(session, staged.transcript).catch(() => undefined),
      rollbackStagedArtifact(session, staged.summary).catch(() => undefined),
    ]);
    throw error;
  }
}

/**
 * P0-6：转录 + 摘要的两阶段写入。先写版本化临时对象；调用方 DB CAS 成功后
 * finalizeStagedArtifactPublish、失败 rollbackStagedArtifact。转录/摘要不追踪 previousReference
 * （旧行为即覆盖固定 key），故发布仅返回引用、无旧文件可删。
 */
export async function stageSessionTranscriptArtifacts(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  bundle: PersistedTranscriptBundle
): Promise<{ transcript: StagedArtifact; summary: StagedArtifact }> {
  const admitted = admitPersistedTranscriptBundle(bundle);
  const transcriptJson = JSON.stringify(admitted, null, 2);
  const summaryJson = JSON.stringify(admitted.summaries, null, 2);

  const transcript = await stageArtifact(session, 'transcripts', transcriptJson);
  try {
    const summary = await stageArtifact(session, 'summaries', summaryJson);
    return { transcript, summary };
  } catch (error) {
    // The first physical object/reservation must not survive failure to reserve
    // or write the second half of the pair.
    await rollbackStagedArtifact(session, transcript).catch(() => undefined);
    throw error;
  }
}

export async function loadSessionTranscriptBundle(
  session: SessionArtifactsSource
): Promise<PersistedTranscriptBundle | null> {
  const transcriptBuffer = await readArtifactFromReference(
    session,
    'transcripts',
    session.transcriptPath,
    { maxBytes: SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes }
  );

  if (!transcriptBuffer) {
    return null;
  }
  if (
    transcriptBuffer.byteLength >
    SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes
  ) {
    return null;
  }

  const parsed = safeParseJson(transcriptBuffer.toString('utf-8'));
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Partial<PersistedTranscriptBundle>;
  const fallbackSummaries = Array.isArray(record.summaries)
    ? null
    : await loadSessionSummaryData(session);
  const candidate = {
    segments: Array.isArray(record.segments) ? record.segments : [],
    summaries: Array.isArray(record.summaries)
      ? record.summaries
      : fallbackSummaries ?? [],
    translations: isPlainObject(record.translations)
      ? record.translations
      : {},
  };
  try {
    return admitPersistedTranscriptBundle(candidate);
  } catch {
    return null;
  }
}

export async function loadSessionSummaryData(
  session: SessionArtifactsSource
): Promise<unknown[] | null> {
  const summaryBuffer = await readArtifactFromReference(
    session,
    'summaries',
    session.summaryPath,
    { maxBytes: SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes }
  );

  if (!summaryBuffer) {
    return null;
  }
  if (
    summaryBuffer.byteLength > SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes
  ) {
    return null;
  }

  const parsed = safeParseJson(summaryBuffer.toString('utf-8'));
  return Array.isArray(parsed) ? parsed : null;
}

export async function loadSessionAudioArtifact(
  session: SessionArtifactsSource
): Promise<LoadedBinaryArtifact | null> {
  const audioBuffer = await readArtifactFromReference(
    session,
    'recordings',
    session.recordingPath
  );

  if (!audioBuffer) {
    return null;
  }

  const inferredMimeType = session.recordingPath
    ? inferRecordingMimeTypeFromReference(session.recordingPath)
    : await inferLocalRecordingMimeType(session.id);

  return {
    data: audioBuffer,
    fileName: artifactFileName('recordings', session.id, {
      mimeType: inferredMimeType,
    }),
    contentType: inferredMimeType,
    path:
      session.recordingPath ??
      buildLocalArtifactReference(
        'recordings',
        artifactFileName('recordings', session.id, {
          mimeType: inferredMimeType,
        })
      ),
  };
}

// ── P2-2：录音 Range 流式读取（本地按 range 读、Cloudreve 用上游 range/stream）───────────────
// 旧的播放/分享路由先 loadSessionAudioArtifact 把整段录音读进内存再 subarray 出 Range，长录音 +
// 并发 Range 请求会放大进程内存直至 OOM。下面把「定位录音物理位置」与「按 range 流式取字节」拆开：
//   resolveSessionAudioLocation —— 解析到本地文件（路径+大小+MIME）或 Cloudreve 远程路径；
//   openLocalAudioRangeStream   —— 本地文件按 [start,end] 用 createReadStream 流式读，不整包入内存；
//   Cloudreve 分支由路由调用 storage.openDownloadStream({range}) 透传上游 206/流，同样不入内存。

export type SessionAudioLocation =
  | { kind: 'local'; filePath: string; size: number; contentType: string }
  | { kind: 'cloudreve'; remotePath: string; userId: string; contentType: string };

/**
 * P2-2：解析会话录音的物理位置，供 Range 路由流式读取。候选顺序与 readArtifactFromReference 一致：
 * 先显式 recordingPath，再按容器类型的默认本地候选。命中本地文件返回其路径/大小/按扩展名推断的
 * MIME；命中 Cloudreve 远程路径（以 '/' 开头）返回远程路径，由调用方 openDownloadStream 透传 range。
 */
export async function resolveSessionAudioLocation(
  session: Pick<SessionArtifactsSource, 'id' | 'userId' | 'recordingPath'>
): Promise<SessionAudioLocation | null> {
  const reference = session.recordingPath;
  const defaultCandidates = (
    ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg'] as const
  ).map((mimeType) =>
    buildLocalArtifactReference(
      'recordings',
      artifactFileName('recordings', session.id, { mimeType })
    )
  );
  const candidates = reference ? [reference, ...defaultCandidates] : defaultCandidates;

  for (const candidate of candidates) {
    if (candidate.startsWith('local:')) {
      const localPath = parseLocalReference('recordings', candidate, session.id);
      if (localPath && (await fileExists(localPath))) {
        const stat = await fs.stat(localPath);
        return {
          kind: 'local',
          filePath: localPath,
          size: stat.size,
          contentType: inferRecordingMimeTypeFromReference(candidate),
        };
      }
      continue;
    }

    if (candidate.startsWith('/')) {
      return {
        kind: 'cloudreve',
        remotePath: candidate,
        userId: session.userId,
        contentType: inferRecordingMimeTypeFromReference(candidate),
      };
    }
  }

  return null;
}

/**
 * P2-2：以 Web ReadableStream 打开本地录音文件的一段字节（start/end 均为**包含**，与 HTTP Range
 * 语义一致；createReadStream 的 end 亦为包含）。省略 range 即整文件流式读取。不把文件读进内存。
 */
export function openLocalAudioRangeStream(
  filePath: string,
  range?: { start: number; end: number }
): ReadableStream<Uint8Array> {
  const nodeStream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

export function extractTranscriptText(bundle: PersistedTranscriptBundle): string {
  return bundle.segments
    .map((segment) => {
      if (!segment || typeof segment !== 'object') {
        return '';
      }

      const text = (segment as { text?: unknown }).text;
      return typeof text === 'string' ? text.trim() : '';
    })
    .filter(Boolean)
    .join('\n');
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}


/** 保存会话报告 */
export async function persistSessionReport(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  report: unknown
): Promise<PersistedArtifactResult> {
  const json = JSON.stringify(report, null, 2);
  return persistArtifact(session, 'reports', json);
}

/** 加载会话报告 */
export async function loadSessionReport(
  session: SessionArtifactsSource
): Promise<unknown | null> {
  const buffer = await readArtifactFromReference(
    session,
    'reports',
    session.reportPath
  );
  if (!buffer) return null;
  return safeParseJson(buffer.toString('utf-8'));
}
