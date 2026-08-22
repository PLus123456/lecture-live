import 'server-only';

import crypto from 'crypto';
import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  CloudreveRangeNotSatisfiableError,
  CloudreveStorage,
} from '@/lib/storage/cloudreve';
import {
  CHAT_QUOTA_ARTIFACT_TYPE_LIST,
  STORED_ARTIFACT_BACKFILL_COMPLETE,
  STORED_ARTIFACT_BACKFILL_MARKER,
  STORED_ARTIFACT_STATE,
  STORED_ARTIFACT_TYPE,
  buildStoredArtifactLogicalKey,
  type StoredArtifactType,
} from '@/lib/storage/storedArtifactLedger';

const DATA_ROOT = path.resolve(process.cwd(), 'data');
const RECORDING_DRAFT_ROOT = path.join(DATA_ROOT, 'recording-drafts');
const TRANSCRIPT_DRAFT_ROOT = path.join(DATA_ROOT, 'transcript-drafts');
const CHAT_IMAGE_ROOT = path.join(DATA_ROOT, 'chatimages');
const BACKFILL_LOCK = 'lecture_live_stored_artifact_backfill_v1';
const PAGE_SIZE = 200;

type BackfillArtifact = {
  userId: string;
  ownerType: 'session' | 'chat_attachment' | 'draft';
  ownerId: string;
  sessionId?: string | null;
  conversationId?: string | null;
  artifactType: StoredArtifactType;
  reference: string;
  storage: 'local' | 'cloudreve';
  bytes: bigint;
  /** Matches runtime custom logical slots for per-file draft artifacts. */
  logicalOwnerId?: string;
};

type SessionBackfillRow = {
  id: string;
  userId: string;
  recordingPath: string | null;
  enhancedAudioPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  reportPath: string | null;
  fullTranscriptPath: string | null;
};

type AttachmentBackfillRow = {
  id: string;
  conversationId: string;
  userId: string;
  cloudrevePath: string;
  extractedTextPath: string | null;
  storedArtifactId: string | null;
  source: string;
};

export interface StoredArtifactBackfillSummary {
  artifacts: number;
  sessions: number;
  attachments: number;
  drafts: number;
  inlineImages: number;
  alreadyComplete: boolean;
}

let cloudrevePromise: Promise<CloudreveStorage> | null = null;

function safeLocalPath(reference: string): string | null {
  if (!reference.startsWith('local:')) return null;
  const relative = reference.slice('local:'.length);
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) return null;
  const resolved = path.resolve(DATA_ROOT, relative);
  return resolved.startsWith(`${DATA_ROOT}${path.sep}`) ? resolved : null;
}

function normalizeOwnerId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '');
}

function storageForReference(reference: string): 'local' | 'cloudreve' {
  if (reference.startsWith('local:')) return 'local';
  if (reference.startsWith('/')) return 'cloudreve';
  throw new Error(`unsupported artifact reference: ${reference}`);
}

/** Parse only authoritative headers; caller cancels the one-byte body immediately. */
export function parseMeasuredRemoteBytes(
  headers: Headers,
  status = 200
): bigint | null {
  const range = headers.get('content-range')?.trim();
  const match = range?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  if (match) return BigInt(match[1]);
  // Content-Length is the total object size only for a full response. On a 206
  // it is merely the selected range length (usually 1) and must never be billed
  // as the whole artifact when Content-Range is missing.
  const length = status === 200 ? headers.get('content-length')?.trim() : null;
  if (length && /^\d+$/.test(length)) return BigInt(length);
  return null;
}

async function measureReferenceBytes(
  reference: string,
  userId: string
): Promise<bigint> {
  const localPath = safeLocalPath(reference);
  if (localPath) {
    const stat = await fs.stat(localPath);
    if (!stat.isFile()) throw new Error(`artifact is not a file: ${reference}`);
    return BigInt(stat.size);
  }
  if (!reference.startsWith('/')) {
    throw new Error(`invalid artifact reference: ${reference}`);
  }

  cloudrevePromise ??= CloudreveStorage.create();
  try {
    const response = await (
      await cloudrevePromise
    ).openDownloadStream(reference, {
      expectedUserId: userId,
      range: 'bytes=0-0',
    });
    try {
      const bytes = parseMeasuredRemoteBytes(response.headers, response.status);
      if (bytes === null) {
        throw new Error(`remote artifact omitted authoritative size: ${reference}`);
      }
      return bytes;
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof CloudreveRangeNotSatisfiableError) {
      const empty = error.contentRange?.match(/^bytes\s+\*\/0$/i);
      if (empty) return BigInt(0);
    }
    throw error;
  }
}

