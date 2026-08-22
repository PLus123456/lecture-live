import 'server-only';

import { Prisma } from '@prisma/client';
import {
  STORED_ARTIFACT_BACKFILL_COMPLETE,
  STORED_ARTIFACT_BACKFILL_MARKER,
  STORED_ARTIFACT_TYPE,
} from '@/lib/storage/storedArtifactLedger';

export const CONVERSATION_RECORDING_LIMITS = {
  maxRecordings: 16,
  maxDurationMs: 24 * 60 * 60 * 1000,
  maxArtifactBytes: BigInt(10) * BigInt(1024) * BigInt(1024) * BigInt(1024),
  maxInjectableTextBytes:
    BigInt(64) * BigInt(1024) * BigInt(1024),
  maxIdBytes: 191,
  maxIdArrayUtf8Bytes: 4 * 1024,
  maxJsonBodyBytes: 8 * 1024,
  dbBatchSize: 8,
} as const;

const INJECTABLE_TEXT_TYPES = [
  STORED_ARTIFACT_TYPE.TRANSCRIPT,
  STORED_ARTIFACT_TYPE.SUMMARY,
  STORED_ARTIFACT_TYPE.REPORT,
  STORED_ARTIFACT_TYPE.FULL_TRANSCRIPT,
  STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT,
] as const;

type RecordingPolicyDatabase = Pick<
  Prisma.TransactionClient,
  'session' | '$queryRaw'
>;

export type ConversationRecordingLimitCode =
  | 'BACKFILL_PENDING'
  | 'COUNT'
  | 'DURATION'
  | 'ARTIFACT_BYTES'
  | 'TEXT_BYTES'
  | 'NOT_OWNED';

export class ConversationRecordingLimitError extends Error {
  constructor(
    public readonly code: ConversationRecordingLimitCode,
    message: string,
    public readonly status: 400 | 403 | 413 | 503
  ) {
    super(message);
    this.name = 'ConversationRecordingLimitError';
  }
}

export class ConversationRecordingBodyError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413
  ) {
    super(message);
    this.name = 'ConversationRecordingBodyError';
  }
}

export interface ConversationRecordingUsage {
  recordingIds: string[];
  durationMs: number;
  artifactBytes: bigint;
  injectableTextBytes: bigint;
}

