import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  releaseTranscriptionMinutes,
  reserveTranscriptionMinutes,
  settleFullReservation,
} from '@/lib/quota';

export const FULL_TRANSCRIBE_ACTIVE_STATES = [
  'pending',
  'transcoding',
  'transcribing',
  'finalizing',
] as const;

const ADMISSION_LOCK_KEY = '__internal_full_transcribe_admission_lock__';
const DEFAULT_MAX_ACTIVE_PER_USER = 1;
const DEFAULT_MAX_ACTIVE_GLOBAL = 8;

function positiveLimit(name: string, fallback: number, hardMax: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, hardMax);
}

export function getFullTranscribeConcurrencyLimits(): {
  perUser: number;
  global: number;
} {
  return {
    perUser: positiveLimit(
      'FULL_TRANSCRIBE_MAX_ACTIVE_PER_USER',
      DEFAULT_MAX_ACTIVE_PER_USER,
      16
    ),
    global: positiveLimit(
      'FULL_TRANSCRIBE_MAX_ACTIVE_GLOBAL',
      DEFAULT_MAX_ACTIVE_GLOBAL,
      64
    ),
  };
}

export interface ClaimedFullTranscribeTask {
  outcome: 'claimed';
  claimId: string;
  startedAt: Date;
  session: {
    id: string;
    userId: string;
    recordingPath: string;
  };
}

export type FullTranscribeClaimOutcome =
  | ClaimedFullTranscribeTask
  | {
      outcome:
        | 'notfound'
        | 'forbidden'
        | 'not_finalized'
        | 'no_recording'
        | 'already_running'
        | 'user_busy'
        | 'global_busy';
      status?: string | null;
    };

interface ClaimRow {
  id: string;
  userId: string;
  status: string;
  recordingPath: string | null;
  fullTranscribeStatus: string | null;
  fullReservedMinutes: number | bigint | string | null;
}

/**
 * Atomically claims one full-transcribe resource slot before any recording bytes are read.
 *
 * The SiteSetting sentinel is a persistent cross-process mutex. Every claim writer locks it,
 * then counts active session leases and updates the selected Session in the same transaction.
 * Session active states are therefore the durable user/global leases; the existing stale-task
 * reclaimer releases them after crashes. No in-memory semaphore is trusted as the boundary.
 */
export async function claimFullTranscribeTask(
  sessionId: string,
  userId: string
): Promise<FullTranscribeClaimOutcome> {
  const claimId = crypto.randomUUID();
  const startedAt = new Date();
  const limits = getFullTranscribeConcurrencyLimits();

  return prisma.$transaction(async (tx) => {
    // INSERT IGNORE is idempotent and also serializes the first concurrent creation. The
    // following FOR UPDATE remains the cross-process mutex on all subsequent claims.
    await tx.$executeRaw(
      Prisma.sql`INSERT IGNORE INTO SiteSetting (\`key\`, \`value\`, updatedAt)
                 VALUES (${ADMISSION_LOCK_KEY}, '1', NOW(3))`
    );
    const lockRows = await tx.$queryRaw<Array<{ key: string }>>(
      Prisma.sql`SELECT \`key\` FROM SiteSetting
                 WHERE \`key\` = ${ADMISSION_LOCK_KEY} FOR UPDATE`
    );
    if (lockRows.length !== 1) {
      throw new Error('Full-transcribe admission lock is unavailable');
    }

    const rows = await tx.$queryRaw<ClaimRow[]>(
      Prisma.sql`SELECT id, userId, status, recordingPath,
                        fullTranscribeStatus, fullReservedMinutes
                 FROM Session WHERE id = ${sessionId} FOR UPDATE`
    );
    const row = rows[0];
    if (!row) return { outcome: 'notfound' } as const;
    if (row.userId !== userId) return { outcome: 'forbidden' } as const;
    if (row.status !== 'COMPLETED' && row.status !== 'ARCHIVED') {
      return { outcome: 'not_finalized' } as const;
    }
    if (!row.recordingPath) return { outcome: 'no_recording' } as const;
    if (
      row.fullTranscribeStatus &&
      FULL_TRANSCRIBE_ACTIVE_STATES.includes(
        row.fullTranscribeStatus as (typeof FULL_TRANSCRIBE_ACTIVE_STATES)[number]
      )
    ) {
      return {
        outcome: 'already_running',
        status: row.fullTranscribeStatus,
      } as const;
    }

    const activeWhere = {
      fullTranscribeStatus: { in: [...FULL_TRANSCRIBE_ACTIVE_STATES] },
    };
    const globalActive = await tx.session.count({ where: activeWhere });
    if (globalActive >= limits.global) return { outcome: 'global_busy' } as const;

    const userActive = await tx.session.count({
      where: { userId, ...activeWhere },
    });
    if (userActive >= limits.perUser) return { outcome: 'user_busy' } as const;

    const priorReservedMinutes = Number(row.fullReservedMinutes ?? 0);
    await tx.session.update({
      where: { id: sessionId },
      data: {
        fullTranscribeStatus: 'pending',
        fullTranscribeError: null,
        fullTranscribeStartedAt: startedAt,
        fullTranscribeClaimId: claimId,
        // A prior terminal attempt may have left a reservation for the maintenance reaper.
        // This claim replaces it under the same Session lock and releases it exactly once.
        fullReservedMinutes: 0,
      },
    });
    if (Number.isFinite(priorReservedMinutes) && priorReservedMinutes > 0) {
      await releaseTranscriptionMinutes(userId, priorReservedMinutes, tx);
    }

    return {
      outcome: 'claimed',
      claimId,
      startedAt,
      session: {
        id: row.id,
        userId: row.userId,
        recordingPath: row.recordingPath,
      },
    } as const;
  });
}

