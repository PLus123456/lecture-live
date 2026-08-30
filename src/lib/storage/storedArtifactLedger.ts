import 'server-only';

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface StoredArtifactRow {
  id: string;
  userId: string;
  ownerType: string;
  ownerId: string;
  sessionId: string | null;
  conversationId: string | null;
  artifactType: string;
  storage: string;
  reference: string | null;
  state: string;
  bytes: bigint;
  chargedBytes: bigint;
  identityKey: string | null;
  logicalKey: string;
  reservationKey: string;
  replacesArtifactId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export const STORED_ARTIFACT_BACKFILL_MARKER = 'stored_artifact_backfill_v1';
export const STORED_ARTIFACT_BACKFILL_COMPLETE = 'complete';
export const STORED_ARTIFACT_RESERVATION_TTL_MS = 60 * 60 * 1000;

export const STORED_ARTIFACT_STATE = {
  RESERVED: 'RESERVED',
  ACTIVE: 'ACTIVE',
  ORPHANED: 'ORPHANED',
  CLEANING: 'CLEANING',
  DELETE_PENDING: 'DELETE_PENDING',
  REPLACED: 'REPLACED',
  DELETED: 'DELETED',
} as const;

export const STORED_ARTIFACT_TYPE = {
  RECORDING: 'recording',
  ENHANCED_AUDIO: 'enhanced_audio',
  TRANSCRIPT: 'transcript',
  SUMMARY: 'summary',
  REPORT: 'report',
  FULL_TRANSCRIPT: 'full_transcript',
  RECORDING_DRAFT: 'recording_draft',
  TRANSCRIPT_DRAFT: 'transcript_draft',
  CHAT_RAW: 'chat_raw',
  CHAT_EXTRACTED: 'chat_extracted',
  INLINE_IMAGE: 'inline_image',
} as const;

export type StoredArtifactType =
  (typeof STORED_ARTIFACT_TYPE)[keyof typeof STORED_ARTIFACT_TYPE];

/**
 * `User.storageBytesUsed` / `storageBytesLimit` is the **chat files** byte quota —
 * admin panel「Chat 文件」→ `chat_files_quota_{free,pro,admin}_mb`, FREE 默认 100MB
 * (see resolveRoleStorageBytesLimit). Durable recording-class artifacts live on a
 * completely different dimension, `storageHoursLimit` (FREE 10h), enforced at the
 * recording entry points.
 *
 * The ledger deliberately records bytes for **every** artifact — that is what makes
 * SEC-019's reconciliation exact and what stopped inline images from bypassing
 * accounting (SEC-016). Only the chat-quota *counter* is restricted to chat-class
 * artifacts. Charging a 10-hour recording entitlement against a 100MB chat budget
 * makes recording structurally impossible for every non-ADMIN user: draft chunks
 * 402 mid-recording and finalize leaves the session stuck in FINALIZING forever.
 */
const CHAT_QUOTA_ARTIFACT_TYPES: ReadonlySet<string> = new Set<string>([
  STORED_ARTIFACT_TYPE.CHAT_RAW,
  STORED_ARTIFACT_TYPE.CHAT_EXTRACTED,
  STORED_ARTIFACT_TYPE.INLINE_IMAGE,
]);

/** SQL list form of {@link CHAT_QUOTA_ARTIFACT_TYPES}, for ledger-sourced rebuilds. */
export const CHAT_QUOTA_ARTIFACT_TYPE_LIST: readonly string[] = Object.freeze([
  ...CHAT_QUOTA_ARTIFACT_TYPES,
]);

export function countsTowardChatStorageQuota(artifactType: string): boolean {
  return CHAT_QUOTA_ARTIFACT_TYPES.has(artifactType);
}

export class StoredArtifactQuotaExceededError extends Error {
  constructor() {
    super('storage byte quota exceeded');
    this.name = 'StoredArtifactQuotaExceededError';
  }
}

export class StoredArtifactConversationLimitError extends Error {
  constructor(
    public readonly maxBytes: bigint,
    public readonly maxCount: number
  ) {
    super('conversation artifact limit exceeded');
    this.name = 'StoredArtifactConversationLimitError';
  }
}

export class StoredArtifactPublishConflictError extends Error {
  constructor() {
    super('stored artifact logical identity changed before publish');
    this.name = 'StoredArtifactPublishConflictError';
  }
}

export class StoredArtifactPublishOutcomeUnknownError extends Error {
  constructor() {
    super('stored artifact publish outcome could not be determined');
    this.name = 'StoredArtifactPublishOutcomeUnknownError';
  }
}

export class StoredArtifactBackfillIncompleteError extends Error {
  constructor() {
    super('stored artifact inventory backfill is not complete');
    this.name = 'StoredArtifactBackfillIncompleteError';
  }
}

export class StoredArtifactCoverageError extends Error {
  constructor() {
    super('stored artifact inventory does not cover every owner reference');
    this.name = 'StoredArtifactCoverageError';
  }
}

export interface ReserveStoredArtifactInput {
  userId: string;
  ownerType: 'session' | 'conversation' | 'chat_attachment' | 'draft';
  ownerId: string;
  sessionId?: string | null;
  conversationId?: string | null;
  artifactType: StoredArtifactType;
  expectedBytes: number | bigint;
  logicalKey?: string;
  reservationKey?: string;
  expiresAt?: Date;
  conversationLimitBytes?: number | bigint;
  conversationLimitCount?: number;
}

export interface StoredArtifactReservation {
  id: string;
  userId: string;
  logicalKey: string;
  expectedBytes: bigint;
  state: string;
  reservationKey: string;
  replacesArtifactId: string | null;
}

export interface SettledStoredArtifact {
  artifact: StoredArtifactRow;
  previous: StoredArtifactRow | null;
}

function normalizeBytes(value: number | bigint): bigint {
  if (typeof value === 'bigint') {
    if (value < BigInt(0)) throw new TypeError('artifact bytes must be non-negative');
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('artifact bytes must be a non-negative safe integer');
  }
  return BigInt(value);
}

/** Stable, bounded identity for one logical owner slot. */
export function buildStoredArtifactLogicalKey(
  ownerType: string,
  ownerId: string,
  artifactType: string
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${ownerType}\0${ownerId}\0${artifactType}`, 'utf8')
    .digest('hex');
  return `artifact:${digest}`;
}

function toReservation(row: StoredArtifactRow): StoredArtifactReservation {
  return {
    id: row.id,
    userId: row.userId,
    logicalKey: row.logicalKey,
    expectedBytes: row.bytes,
    state: row.state,
    reservationKey: row.reservationKey,
    replacesArtifactId: row.replacesArtifactId,
  };
}

async function findArtifactById(
  tx: Prisma.TransactionClient,
  id: string,
  lock = false
): Promise<StoredArtifactRow | null> {
  const rows = lock
    ? await tx.$queryRaw<StoredArtifactRow[]>`
        SELECT * FROM StoredArtifact WHERE id = ${id} LIMIT 1 FOR UPDATE
      `
    : await tx.$queryRaw<StoredArtifactRow[]>`
        SELECT * FROM StoredArtifact WHERE id = ${id} LIMIT 1
      `;
  return rows[0] ?? null;
}

async function findArtifactByReservationKey(
  tx: Prisma.TransactionClient,
  reservationKey: string
): Promise<StoredArtifactRow | null> {
  const rows = await tx.$queryRaw<StoredArtifactRow[]>`
    SELECT * FROM StoredArtifact
    WHERE reservationKey = ${reservationKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function findArtifactByIdentityKey(
  tx: Prisma.TransactionClient,
  identityKey: string
): Promise<StoredArtifactRow | null> {
  const rows = await tx.$queryRaw<StoredArtifactRow[]>`
    SELECT * FROM StoredArtifact
    WHERE identityKey = ${identityKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function lockUserStorageRow(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM User WHERE id = ${userId} LIMIT 1 FOR UPDATE
  `;
  return rows.length === 1;
}

async function adjustUserStorageBytes(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: bigint,
  artifactType: string,
  enforceLimit: boolean
): Promise<void> {
  if (delta === BigInt(0)) return;
  // Non-chat artifacts are ledgered but never billed to the chat-files counter,
  // in both directions — skipping only the charge would drift the counter negative
  // on release. See CHAT_QUOTA_ARTIFACT_TYPES.
  if (!countsTowardChatStorageQuota(artifactType)) return;

  if (delta < BigInt(0)) {
    await tx.$executeRaw`
      UPDATE User
      SET storageBytesUsed = GREATEST(0, storageBytesUsed + ${delta})
      WHERE id = ${userId}
    `;
    return;
  }

  const affected = enforceLimit
    ? await tx.$executeRaw`
        UPDATE User
        SET storageBytesUsed = storageBytesUsed + ${delta}
        WHERE id = ${userId}
          AND (role = 'ADMIN' OR storageBytesUsed + ${delta} <= storageBytesLimit)
      `
    : await tx.$executeRaw`
        UPDATE User
        SET storageBytesUsed = storageBytesUsed + ${delta}
        WHERE id = ${userId}
      `;

  if (affected !== 1) throw new StoredArtifactQuotaExceededError();
}

/**
 * Atomically reserves durable bytes and creates the only ledger row for the write.
 * The previous ACTIVE artifact remains charged until its physical object is deleted.
 */
export async function reserveStoredArtifact(
  input: ReserveStoredArtifactInput
): Promise<StoredArtifactReservation> {
  const expectedBytes = normalizeBytes(input.expectedBytes);
  const logicalKey =
    input.logicalKey ??
    buildStoredArtifactLogicalKey(input.ownerType, input.ownerId, input.artifactType);
  const reservationKey = input.reservationKey ?? `reserve:${crypto.randomUUID()}`;
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + STORED_ARTIFACT_RESERVATION_TTL_MS);

  return prisma.$transaction(async (tx) => {
    if (!(await lockUserStorageRow(tx, input.userId))) {
      throw new StoredArtifactQuotaExceededError();
    }

    const existing = await findArtifactByReservationKey(tx, reservationKey);
    if (existing) {
      const sameReservation =
        existing.userId === input.userId &&
        existing.logicalKey === logicalKey &&
        existing.bytes === expectedBytes;
      if (!sameReservation) {
        throw new Error('stored artifact reservation key collision');
      }
      return toReservation(existing);
    }

    if (
      input.conversationId &&
      (input.conversationLimitBytes !== undefined ||
        input.conversationLimitCount !== undefined)
    ) {
      const usageRows = await tx.$queryRaw<
        Array<{ bytes: bigint | null; count: bigint }>
      >`
        SELECT SUM(chargedBytes) AS bytes, COUNT(*) AS count
        FROM StoredArtifact
        WHERE conversationId = ${input.conversationId}
          AND artifactType = ${input.artifactType}
          AND chargedBytes > 0
      `;
      const usedBytes = usageRows[0]?.bytes ?? BigInt(0);
      const usedCount = Number(usageRows[0]?.count ?? BigInt(0));
      const maxBytes =
        input.conversationLimitBytes === undefined
          ? BigInt('9223372036854775807')
          : normalizeBytes(input.conversationLimitBytes);
      const maxCount = input.conversationLimitCount ?? Number.MAX_SAFE_INTEGER;
      if (usedBytes + expectedBytes > maxBytes || usedCount + 1 > maxCount) {
        throw new StoredArtifactConversationLimitError(maxBytes, maxCount);
      }
    }

    await adjustUserStorageBytes(
      tx,
      input.userId,
      expectedBytes,
      input.artifactType,
      true
    );
    const previous = await findArtifactByIdentityKey(tx, logicalKey);
    const id = crypto.randomUUID();
    await tx.$executeRaw`
      INSERT INTO StoredArtifact (
        id, userId, ownerType, ownerId, sessionId, conversationId,
        artifactType, storage, reference, state, bytes, chargedBytes,
        identityKey, logicalKey, reservationKey, replacesArtifactId,
        expiresAt, createdAt, updatedAt, deletedAt
      ) VALUES (
        ${id}, ${input.userId}, ${input.ownerType}, ${input.ownerId},
        ${input.sessionId ?? null}, ${input.conversationId ?? null},
        ${input.artifactType}, 'pending', NULL, ${STORED_ARTIFACT_STATE.RESERVED},
        ${expectedBytes}, ${expectedBytes}, NULL, ${logicalKey}, ${reservationKey},
        ${previous?.id ?? null}, ${expiresAt}, NOW(3), NOW(3), NULL
      )
    `;
    const row = await findArtifactById(tx, id);
    if (!row) throw new Error('stored artifact reservation insert was not visible');
    return toReservation(row);
  });
}

export type SettleStoredArtifactInput = {
  actualBytes: number | bigint;
  storage: 'local' | 'cloudreve';
  reference: string;
  /** Optional compare-and-swap guard for multi-writer logical slots. */
  expectedPreviousArtifactId?: string | null;
};

async function settleStoredArtifactWithTx(
  tx: Prisma.TransactionClient,
  artifactId: string,
  input: SettleStoredArtifactInput
): Promise<SettledStoredArtifact> {
  const actualBytes = normalizeBytes(input.actualBytes);
  const initial = await findArtifactById(tx, artifactId);
  if (!initial) throw new Error('stored artifact reservation not found');
  if (!(await lockUserStorageRow(tx, initial.userId))) {
    throw new Error('stored artifact owner not found');
  }
  const row = await findArtifactById(tx, artifactId, true);
  if (!row) throw new Error('stored artifact reservation not found');
  if (row.state === STORED_ARTIFACT_STATE.ACTIVE) {
    if (
      row.bytes !== actualBytes ||
      row.reference !== input.reference ||
      row.storage !== input.storage
    ) {
      throw new Error('stored artifact settle replay mismatch');
    }
    return { artifact: row, previous: null };
  }
  if (row.state !== STORED_ARTIFACT_STATE.RESERVED) {
    throw new Error(`cannot settle stored artifact in state ${row.state}`);
  }

  await adjustUserStorageBytes(
    tx,
    row.userId,
    actualBytes - row.chargedBytes,
    row.artifactType,
    true
  );

  const previous = await findArtifactByIdentityKey(tx, row.logicalKey);
  if (
    Object.hasOwn(input, 'expectedPreviousArtifactId') &&
    (previous?.id ?? null) !== input.expectedPreviousArtifactId
  ) {
    throw new StoredArtifactPublishConflictError();
  }
  if (previous && previous.id !== row.id) {
    const previousExpiry = new Date(
      Date.now() + STORED_ARTIFACT_RESERVATION_TTL_MS
    );
    await tx.$executeRaw`
      UPDATE StoredArtifact
      SET state = ${STORED_ARTIFACT_STATE.ORPHANED},
          identityKey = NULL,
          expiresAt = ${previousExpiry},
          updatedAt = NOW(3)
      WHERE id = ${previous.id}
    `;
  }

  await tx.$executeRaw`
    UPDATE StoredArtifact
    SET storage = ${input.storage},
        reference = ${input.reference},
        state = ${STORED_ARTIFACT_STATE.ACTIVE},
        bytes = ${actualBytes},
        chargedBytes = ${actualBytes},
        identityKey = ${row.logicalKey},
        replacesArtifactId = ${previous?.id ?? row.replacesArtifactId},
        expiresAt = NULL,
        updatedAt = NOW(3)
    WHERE id = ${row.id}
      AND state = ${STORED_ARTIFACT_STATE.RESERVED}
  `;
  const artifact = await findArtifactById(tx, row.id);
  if (!artifact) throw new Error('stored artifact disappeared during settle');
  return {
    artifact,
    previous: previous && previous.id !== row.id ? previous : null,
  };
}

/** Publish a reservation using server-measured bytes. */
export async function settleStoredArtifact(
  artifactId: string,
  input: SettleStoredArtifactInput
): Promise<SettledStoredArtifact> {
  return prisma.$transaction((tx) =>
    settleStoredArtifactWithTx(tx, artifactId, input)
  );
}

/** Same operation for callers that must atomically publish an owner row/message. */
export async function settleStoredArtifactInTransaction(
  tx: Prisma.TransactionClient,
  artifactId: string,
  input: SettleStoredArtifactInput
): Promise<SettledStoredArtifact> {
  return settleStoredArtifactWithTx(tx, artifactId, input);
}

/** Publish multiple logical slots in one database commit. */
export async function settleStoredArtifactsAtomically(
  inputs: ReadonlyArray<{
    artifactId: string;
    publication: SettleStoredArtifactInput;
  }>
): Promise<SettledStoredArtifact[]> {
  return prisma.$transaction(async (tx) => {
    const settled: SettledStoredArtifact[] = [];
    for (const input of inputs) {
      settled.push(
        await settleStoredArtifactWithTx(
          tx,
          input.artifactId,
          input.publication
        )
      );
    }
    return settled;
  });
}

/**
 * Records the physical location of a staged object without publishing its logical
 * identity.  A crashed publisher can therefore be removed by the TTL cleanup.
 */
export async function recordReservedStoredArtifactLocation(
  artifactId: string,
  input: {
    actualBytes: number | bigint;
    storage: 'local' | 'cloudreve';
    reference: string;
  }
): Promise<void> {
  const actualBytes = normalizeBytes(input.actualBytes);
  await prisma.$transaction(async (tx) => {
    const initial = await findArtifactById(tx, artifactId);
    if (!initial) throw new Error('stored artifact reservation not found');
    if (!(await lockUserStorageRow(tx, initial.userId))) {
      throw new Error('stored artifact owner not found');
    }
    const row = await findArtifactById(tx, artifactId, true);
    if (!row || row.state !== STORED_ARTIFACT_STATE.RESERVED) {
      throw new Error('stored artifact is no longer reserved');
    }
    await adjustUserStorageBytes(
      tx,
      row.userId,
      actualBytes - row.chargedBytes,
      row.artifactType,
      true
    );
    await tx.$executeRaw`
      UPDATE StoredArtifact
      SET storage = ${input.storage},
          reference = ${input.reference},
          bytes = ${actualBytes},
          chargedBytes = ${actualBytes},
          updatedAt = NOW(3)
      WHERE id = ${row.id}
        AND state = ${STORED_ARTIFACT_STATE.RESERVED}
    `;
  });
}

/**
 * Idempotently releases one live row.  Physical deletion happens before this call;
 * if deletion fails, keep the row ORPHANED and charged for the cleanup retry.
 */
async function releaseStoredArtifactWithTx(
  tx: Prisma.TransactionClient,
  artifactId: string,
  terminalState: 'DELETED' | 'REPLACED'
): Promise<boolean> {
  const initial = await findArtifactById(tx, artifactId);
  if (!initial) return false;
  if (!(await lockUserStorageRow(tx, initial.userId))) return false;
  const row = await findArtifactById(tx, artifactId, true);
  if (!row) return false;
  if (row.chargedBytes === BigInt(0)) return false;

  await adjustUserStorageBytes(
    tx,
    row.userId,
    -row.chargedBytes,
    row.artifactType,
    false
  );
  await tx.$executeRaw`
    UPDATE StoredArtifact
    SET state = ${terminalState},
        chargedBytes = 0,
        identityKey = NULL,
        expiresAt = NULL,
        deletedAt = NOW(3),
        updatedAt = NOW(3)
    WHERE id = ${row.id}
      AND chargedBytes > 0
  `;
  return true;
}

export async function releaseStoredArtifact(
  artifactId: string,
  terminalState: 'DELETED' | 'REPLACED' = STORED_ARTIFACT_STATE.DELETED
): Promise<boolean> {
  return prisma.$transaction((tx) =>
    releaseStoredArtifactWithTx(tx, artifactId, terminalState)
  );
}

export async function releaseStoredArtifactInTransaction(
  tx: Prisma.TransactionClient,
  artifactId: string,
  terminalState: 'DELETED' | 'REPLACED' = STORED_ARTIFACT_STATE.DELETED
): Promise<boolean> {
  return releaseStoredArtifactWithTx(tx, artifactId, terminalState);
}

export async function rollbackStoredArtifact(artifactId: string): Promise<boolean> {
  return releaseStoredArtifact(artifactId, STORED_ARTIFACT_STATE.DELETED);
}

export async function markStoredArtifactOrphan(
  artifactId: string,
  expiresAt = new Date(Date.now() + STORED_ARTIFACT_RESERVATION_TTL_MS)
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE StoredArtifact
    SET state = ${STORED_ARTIFACT_STATE.ORPHANED},
        identityKey = NULL,
        expiresAt = ${expiresAt},
        updatedAt = NOW(3)
    WHERE id = ${artifactId}
      AND chargedBytes > 0
      AND state IN (
        ${STORED_ARTIFACT_STATE.RESERVED},
        ${STORED_ARTIFACT_STATE.ACTIVE},
        ${STORED_ARTIFACT_STATE.CLEANING}
      )
  `;
}

/**
 * Durable outbox transition used before deleting an owner row. References and
 * charged bytes remain until the physical delete is confirmed, so a crash is
 * retryable and reconciliation cannot lose the object identity.
 */
export async function markStoredArtifactsDeletePendingInTransaction(
  tx: Prisma.TransactionClient,
  artifactIds: ReadonlyArray<string>
): Promise<StoredArtifactRow[]> {
  const ids = Array.from(new Set(artifactIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<StoredArtifactRow[]>(Prisma.sql`
    SELECT * FROM StoredArtifact
    WHERE id IN (${Prisma.join(ids)})
      AND chargedBytes > 0
    FOR UPDATE
  `);
  if (rows.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE StoredArtifact
      SET state = ${STORED_ARTIFACT_STATE.DELETE_PENDING},
          identityKey = NULL,
          expiresAt = NOW(3),
          updatedAt = NOW(3)
      WHERE id IN (${Prisma.join(rows.map((row) => row.id))})
        AND chargedBytes > 0
    `);
  }
  return rows.map((row) => ({
    ...row,
    state: STORED_ARTIFACT_STATE.DELETE_PENDING,
    identityKey: null,
  }));
}