function artifactHash(input: BackfillArtifact): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        input.userId,
        input.ownerType,
        input.ownerId,
        input.artifactType,
        input.reference,
      ].join('\0'),
      'utf8'
    )
    .digest('hex');
}

async function ensureBackfilledArtifact(input: BackfillArtifact): Promise<string> {
  const digest = artifactHash(input);
  const id = `backfill_${digest.slice(0, 48)}`;
  const reservationKey = `backfill:${digest}`;
  const logicalKey = buildStoredArtifactLogicalKey(
    input.ownerType,
    input.logicalOwnerId ?? input.ownerId,
    input.artifactType
  );

  // Existing runtime-ledger rows win. This matters during rolling upgrades where
  // a new writer may publish before the one-off inventory obtains its lock.
  const existing = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM StoredArtifact
    WHERE userId = ${input.userId}
      AND artifactType = ${input.artifactType}
      AND reference = ${input.reference}
      AND chargedBytes > 0
    LIMIT 1
  `);
  if (existing[0]) return existing[0].id;

  await prisma.$executeRaw(Prisma.sql`
    INSERT IGNORE INTO StoredArtifact (
      id, userId, ownerType, ownerId, sessionId, conversationId,
      artifactType, storage, reference, state, bytes, chargedBytes,
      identityKey, logicalKey, reservationKey, replacesArtifactId,
      expiresAt, createdAt, updatedAt, deletedAt
    ) VALUES (
      ${id}, ${input.userId}, ${input.ownerType}, ${input.ownerId},
      ${input.sessionId ?? null}, ${input.conversationId ?? null},
      ${input.artifactType}, ${input.storage}, ${input.reference},
      ${STORED_ARTIFACT_STATE.ACTIVE}, ${input.bytes}, ${input.bytes},
      ${logicalKey}, ${logicalKey}, ${reservationKey}, NULL,
      NULL, NOW(3), NOW(3), NULL
    )
  `);

  const inserted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM StoredArtifact
    WHERE reservationKey = ${reservationKey}
       OR identityKey = ${logicalKey}
    ORDER BY (reservationKey = ${reservationKey}) DESC
    LIMIT 1
  `);
  if (!inserted[0]) {
    throw new Error(`could not create artifact inventory row for ${input.reference}`);
  }
  return inserted[0].id;
}

async function backfillReference(input: Omit<BackfillArtifact, 'bytes' | 'storage'>) {
  const bytes = await measureReferenceBytes(input.reference, input.userId);
  return ensureBackfilledArtifact({
    ...input,
    bytes,
    storage: storageForReference(input.reference),
  });
}

function defaultLocalReference(
  category: string,
  sessionId: string,
  extension = 'json'
): string {
  return `local:${category}/${normalizeOwnerId(sessionId)}.${extension}`;
}

async function firstExistingLocalReference(
  references: ReadonlyArray<string>
): Promise<string | null> {
  for (const reference of references) {
    const localPath = safeLocalPath(reference);
    if (!localPath) continue;
    try {
      const stat = await fs.stat(localPath);
      if (stat.isFile()) return reference;
    } catch {
      // Missing legacy default is normal.
    }
  }
  return null;
}