export type FullTranscribeReservationOutcome =
  | { outcome: 'reserved' }
  | { outcome: 'insufficient_quota' }
  | { outcome: 'claim_lost' };

/**
 * Registers the measured-duration quota reservation on the still-owned claim. The User debit
 * and Session reservation row update share one transaction, closing the historical accounting
 * window where a crash could debit the user without recording which task owned the debit.
 */
export async function registerFullTranscribeReservation(options: {
  sessionId: string;
  userId: string;
  claimId: string;
  durationMs: number;
  estimatedMinutes: number;
}): Promise<FullTranscribeReservationOutcome> {
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0) {
    throw new Error('Invalid full-transcribe duration');
  }
  if (!Number.isSafeInteger(options.estimatedMinutes) || options.estimatedMinutes < 0) {
    throw new Error('Invalid full-transcribe reservation');
  }
  const durationMs = options.durationMs;
  const estimatedMinutes = options.estimatedMinutes;

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        userId: string;
        fullTranscribeStatus: string | null;
        fullTranscribeClaimId: string | null;
      }>
    >(
      Prisma.sql`SELECT userId, fullTranscribeStatus, fullTranscribeClaimId
                 FROM Session WHERE id = ${options.sessionId} FOR UPDATE`
    );
    const row = rows[0];
    if (
      !row ||
      row.userId !== options.userId ||
      row.fullTranscribeStatus !== 'pending' ||
      row.fullTranscribeClaimId !== options.claimId
    ) {
      return { outcome: 'claim_lost' } as const;
    }

    const reserved =
      estimatedMinutes === 0
        ? true
        : await reserveTranscriptionMinutes(options.userId, estimatedMinutes, tx);

    if (!reserved) {
      await tx.session.update({
        where: { id: options.sessionId },
        data: {
          durationMs,
          fullTranscribeStatus: 'failed',
          fullTranscribeError: 'Insufficient transcription quota',
          fullReservedMinutes: 0,
        },
      });
      return { outcome: 'insufficient_quota' } as const;
    }

    await tx.session.update({
      where: { id: options.sessionId },
      data: {
        durationMs,
        fullReservedMinutes: estimatedMinutes,
      },
    });
    return { outcome: 'reserved' } as const;
  });
}

export type FullTranscribeActiveState =
  (typeof FULL_TRANSCRIBE_ACTIVE_STATES)[number];

/**
 * Atomically marks the still-owned attempt failed and releases its reservation.
 *
 * Keeping both actions under the Session row lock is essential: if failure were committed first
 * and settleFullReservation ran in a later transaction, a retrigger could install a new claim and
 * reservation in between, and the old worker would release the new attempt's quota.
 */
export async function failFullTranscribeAttempt(options: {
  sessionId: string;
  claimId: string | null;
  allowedStatuses: readonly FullTranscribeActiveState[];
  error: string;
  durationMs?: number;
  startedAtLte?: Date;
}): Promise<boolean> {
  if (options.allowedStatuses.length === 0) return false;
  const durationMs = options.durationMs;
  const shouldPersistDuration =
    typeof durationMs === 'number' &&
    Number.isSafeInteger(durationMs) &&
    durationMs > 0;

  return prisma.$transaction(async (tx) => {
    const failed = await tx.session.updateMany({
      where: {
        id: options.sessionId,
        fullTranscribeClaimId: options.claimId,
        fullTranscribeStatus: { in: [...options.allowedStatuses] },
        ...(options.startedAtLte
          ? { fullTranscribeStartedAt: { lte: options.startedAtLte } }
          : {}),
      },
      data: {
        fullTranscribeStatus: 'failed',
        fullTranscribeError: options.error.slice(0, 500),
        ...(shouldPersistDuration
          ? { durationMs: Math.trunc(durationMs) }
          : {}),
      },
    });
    if (failed.count !== 1) return false;

    await settleFullReservation(options.sessionId, tx);
    return true;
  });
}

/**
 * Release a stale terminal attempt's orphan reservation only if the same claim is still terminal
 * after taking the Session lock. This prevents a sweep selected from an old snapshot from settling
 * a reservation installed by a newer retrigger.
 */
export async function releaseTerminalFullTranscribeReservation(options: {
  sessionId: string;
  claimId: string | null;
  updatedAtLte: Date;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        fullTranscribeClaimId: string | null;
        fullTranscribeStatus: string | null;
        updatedAt: Date;
      }>
    >(
      Prisma.sql`SELECT fullTranscribeClaimId, fullTranscribeStatus, updatedAt
                 FROM Session WHERE id = ${options.sessionId} FOR UPDATE`
    );
    const row = rows[0];
    if (
      !row ||
      row.fullTranscribeClaimId !== options.claimId ||
      (row.fullTranscribeStatus !== 'failed' &&
        row.fullTranscribeStatus !== 'completed') ||
      new Date(row.updatedAt).getTime() > options.updatedAtLte.getTime()
    ) {
      return 0;
    }
    return settleFullReservation(options.sessionId, tx);
  });
}

/** Mark a pre-processing claim failed without touching a newer attempt. */
export async function failFullTranscribeClaim(options: {
  sessionId: string;
  claimId: string;
  error: string;
  durationMs?: number;
}): Promise<boolean> {
  return failFullTranscribeAttempt({
    ...options,
    allowedStatuses: ['pending'],
  });
}