function chunk<T>(values: ReadonlyArray<T>, size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

export function normalizeConversationRecordingIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ConversationRecordingBodyError(
      'recording IDs must be an array',
      400
    );
  }
  // 先限制 raw 项数，不能让大量重复项靠去重逃过请求侧 SQL/内存边界。
  if (raw.length > CONVERSATION_RECORDING_LIMITS.maxRecordings) {
    throw new ConversationRecordingBodyError(
      `at most ${CONVERSATION_RECORDING_LIMITS.maxRecordings} recording IDs are allowed`,
      413
    );
  }

  let totalBytes = 0;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw new ConversationRecordingBodyError(
        'recording IDs must be non-empty strings',
        400
      );
    }
    const id = value.trim();
    const bytes = Buffer.byteLength(id, 'utf8');
    totalBytes += bytes;
    if (
      bytes === 0 ||
      bytes > CONVERSATION_RECORDING_LIMITS.maxIdBytes ||
      totalBytes > CONVERSATION_RECORDING_LIMITS.maxIdArrayUtf8Bytes
    ) {
      throw new ConversationRecordingBodyError(
        'recording ID list exceeds the allowed byte limit',
        413
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Read a small JSON request without trusting Content-Length or buffering an unbounded body. */
export async function readConversationRecordingJson(
  req: Request
): Promise<Record<string, unknown>> {
  const limit = CONVERSATION_RECORDING_LIMITS.maxJsonBodyBytes;
  const declared = req.headers.get('content-length')?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw new ConversationRecordingBodyError(
      `request body exceeds ${limit} bytes`,
      413
    );
  }

  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ConversationRecordingBodyError(
          `request body exceeds ${limit} bytes`,
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((part) => Buffer.from(part)));
  if (bytes.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ConversationRecordingBodyError('Invalid JSON', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConversationRecordingBodyError('JSON body must be an object', 400);
  }
  return parsed as Record<string, unknown>;
}

async function assertBackfillComplete(db: RecordingPolicyDatabase): Promise<void> {
  const rows = await db.$queryRaw<Array<{ value: string }>>(Prisma.sql`
    SELECT value FROM SiteSetting
    WHERE \`key\` = ${STORED_ARTIFACT_BACKFILL_MARKER}
    LIMIT 1
  `);
  if (rows[0]?.value !== STORED_ARTIFACT_BACKFILL_COMPLETE) {
    throw new ConversationRecordingLimitError(
      'BACKFILL_PENDING',
      'stored artifact inventory is still being prepared; retry later',
      503
    );
  }
}

/**
 * Loads and validates a bounded recording set. All IDs are queried in small batches,
 * and artifact bytes come only from the completed unified ledger.
 */
export async function loadConversationRecordingUsage(
  db: RecordingPolicyDatabase,
  userId: string,
  inputIds: ReadonlyArray<string>
): Promise<ConversationRecordingUsage> {
  const ids = normalizeConversationRecordingIds([...inputIds]);
  if (ids.length === 0) {
    return {
      recordingIds: [],
      durationMs: 0,
      artifactBytes: BigInt(0),
      injectableTextBytes: BigInt(0),
    };
  }
  await assertBackfillComplete(db);

  const sessions: Array<{ id: string; durationMs: number }> = [];
  for (const batch of chunk(ids, CONVERSATION_RECORDING_LIMITS.dbBatchSize)) {
    sessions.push(
      ...(await db.session.findMany({
        where: { id: { in: batch }, userId },
        select: { id: true, durationMs: true },
      }))
    );
  }
  if (sessions.length !== ids.length) {
    throw new ConversationRecordingLimitError(
      'NOT_OWNED',
      'one or more recording IDs are not owned by the current user',
      403
    );
  }

  let artifactBytes = BigInt(0);
  let injectableTextBytes = BigInt(0);
  for (const batch of chunk(ids, CONVERSATION_RECORDING_LIMITS.dbBatchSize)) {
    const rows = await db.$queryRaw<
      Array<{ artifactType: string; chargedBytes: bigint }>
    >(Prisma.sql`
      SELECT artifactType, chargedBytes
      FROM StoredArtifact
      WHERE sessionId IN (${Prisma.join(batch)})
        AND chargedBytes > 0
    `);
    for (const row of rows) {
      artifactBytes += row.chargedBytes;
      if ((INJECTABLE_TEXT_TYPES as readonly string[]).includes(row.artifactType)) {
        injectableTextBytes += row.chargedBytes;
      }
    }
  }

  const durationMs = sessions.reduce(
    (total, session) => total + Math.max(0, session.durationMs),
    0
  );
  if (ids.length > CONVERSATION_RECORDING_LIMITS.maxRecordings) {
    throw new ConversationRecordingLimitError(
      'COUNT',
      'too many recordings are attached to this conversation',
      413
    );
  }
  if (durationMs > CONVERSATION_RECORDING_LIMITS.maxDurationMs) {
    throw new ConversationRecordingLimitError(
      'DURATION',
      'attached recordings exceed the 24 hour duration limit',
      413
    );
  }
  if (artifactBytes > CONVERSATION_RECORDING_LIMITS.maxArtifactBytes) {
    throw new ConversationRecordingLimitError(
      'ARTIFACT_BYTES',
      'attached recordings exceed the 10 GiB artifact limit',
      413
    );
  }
  if (
    injectableTextBytes >
    CONVERSATION_RECORDING_LIMITS.maxInjectableTextBytes
  ) {
    throw new ConversationRecordingLimitError(
      'TEXT_BYTES',
      'attached recordings exceed the 64 MiB injectable text limit',
      413
    );
  }

  return { recordingIds: ids, durationMs, artifactBytes, injectableTextBytes };
}

export function conversationRecordingErrorBody(
  error: ConversationRecordingLimitError | ConversationRecordingBodyError
): Record<string, unknown> {
  return {
    error: error.message,
    ...(error instanceof ConversationRecordingLimitError
      ? { code: error.code }
      : {}),
    limits: {
      recordings: CONVERSATION_RECORDING_LIMITS.maxRecordings,
      durationMs: CONVERSATION_RECORDING_LIMITS.maxDurationMs,
      artifactBytes:
        CONVERSATION_RECORDING_LIMITS.maxArtifactBytes.toString(),
      injectableTextBytes:
        CONVERSATION_RECORDING_LIMITS.maxInjectableTextBytes.toString(),
    },
  };
}