async function backfillSessions(summary: StoredArtifactBackfillSummary) {
  let cursor = '';
  while (true) {
    const rows = await prisma.$queryRaw<SessionBackfillRow[]>(Prisma.sql`
      SELECT id, userId, recordingPath, enhancedAudioPath, transcriptPath,
             summaryPath, reportPath, fullTranscriptPath
      FROM Session
      WHERE id > ${cursor}
      ORDER BY id ASC
      LIMIT ${PAGE_SIZE}
    `);
    if (rows.length === 0) break;
    for (const session of rows) {
      const recordingReference =
        session.recordingPath ??
        (await firstExistingLocalReference(
          ['webm', 'mp4', 'mp3', 'wav', 'ogg'].map((extension) =>
            defaultLocalReference('recordings', session.id, extension)
          )
        ));
      const descriptors: Array<{
        reference: string | null;
        artifactType: StoredArtifactType;
      }> = [
        {
          reference: recordingReference,
          artifactType: STORED_ARTIFACT_TYPE.RECORDING,
        },
        {
          reference: session.enhancedAudioPath,
          artifactType: STORED_ARTIFACT_TYPE.ENHANCED_AUDIO,
        },
        {
          reference:
            session.transcriptPath ??
            (await firstExistingLocalReference([
              defaultLocalReference('transcripts', session.id),
            ])),
          artifactType: STORED_ARTIFACT_TYPE.TRANSCRIPT,
        },
        {
          reference:
            session.summaryPath ??
            (await firstExistingLocalReference([
              defaultLocalReference('summaries', session.id),
            ])),
          artifactType: STORED_ARTIFACT_TYPE.SUMMARY,
        },
        {
          reference:
            session.reportPath ??
            (await firstExistingLocalReference([
              defaultLocalReference('reports', session.id),
            ])),
          artifactType: STORED_ARTIFACT_TYPE.REPORT,
        },
        {
          reference:
            session.fullTranscriptPath ??
            (await firstExistingLocalReference([
              defaultLocalReference('full-transcripts', session.id),
            ])),
          artifactType: STORED_ARTIFACT_TYPE.FULL_TRANSCRIPT,
        },
      ];
      for (const descriptor of descriptors) {
        if (!descriptor.reference) continue;
        await backfillReference({
          userId: session.userId,
          ownerType: 'session',
          ownerId: session.id,
          sessionId: session.id,
          artifactType: descriptor.artifactType,
          reference: descriptor.reference,
        });
        summary.artifacts += 1;
      }
      summary.sessions += 1;
    }
    cursor = rows[rows.length - 1].id;
  }
}

async function backfillAttachments(summary: StoredArtifactBackfillSummary) {
  let cursor = '';
  while (true) {
    const rows = await prisma.$queryRaw<AttachmentBackfillRow[]>(Prisma.sql`
      SELECT id, conversationId, userId, cloudrevePath, extractedTextPath,
             storedArtifactId, source
      FROM ChatAttachment
      WHERE id > ${cursor}
        AND source = 'UPLOAD'
      ORDER BY id ASC
      LIMIT ${PAGE_SIZE}
    `);
    if (rows.length === 0) break;
    for (const attachment of rows) {
      const rawId = await backfillReference({
        userId: attachment.userId,
        ownerType: 'chat_attachment',
        ownerId: attachment.id,
        conversationId: attachment.conversationId,
        artifactType: STORED_ARTIFACT_TYPE.CHAT_RAW,
        reference: attachment.cloudrevePath,
      });
      await prisma.$executeRaw(Prisma.sql`
        UPDATE ChatAttachment
        SET storedArtifactId = ${rawId}
        WHERE id = ${attachment.id}
          AND (storedArtifactId IS NULL OR storedArtifactId = ${rawId})
      `);
      summary.artifacts += 1;
      if (attachment.extractedTextPath) {
        await backfillReference({
          userId: attachment.userId,
          ownerType: 'chat_attachment',
          ownerId: attachment.id,
          conversationId: attachment.conversationId,
          artifactType: STORED_ARTIFACT_TYPE.CHAT_EXTRACTED,
          reference: attachment.extractedTextPath,
        });
        summary.artifacts += 1;
      }
      summary.attachments += 1;
    }
    cursor = rows[rows.length - 1].id;
  }
}