export async function markStoredArtifactsDeletePending(
  artifactIds: ReadonlyArray<string>
): Promise<StoredArtifactRow[]> {
  return prisma.$transaction((tx) =>
    markStoredArtifactsDeletePendingInTransaction(tx, artifactIds)
  );
}

export async function findBillableStoredArtifactsByOwner(
  ownerType: string,
  ownerId: string
): Promise<StoredArtifactRow[]> {
  return prisma.$queryRaw<StoredArtifactRow[]>`
    SELECT * FROM StoredArtifact
    WHERE ownerType = ${ownerType}
      AND ownerId = ${ownerId}
      AND chargedBytes > 0
    ORDER BY createdAt ASC
  `;
}

export async function getStoredArtifactById(
  artifactId: string
): Promise<StoredArtifactRow | null> {
  const rows = await prisma.$queryRaw<StoredArtifactRow[]>`
    SELECT * FROM StoredArtifact WHERE id = ${artifactId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getActiveStoredArtifactByLogicalKey(
  logicalKey: string
): Promise<StoredArtifactRow | null> {
  const rows = await prisma.$queryRaw<StoredArtifactRow[]>`
    SELECT * FROM StoredArtifact
    WHERE identityKey = ${logicalKey}
      AND state = ${STORED_ARTIFACT_STATE.ACTIVE}
      AND chargedBytes > 0
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findBillableStoredArtifactsByOwners(
  ownerType: string,
  ownerIds: ReadonlyArray<string>
): Promise<StoredArtifactRow[]> {
  const ids = Array.from(new Set(ownerIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const rows: StoredArtifactRow[] = [];
  const batchSize = 200;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    rows.push(
      ...(await prisma.$queryRaw<StoredArtifactRow[]>(Prisma.sql`
        SELECT * FROM StoredArtifact
        WHERE ownerType = ${ownerType}
          AND ownerId IN (${Prisma.join(batch)})
          AND chargedBytes > 0
        ORDER BY createdAt ASC
      `))
    );
  }
  return rows;
}

export async function findBillableStoredArtifactsByConversations(
  conversationIds: ReadonlyArray<string>
): Promise<StoredArtifactRow[]> {
  const ids = Array.from(new Set(conversationIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const rows: StoredArtifactRow[] = [];
  const batchSize = 200;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    rows.push(
      ...(await prisma.$queryRaw<StoredArtifactRow[]>(Prisma.sql`
        SELECT * FROM StoredArtifact
        WHERE conversationId IN (${Prisma.join(batch)})
          AND chargedBytes > 0
        ORDER BY createdAt ASC
      `))
    );
  }
  return rows;
}

export async function isStoredArtifactBackfillComplete(): Promise<boolean> {
  const marker = await prisma.siteSetting.findUnique({
    where: { key: STORED_ARTIFACT_BACKFILL_MARKER },
    select: { value: true },
  });
  return marker?.value === STORED_ARTIFACT_BACKFILL_COMPLETE;
}

/** Destructive storage operations must never fall back to a pre-ledger path. */
export async function assertStoredArtifactBackfillComplete(): Promise<void> {
  if (!(await isStoredArtifactBackfillComplete())) {
    throw new StoredArtifactBackfillIncompleteError();
  }
}

/**
 * Proves that each currently visible owner reference has an ACTIVE ledger row.
 * Extra ORPHANED/replacement generations are allowed and remain independently
 * billable until their physical cleanup succeeds.
 */
export function assertStoredArtifactReferencesCovered(
  rows: ReadonlyArray<StoredArtifactRow>,
  references: ReadonlyArray<string | null | undefined>
): void {
  const activeReferences = new Set(
    rows
      .filter(
        (row) =>
          row.state === STORED_ARTIFACT_STATE.ACTIVE &&
          typeof row.reference === 'string' &&
          row.reference.length > 0
      )
      .map((row) => row.reference as string)
  );
  for (const reference of new Set(references.filter(Boolean) as string[])) {
    if (!activeReferences.has(reference)) {
      throw new StoredArtifactCoverageError();
    }
  }
}

/** Readback predicate used after an ambiguous owner-delete COMMIT. */
export async function areStoredArtifactDeleteIntentsDurable(
  artifactIds: ReadonlyArray<string>
): Promise<boolean> {
  const ids = Array.from(new Set(artifactIds.filter(Boolean)));
  if (ids.length === 0) return false;
  const rows = await Promise.all(ids.map((id) => getStoredArtifactById(id)));
  const detachedStates = new Set<string>([
    STORED_ARTIFACT_STATE.DELETE_PENDING,
    STORED_ARTIFACT_STATE.CLEANING,
    STORED_ARTIFACT_STATE.ORPHANED,
    STORED_ARTIFACT_STATE.DELETED,
    STORED_ARTIFACT_STATE.REPLACED,
  ]);
  return rows.every((row) => row !== null && detachedStates.has(row.state));
}
