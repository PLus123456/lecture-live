import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { Session } from '@prisma/client';
import { SESSION_TRANSCRIPT_LIMITS } from '@/lib/sessionApi';
import {
  STORED_ARTIFACT_TYPE,
  STORED_ARTIFACT_STATE,
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
  settleStoredArtifactsAtomically,
  type StoredArtifactReservation,
  type StoredArtifactRow,
} from '@/lib/storage/storedArtifactLedger';

// 转录稿草稿持久化 — 录制期间实时保存 segments/summaries/translations 到临时目录，
// 结束录制后转存到永久存储并删除草稿。

const DRAFTS_ROOT = path.join(process.cwd(), 'data', 'transcript-drafts');

// P4-5：冲突备份保留份数上限。
// 单调守卫把「段数变少」判为冲突，处理方式是把**整份载荷**写进一个带时间戳的新备份文件并回 200。
// PUT 无限流、单个 segment 体积零校验、落盘还 pretty-print —— 先 PUT 10000 个 1 字节 segment
// 顶满 segmentCount，之后每次 PUT 9999 个巨型 segment 必命中冲突分支，备份文件无限堆积；
// 而 CREATED 会话永不回收，这些文件永久驻留。保留最近 N 份足够事后排查，其余滚动删除。
const MAX_CONFLICT_BACKUPS = 3;

const CONFLICT_BACKUP_RE =
  /^transcript\.conflict-(\d+)(?:-[a-f0-9-]+)?\.json$/;

const TRANSCRIPT_DATA_SLOT = 'transcript';
const TRANSCRIPT_MANIFEST_SLOT = 'manifest';

export interface TranscriptDraftPayload {
  segments: unknown[];
  summaries: unknown[];
  translations: Record<string, string>;
  /** 客户端时间戳，用于冲突检测 */
  clientTs: number;
  /** 录音状态恢复所需的时间信息（浏览器关闭后冷恢复） */
  recordingStartTime?: number;
  pausedAt?: number;
  totalPausedMs?: number;
  totalDurationMs?: number;
  summaryRunningContext?: string;
  currentSessionIndex?: number;
}

export interface TranscriptDraftManifest {
  sessionId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  segmentCount: number;
}

type DraftSessionSource = Pick<Session, 'id' | 'userId'>;

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function getDraftDir(session: DraftSessionSource) {
  return path.join(DRAFTS_ROOT, normalizeSessionId(session.id));
}

function getDraftDataPath(session: DraftSessionSource) {
  return path.join(getDraftDir(session), 'transcript.json');
}

function getDraftManifestPath(session: DraftSessionSource) {
  return path.join(getDraftDir(session), 'manifest.json');
}

function getDraftLogicalKey(session: DraftSessionSource, slot: string) {
  return buildStoredArtifactLogicalKey(
    'draft',
    `${session.id}:${slot}`,
    STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT
  );
}

async function ensureDraftDir(session: DraftSessionSource) {
  await fs.mkdir(getDraftDir(session), { recursive: true });
}

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标（同分区 rename 是原子操作）。
 * 直接 writeFile 覆写在进程被杀/磁盘满时会留下半截损坏的 JSON，后续 loadTranscriptDraft
 * 解析失败→返回空→auto-reclaim 以空转录落库并删除残稿，草稿永久损毁（审计 medium）。
 * rename 保证读到的永远是完整的旧版或完整的新版，绝不会是半截。
 */
async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    await fs.writeFile(tmpPath, data, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

function getDraftLocalReference(session: DraftSessionSource, fileName: string) {
  return `local:transcript-drafts/${normalizeSessionId(session.id)}/${fileName}`;
}

function pathForDraftReference(
  session: DraftSessionSource,
  reference: string | null
): string | null {
  const prefix = `local:transcript-drafts/${normalizeSessionId(session.id)}/`;
  if (!reference?.startsWith(prefix)) return null;
  const fileName = reference.slice(prefix.length);
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName) || fileName.includes('..')) {
    return null;
  }
  return path.join(getDraftDir(session), fileName);
}

async function resolveDraftSlotPath(
  session: DraftSessionSource,
  slot: string,
  legacyPath: string
): Promise<string | null> {
  const active = await getActiveStoredArtifactByLogicalKey(
    getDraftLogicalKey(session, slot)
  );
  if (!active) return legacyPath;
  if (
    active.userId !== session.userId ||
    active.ownerType !== 'draft' ||
    active.ownerId !== session.id ||
    active.artifactType !== STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT ||
    active.storage !== 'local'
  ) {
    return null;
  }
  return pathForDraftReference(session, active.reference);
}