async function safeDirectoryEntries(root: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

type DraftBackfillFile = { name: string; mtimeMs: number };

/**
 * Runtime draft readers address the current immutable generation through a
 * stable logical slot. Backfill must therefore promote exactly one newest
 * transcript/manifest generation to that slot; older crash leftovers still
 * receive unique billable identities and are removed with the draft owner.
 */
export function classifyDraftBackfillSlots(
  kind: 'recording' | 'transcript',
  ownerId: string,
  files: ReadonlyArray<DraftBackfillFile>
): Map<string, string> {
  const slots = new Map<string, string>();
  const newest = (matches: (name: string) => boolean): string | null => {
    const candidates = files.filter((file) => matches(file.name));
    candidates.sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
    );
    return candidates[0]?.name ?? null;
  };

  if (kind === 'recording') {
    const currentManifest = newest(
      (name) =>
        name === 'manifest.json' || /^manifest-[a-f0-9-]+\.json$/i.test(name)
    );
    for (const file of files) {
      slots.set(
        file.name,
        file.name === currentManifest
          ? `${ownerId}:manifest`
          : `${ownerId}:file:${file.name}`
      );
    }
    return slots;
  }

  const currentTranscript = newest(
    (name) =>
      name === 'transcript.json' || /^transcript-[a-f0-9-]+\.json$/i.test(name)
  );
  const currentManifest = newest(
    (name) =>
      name === 'manifest.json' || /^manifest-[a-f0-9-]+\.json$/i.test(name)
  );
  for (const file of files) {
    const slot =
      file.name === currentTranscript
        ? `${ownerId}:transcript`
        : file.name === currentManifest
          ? `${ownerId}:manifest`
          : `${ownerId}:file:${file.name}`;
    slots.set(file.name, slot);
  }
  return slots;
}

async function loadDraftOwner(
  directory: string
): Promise<{ id: string; userId: string } | null> {
  const entries = await safeDirectoryEntries(directory);
  const manifestEntries = entries.filter(
    (entry) =>
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      (entry.name === 'manifest.json' ||
        /^manifest-[a-f0-9-]+\.json$/i.test(entry.name))
  );
  if (manifestEntries.length > 1024) {
    throw new Error(`too many draft manifest generations: ${directory}`);
  }
  const manifests = await Promise.all(
    manifestEntries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath);
      return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
    })
  );
  manifests.sort((left, right) => right.mtimeMs - left.mtimeMs);

  let record: Record<string, unknown> | null = null;
  for (const manifest of manifests) {
    if (manifest.size > 1024 * 1024) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(manifest.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      // Try the preceding immutable generation.
    }
  }
  if (
    !record ||
    typeof record.sessionId !== 'string' ||
    typeof record.userId !== 'string'
  ) {
    return null;
  }
  if (normalizeOwnerId(record.sessionId) !== path.basename(directory)) return null;
  const owner = await prisma.$queryRaw<Array<{ id: string; userId: string }>>(
    Prisma.sql`
      SELECT id, userId FROM Session
      WHERE id = ${record.sessionId} AND userId = ${record.userId}
      LIMIT 1
    `
  );
  return owner[0] ?? null;
}

async function backfillDraftRoot(
  root: string,
  kind: 'recording' | 'transcript',
  summary: StoredArtifactBackfillSummary
) {
  for (const directoryEntry of await safeDirectoryEntries(root)) {
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) continue;
    const directory = path.join(root, directoryEntry.name);
    const owner = await loadDraftOwner(directory);
    if (!owner) {
      throw new Error(`cannot prove draft ownership: ${directory}`);
    }

    const candidates: Array<{
      path: string;
      reference: string;
      slot: string;
      bytes: bigint;
    }> = [];
    if (kind === 'recording') {
      const files = await safeDirectoryEntries(directory);
      const manifestFiles: Array<DraftBackfillFile & { path: string; bytes: bigint }> = [];
      for (const file of files) {
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          !(
            file.name === 'manifest.json' ||
            /^manifest-[a-f0-9-]+\.json$/i.test(file.name)
          )
        ) {
          continue;
        }
        const filePath = path.join(directory, file.name);
        const stat = await fs.stat(filePath);
        manifestFiles.push({
          name: file.name,
          path: filePath,
          bytes: BigInt(stat.size),
          mtimeMs: stat.mtimeMs,
        });
      }
      const manifestSlots = classifyDraftBackfillSlots(
        'recording',
        owner.id,
        manifestFiles
      );
      for (const file of manifestFiles) {
        candidates.push({
          path: file.path,
          reference: `local:recording-drafts/${directoryEntry.name}/${file.name}`,
          slot: manifestSlots.get(file.name)!,
          bytes: file.bytes,
        });
      }
      const chunkRoot = path.join(directory, 'chunks');
      for (const file of await safeDirectoryEntries(chunkRoot)) {
        if (!file.isFile() || file.isSymbolicLink() || !/^\d+\.chunk$/.test(file.name)) {
          continue;
        }
        const seq = Number.parseInt(file.name, 10);
        const filePath = path.join(chunkRoot, file.name);
        const stat = await fs.stat(filePath);
        candidates.push({
          path: filePath,
          reference: `local:recording-drafts/${directoryEntry.name}/chunks/${file.name}`,
          slot: `${owner.id}:chunk:${seq}`,
          bytes: BigInt(stat.size),
        });
      }
    } else {
      const jsonFiles: Array<DraftBackfillFile & { path: string; bytes: bigint }> = [];
      for (const file of await safeDirectoryEntries(directory)) {
        if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(directory, file.name);
        const stat = await fs.stat(filePath);
        jsonFiles.push({
          name: file.name,
          path: filePath,
          bytes: BigInt(stat.size),
          mtimeMs: stat.mtimeMs,
        });
      }
      const jsonSlots = classifyDraftBackfillSlots(
        'transcript',
        owner.id,
        jsonFiles
      );
      for (const file of jsonFiles) {
        candidates.push({
          path: file.path,
          reference: `local:transcript-drafts/${directoryEntry.name}/${file.name}`,
          slot: jsonSlots.get(file.name)!,
          bytes: file.bytes,
        });
      }
    }

    for (const candidate of candidates) {
      await ensureBackfilledArtifact({
        userId: owner.userId,
        ownerType: 'draft',
        ownerId: owner.id,
        sessionId: owner.id,
        artifactType:
          kind === 'recording'
            ? STORED_ARTIFACT_TYPE.RECORDING_DRAFT
            : STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT,
        reference: candidate.reference,
        storage: 'local',
        bytes: candidate.bytes,
        logicalOwnerId: candidate.slot,
      });
      summary.artifacts += 1;
      summary.drafts += 1;
    }
  }
}

