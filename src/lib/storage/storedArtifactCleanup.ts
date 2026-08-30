import 'server-only';

import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';
import {
  loadCloudreveContext,
  deleteCloudreveFile,
} from '@/lib/storage/cloudreveFileDelete';
import {
  STORED_ARTIFACT_STATE,
  type StoredArtifactRow,
  markStoredArtifactOrphan,
  releaseStoredArtifact,
} from '@/lib/storage/storedArtifactLedger';
import { logger, serializeError } from '@/lib/logger';

const cleanupLogger = logger.child({ component: 'stored-artifact-cleanup' });
const DATA_ROOT = path.resolve(process.cwd(), 'data');
const DEFAULT_CLEANUP_LIMIT = 500;
const CLEANUP_CLAIM_MS = 5 * 60_000;

function resolveSafeLocalReference(reference: string): string | null {
  if (!reference.startsWith('local:')) return null;
  const relative = reference.slice('local:'.length);
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) return null;
  const resolved = path.resolve(DATA_ROOT, relative);
  if (resolved !== DATA_ROOT && !resolved.startsWith(`${DATA_ROOT}${path.sep}`)) {
    return null;
  }
  return resolved;
}

async function deletePhysicalArtifact(
  row: StoredArtifactRow,
  cloudreve: Awaited<ReturnType<typeof loadCloudreveContext>>
): Promise<boolean> {
  if (!row.reference) return true;
  if (row.storage === 'local' || row.reference.startsWith('local:')) {
    const localPath = resolveSafeLocalReference(row.reference);
    if (!localPath) return false;
    try {
      await fs.rm(localPath, { force: true });
      // 内联图的上级 conversation 目录可能因本次变空，best-effort 收掉。
      await fs.rmdir(path.dirname(localPath)).catch(() => undefined);
      return true;
    } catch (error) {
      cleanupLogger.warn(
        { artifactId: row.id, err: serializeError(error) },
        'failed to delete local orphan artifact'
      );
      return false;
    }
  }
  if (row.storage === 'cloudreve' || row.reference.startsWith('/')) {
    if (!cloudreve) return false;
    return deleteCloudreveFile(row.reference, cloudreve);
  }
  return false;
}

/**
 * Reclaims only expired RESERVED/ORPHANED rows. ACTIVE referenced artifacts never
 * receive a TTL, so message/session history cannot be aged out by this job.
 */
export async function cleanupExpiredStoredArtifacts(options?: {
  now?: Date;
  limit?: number;
}): Promise<{ scanned: number; deleted: number; failed: number }> {
  const now = options?.now ?? new Date();
  const limit = Math.max(
    1,
    Math.min(DEFAULT_CLEANUP_LIMIT, options?.limit ?? DEFAULT_CLEANUP_LIMIT)
  );
  const rows = await prisma.$queryRaw<StoredArtifactRow[]>`
    SELECT * FROM StoredArtifact
    WHERE state IN (
      ${STORED_ARTIFACT_STATE.RESERVED},
      ${STORED_ARTIFACT_STATE.ORPHANED},
      ${STORED_ARTIFACT_STATE.CLEANING},
      ${STORED_ARTIFACT_STATE.DELETE_PENDING}
    )
      AND expiresAt IS NOT NULL
      AND expiresAt <= ${now}
      AND chargedBytes > 0
    ORDER BY expiresAt ASC
    LIMIT ${limit}
  `;
  if (rows.length === 0) return { scanned: 0, deleted: 0, failed: 0 };

  const cloudreve = await loadCloudreveContext();
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    // Claim before touching the physical object. A publisher that wins first
    // changes RESERVED→ACTIVE and makes this CAS fail; a cleanup that wins first
    // makes settle reject CLEANING. The lease also recovers process crashes.
    const claimExpiresAt = new Date(now.getTime() + CLEANUP_CLAIM_MS);
    const claimed = await prisma.$executeRaw`
      UPDATE StoredArtifact
      SET state = ${STORED_ARTIFACT_STATE.CLEANING},
          expiresAt = ${claimExpiresAt},
          updatedAt = NOW(3)
      WHERE id = ${row.id}
        AND state IN (
          ${STORED_ARTIFACT_STATE.RESERVED},
          ${STORED_ARTIFACT_STATE.ORPHANED},
          ${STORED_ARTIFACT_STATE.CLEANING},
          ${STORED_ARTIFACT_STATE.DELETE_PENDING}
        )
        AND expiresAt IS NOT NULL
        AND expiresAt <= ${now}
        AND chargedBytes > 0
    `;
    if (claimed !== 1) continue;

    const removed = await deletePhysicalArtifact(row, cloudreve);
    if (!removed) {
      failed += 1;
      await markStoredArtifactOrphan(row.id).catch(() => undefined);
      continue;
    }

    try {
      if (row.ownerType === 'chat_attachment') {
        // 仅删仍指向该过期账本行的未发布 INLINE 附件；
        // 已成功发布的附件 expiresAt 为 NULL，不可被这里误删。
        await prisma.$executeRaw`
          DELETE FROM ChatAttachment
          WHERE id = ${row.ownerId}
            AND storedArtifactId = ${row.id}
            AND expiresAt IS NOT NULL
            AND expiresAt <= ${now}
        `;
      }
      await releaseStoredArtifact(row.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      cleanupLogger.warn(
        { artifactId: row.id, err: serializeError(error) },
        'failed to finalize orphan artifact cleanup'
      );
      await markStoredArtifactOrphan(row.id).catch(() => undefined);
    }
  }

  return { scanned: rows.length, deleted, failed };
}