interface PreparedTranscriptDraftArtifact {
  reservation: StoredArtifactReservation;
  bytes: number;
  filePath: string;
  reference: string;
}

async function prepareTranscriptDraftArtifact(
  session: DraftSessionSource,
  logicalSlot: string,
  fileName: string,
  data: string
): Promise<PreparedTranscriptDraftArtifact> {
  const bytes = Buffer.byteLength(data, 'utf8');
  const reservation = await reserveStoredArtifact({
    userId: session.userId,
    ownerType: 'draft',
    ownerId: session.id,
    sessionId: session.id,
    artifactType: STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT,
    expectedBytes: bytes,
    logicalKey: getDraftLogicalKey(session, logicalSlot),
  });
  const filePath = path.join(getDraftDir(session), fileName);
  const reference = getDraftLocalReference(session, fileName);
  try {
    await recordReservedStoredArtifactLocation(reservation.id, {
      actualBytes: bytes,
      storage: 'local',
      reference,
    });
    await writeFileAtomic(filePath, data);
    return { reservation, bytes, filePath, reference };
  } catch (error) {
    const deleted = await fs
      .rm(filePath, { force: true })
      .then(() => true)
      .catch(() => false);
    if (deleted) {
      await rollbackStoredArtifact(reservation.id).catch(() => undefined);
    } else {
      // Keep the charged reservation and its physical reference for TTL cleanup.
      await recordReservedStoredArtifactLocation(reservation.id, {
        actualBytes: bytes,
        storage: 'local',
        reference,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function discardPreparedTranscriptArtifact(
  prepared: PreparedTranscriptDraftArtifact
): Promise<void> {
  const deleted = await fs
    .rm(prepared.filePath, { force: true })
    .then(() => true)
    .catch(() => false);
  if (deleted) {
    await rollbackStoredArtifact(prepared.reservation.id).catch(() => undefined);
  }
}

async function cleanupReplacedTranscriptArtifact(
  session: DraftSessionSource,
  previous: StoredArtifactRow | null
): Promise<void> {
  if (!previous) return;
  const previousPath = pathForDraftReference(session, previous.reference);
  if (!previousPath) return;
  const deleted = await fs
    .rm(previousPath, { force: true })
    .then(() => true)
    .catch(() => false);
  if (deleted) {
    await releaseStoredArtifact(previous.id, 'REPLACED').catch(() => undefined);
  }
}

async function publishPreparedTranscriptArtifacts(
  session: DraftSessionSource,
  prepared: ReadonlyArray<PreparedTranscriptDraftArtifact>
): Promise<void> {
  let previousRows: Array<StoredArtifactRow | null> = [];
  try {
    const settled = await settleStoredArtifactsAtomically(
      prepared.map((item) => ({
        artifactId: item.reservation.id,
        publication: {
          actualBytes: item.bytes,
          storage: 'local' as const,
          reference: item.reference,
          expectedPreviousArtifactId: item.reservation.replacesArtifactId,
        },
      }))
    );
    previousRows = settled.map((item) => item.previous);
  } catch (publishError) {
    let rows: Array<StoredArtifactRow | null>;
    try {
      rows = await Promise.all(
        prepared.map((item) => getStoredArtifactById(item.reservation.id))
      );
    } catch {
      throw new StoredArtifactPublishOutcomeUnknownError();
    }

    const committed = rows.every(
      (row, index) =>
        row?.state === STORED_ARTIFACT_STATE.ACTIVE &&
        row.reference === prepared[index].reference &&
        row.identityKey === prepared[index].reservation.logicalKey
    );
    if (!committed) {
      const definitelyNotCommitted = rows.every(
        (row, index) =>
          row?.state === STORED_ARTIFACT_STATE.RESERVED &&
          row.reference === prepared[index].reference
      );
      if (definitelyNotCommitted) {
        await Promise.all(prepared.map(discardPreparedTranscriptArtifact));
        throw publishError;
      }
      // Mixed rows mean the transaction outcome cannot be proven. Preserve every
      // version and reservation for repair instead of deleting a possibly-live file.
      throw new StoredArtifactPublishOutcomeUnknownError();
    }

    previousRows = await Promise.all(
      prepared.map((item) =>
        item.reservation.replacesArtifactId
          ? getStoredArtifactById(item.reservation.replacesArtifactId)
          : Promise.resolve(null)
      )
    );
  }

  await Promise.all(
    previousRows.map((previous) =>
      cleanupReplacedTranscriptArtifact(session, previous)
    )
  );
}

async function writeTranscriptDraftArtifact(
  session: DraftSessionSource,
  logicalSlot: string,
  fileName: string,
  data: string
): Promise<void> {
  const prepared = await prepareTranscriptDraftArtifact(
    session,
    logicalSlot,
    fileName,
    data
  );
  await publishPreparedTranscriptArtifacts(session, [prepared]);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readDraftFileBounded(filePath: string): Promise<string | null> {
  const maxBytes = SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes;
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) {
    return null;
  }

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
        return new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks, totalBytes)
        );
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

/**
 * P4-5：只保留最近 MAX_CONFLICT_BACKUPS 份冲突备份（按文件名里的时间戳降序），其余删除。
 * 目录读不到或删不掉都静默略过 —— 清理失败绝不能影响主草稿的写入语义。
 */
async function pruneConflictBackups(session: DraftSessionSource): Promise<void> {
  const dir = getDraftDir(session);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  const backups = entries
    .map((name) => {
      const match = name.match(CONFLICT_BACKUP_RE);
      return match ? { name, ts: Number.parseInt(match[1], 10) } : null;
    })
    .filter((item): item is { name: string; ts: number } => item !== null)
    .sort((a, b) => b.ts - a.ts);

  for (const stale of backups.slice(MAX_CONFLICT_BACKUPS)) {
    try {
      const reference = getDraftLocalReference(session, stale.name);
      const artifacts = await findBillableStoredArtifactsByOwner(
        'draft',
        session.id
      );
      const matching = artifacts.filter(
        (artifact) =>
          artifact.artifactType === STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT &&
          artifact.reference === reference
      );
      await markStoredArtifactsDeletePending(
        matching.map((artifact) => artifact.id)
      );
      await fs.rm(path.join(dir, stale.name), { force: true });
      for (const artifact of matching) {
        await releaseStoredArtifact(artifact.id);
      }
    } catch {
      // 单个备份删除失败时保留其账本收费，下轮再试。
    }
  }
}

/** 保存或覆盖转录稿草稿（整体快照） */
export async function persistTranscriptDraft(
  session: DraftSessionSource,
  payload: TranscriptDraftPayload
): Promise<TranscriptDraftManifest> {
  await ensureDraftDir(session);

  const now = Date.now();
  const existing = await loadTranscriptDraftManifest(session);
  const incomingCount = Array.isArray(payload.segments) ? payload.segments.length : 0;

  // 单调守卫：绝不让「更短/重置」的 payload 覆盖掉盘上更完整的草稿。
  // 与音频 chunk 的 seq 续号防覆盖(#19)对称 —— 音频侧新录音从 maxSeq+1 续号不覆盖旧块，
  // 转录侧此前是无守卫的整体替换，一旦刷新后「僵尸录音」从 0 段重新 PUT，就把整份转录盖成
  // 只剩重启后那段。这里命中缩水/重置时：把 incoming 写入带时间戳的 .conflict 备份留档，
  // 主草稿保持更完整的那份不动（备份文件随 deleteTranscriptDraft 整目录清理，不泄漏）。
  // 转录在单次会话与冷恢复续录中都只增不减，故正常写入永远 incomingCount >= 现有段数。
  if (existing && existing.segmentCount > 0 && incomingCount < existing.segmentCount) {
    try {
      const conflictName = `transcript.conflict-${now}-${crypto.randomUUID()}.json`;
      await writeTranscriptDraftArtifact(
        session,
        `conflict:${conflictName}`,
        conflictName,
        JSON.stringify(payload, null, 2)
      );
      // P4-5：写完立刻滚动清理，保留最近 MAX_CONFLICT_BACKUPS 份 —— 否则每次冲突 PUT 都留一份
      // 全量副本，无上限增长且随会话永久驻留。
      await pruneConflictBackups(session);
    } catch {
      // 备份失败不阻断：主草稿不动即可，本次 PUT 视为「已保护地忽略」
    }
    console.warn(
      `[transcriptDraft] 拒绝覆盖草稿：incoming ${incomingCount} 段 < 现有 ${existing.segmentCount} 段，` +
        `session=${session.id}，已存 .conflict 备份，主草稿保持不变`
    );
    return {
      sessionId: session.id,
      userId: session.userId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      segmentCount: existing.segmentCount,
    };
  }

  const manifest: TranscriptDraftManifest = {
    sessionId: session.id,
    userId: session.userId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    segmentCount: Array.isArray(payload.segments) ? payload.segments.length : 0,
  };
  const generation = crypto.randomUUID();
  const prepared: PreparedTranscriptDraftArtifact[] = [];
  try {
    prepared.push(
      await prepareTranscriptDraftArtifact(
        session,
        TRANSCRIPT_DATA_SLOT,
        `transcript-${generation}.json`,
        JSON.stringify(payload, null, 2)
      )
    );
    prepared.push(
      await prepareTranscriptDraftArtifact(
        session,
        TRANSCRIPT_MANIFEST_SLOT,
        `manifest-${generation}.json`,
        JSON.stringify(manifest, null, 2)
      )
    );
  } catch (error) {
    await Promise.all(prepared.map(discardPreparedTranscriptArtifact));
    throw error;
  }
  await publishPreparedTranscriptArtifacts(session, prepared);

  return manifest;
}

/** 加载草稿 manifest（轻量，不含完整数据） */
export async function loadTranscriptDraftManifest(
  session: DraftSessionSource
): Promise<TranscriptDraftManifest | null> {
  try {
    const manifestPath = await resolveDraftSlotPath(
      session,
      TRANSCRIPT_MANIFEST_SLOT,
      getDraftManifestPath(session)
    );
    if (!manifestPath || !(await fileExists(manifestPath))) return null;
    const raw = await readDraftFileBounded(manifestPath);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<TranscriptDraftManifest>;
    if (
      parsed.sessionId !== session.id ||
      parsed.userId !== session.userId ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      segmentCount: typeof parsed.segmentCount === 'number' ? parsed.segmentCount : 0,
    };
  } catch {
    return null;
  }
}

/** 加载完整的转录稿草稿数据 */
export async function loadTranscriptDraft(
  session: DraftSessionSource
): Promise<TranscriptDraftPayload | null> {
  try {
    const dataPath = await resolveDraftSlotPath(
      session,
      TRANSCRIPT_DATA_SLOT,
      getDraftDataPath(session)
    );
    if (!dataPath || !(await fileExists(dataPath))) return null;
    const raw = await readDraftFileBounded(dataPath);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<TranscriptDraftPayload>;
    return {
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      translations:
        parsed.translations && typeof parsed.translations === 'object' && !Array.isArray(parsed.translations)
          ? parsed.translations
          : {},
      clientTs: typeof parsed.clientTs === 'number' ? parsed.clientTs : 0,
      recordingStartTime: typeof parsed.recordingStartTime === 'number' ? parsed.recordingStartTime : undefined,
      pausedAt: typeof parsed.pausedAt === 'number' ? parsed.pausedAt : undefined,
      totalPausedMs: typeof parsed.totalPausedMs === 'number' ? parsed.totalPausedMs : undefined,
      totalDurationMs: typeof parsed.totalDurationMs === 'number' ? parsed.totalDurationMs : undefined,
      summaryRunningContext: typeof parsed.summaryRunningContext === 'string' ? parsed.summaryRunningContext : undefined,
      currentSessionIndex: typeof parsed.currentSessionIndex === 'number' ? parsed.currentSessionIndex : undefined,
    };
  } catch {
    return null;
  }
}

/** 删除转录稿草稿 */
export async function deleteTranscriptDraft(
  session: DraftSessionSource
): Promise<void> {
  const artifacts = await findBillableStoredArtifactsByOwner('draft', session.id);
  const transcriptArtifacts = artifacts.filter(
    (artifact) =>
      artifact.artifactType === STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT
  );
  await markStoredArtifactsDeletePending(
    transcriptArtifacts.map((artifact) => artifact.id)
  );
  await fs.rm(getDraftDir(session), { recursive: true, force: true });
  for (const artifact of transcriptArtifacts) {
    await releaseStoredArtifact(artifact.id);
  }
}