function mimeTypeForInlineName(fileName: string): string | null {
  switch (path.extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return null;
  }
}

async function backfillInlineImages(summary: StoredArtifactBackfillSummary) {
  for (const directoryEntry of await safeDirectoryEntries(CHAT_IMAGE_ROOT)) {
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) continue;
    const conversationId = directoryEntry.name;
    const owners = await prisma.$queryRaw<Array<{ userId: string | null }>>(
      Prisma.sql`
        SELECT userId FROM Conversation WHERE id = ${conversationId} LIMIT 1
      `
    );
    const userId = owners[0]?.userId;
    if (!userId) {
      // There is no possible authenticated reader after the owning Conversation
      // disappears. Remove the proven orphan rather than marking inventory complete
      // while leaving unowned bytes outside the ledger.
      await fs.rm(path.join(CHAT_IMAGE_ROOT, directoryEntry.name), {
        recursive: true,
        force: true,
      });
      continue;
    }

    for (const file of await safeDirectoryEntries(
      path.join(CHAT_IMAGE_ROOT, directoryEntry.name)
    )) {
      if (!file.isFile() || file.isSymbolicLink()) continue;
      const mimeType = mimeTypeForInlineName(file.name);
      if (!mimeType) {
        throw new Error(`unsupported historical inline image: ${file.name}`);
      }
      const reference = `local:chatimages/${conversationId}/${file.name}`;
      const existingAttachments = await prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT id FROM ChatAttachment
          WHERE conversationId = ${conversationId}
            AND cloudrevePath = ${reference}
          LIMIT 1
        `
      );
      const digest = crypto
        .createHash('sha256')
        .update(`${conversationId}\0${file.name}`, 'utf8')
        .digest('hex');
      const attachmentId =
        existingAttachments[0]?.id ?? `backfill_inline_${digest.slice(0, 40)}`;
      const stat = await fs.stat(path.join(CHAT_IMAGE_ROOT, conversationId, file.name));
      const artifactId = await ensureBackfilledArtifact({
        userId,
        ownerType: 'chat_attachment',
        ownerId: attachmentId,
        conversationId,
        artifactType: STORED_ARTIFACT_TYPE.INLINE_IMAGE,
        reference,
        storage: 'local',
        bytes: BigInt(stat.size),
      });
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO ChatAttachment (
          id, conversationId, userId, kind, fileName, mimeType, bytes,
          cloudrevePath, extractedTextPath, source, storedArtifactId, expiresAt,
          createdAt, lastAccessedAt
        ) VALUES (
          ${attachmentId}, ${conversationId}, ${userId}, 'image', ${file.name},
          ${mimeType}, ${BigInt(stat.size)}, ${reference}, NULL, 'INLINE',
          ${artifactId}, NULL, NOW(3), NOW(3)
        )
        ON DUPLICATE KEY UPDATE
          source = 'INLINE', storedArtifactId = ${artifactId}, expiresAt = NULL,
          bytes = ${BigInt(stat.size)}
      `);
      summary.artifacts += 1;
      summary.inlineImages += 1;
    }
  }
}

async function markerComplete(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>(Prisma.sql`
    SELECT value FROM SiteSetting
    WHERE \`key\` = ${STORED_ARTIFACT_BACKFILL_MARKER}
    LIMIT 1
  `);
  return rows[0]?.value === STORED_ARTIFACT_BACKFILL_COMPLETE;
}

async function finishBackfill() {
  await prisma.$transaction(
    async (tx) => {
      // Same row-lock order as reserve/settle/release. Reservations that started
      // before this transaction finish first; later ones wait until the snapshot,
      // counter rebuild and marker publication are atomically visible.
      await tx.$queryRaw`SELECT id FROM User ORDER BY id ASC FOR UPDATE`;
      // Rebuild only the chat-files dimension — the same filter reconcileStorageBytes
      // uses. Recording/transcript/draft rows stay in the ledger (that is the point of
      // the unified inventory) but must not be billed to the 100MB chat quota, or the
      // backfill itself puts every existing FREE user over limit.
      const chatTypes = CHAT_QUOTA_ARTIFACT_TYPE_LIST.map(
        (type) => `'${type.replace(/'/g, "''")}'`
      ).join(', ');
      await tx.$executeRawUnsafe(`
        UPDATE \`User\` \`u\`
        LEFT JOIN (
          SELECT \`userId\`, COALESCE(SUM(\`chargedBytes\`), 0) AS \`used\`
          FROM \`StoredArtifact\`
          WHERE \`chargedBytes\` > 0
            AND \`artifactType\` IN (${chatTypes})
          GROUP BY \`userId\`
        ) \`a\` ON \`a\`.\`userId\` = \`u\`.\`id\`
        SET \`u\`.\`storageBytesUsed\` = COALESCE(\`a\`.\`used\`, 0)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO SiteSetting (\`key\`, value, updatedAt)
        VALUES (
          ${STORED_ARTIFACT_BACKFILL_MARKER},
          ${STORED_ARTIFACT_BACKFILL_COMPLETE},
          NOW(3)
        )
        ON DUPLICATE KEY UPDATE
          value = ${STORED_ARTIFACT_BACKFILL_COMPLETE}, updatedAt = NOW(3)
      `);
    },
    { maxWait: 30_000, timeout: 120_000 }
  );
}

/** Idempotent, fail-closed inventory used by both migration and db-push deployments. */
export async function runStoredArtifactBackfill(): Promise<StoredArtifactBackfillSummary> {
  const summary: StoredArtifactBackfillSummary = {
    artifacts: 0,
    sessions: 0,
    attachments: 0,
    drafts: 0,
    inlineImages: 0,
    alreadyComplete: false,
  };
  const acquired = await prisma.$queryRaw<Array<{ acquired: bigint }>>(Prisma.sql`
    SELECT GET_LOCK(${BACKFILL_LOCK}, 120) AS acquired
  `);
  if (Number(acquired[0]?.acquired ?? BigInt(0)) !== 1) {
    throw new Error('timed out waiting for stored artifact backfill lock');
  }
  try {
    if (await markerComplete()) {
      summary.alreadyComplete = true;
      return summary;
    }
    await backfillSessions(summary);
    await backfillAttachments(summary);
    await backfillDraftRoot(RECORDING_DRAFT_ROOT, 'recording', summary);
    await backfillDraftRoot(TRANSCRIPT_DRAFT_ROOT, 'transcript', summary);
    await backfillInlineImages(summary);
    await finishBackfill();
    return summary;
  } finally {
    await prisma.$queryRaw(Prisma.sql`
      SELECT RELEASE_LOCK(${BACKFILL_LOCK}) AS released
    `).catch(() => undefined);
  }
}
