/**
 * Chat 附件批量清理：把 admin 前端的 "用户 / 种类 / 年龄 / 大小阈值" 过滤
 * 翻译成可以安全交给 Prisma deleteMany 的 where 子句。沿用 adminCleanup.ts
 * 的 "ok+normalized" 风格，被 GET preview / POST cleanup 共用。
 *
 * 同时承载 `performCleanup` —— DELETE / POST 两个 handler 共用的核心逻辑，
 * 避免在 route 文件之间 import 副作用。
 */

import 'server-only';

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
// 共用 adminCleanup.ts 的 cutoff 函数，避免重复实现。
import { olderThanDaysToCutoff } from '@/lib/adminCleanup';
// U6：删行前先 best-effort 删 Cloudreve 物理文件（与 conversationCascade.ts 一致），
// 否则行一删 cloudrevePath 即永久丢失，Cloudreve 上原文件 + .extracted.txt 成不可回收孤儿。
import { deleteCloudreveAttachmentFiles } from '@/lib/storage/cloudreveFileDelete';
import {
  findBillableStoredArtifactsByOwners,
  markStoredArtifactsDeletePendingInTransaction,
  releaseStoredArtifactInTransaction,
} from '@/lib/storage/storedArtifactLedger';

export { olderThanDaysToCutoff };

export const CHAT_FILE_CLEANUP_DAYS_MIN = 1;
export const CHAT_FILE_CLEANUP_DAYS_MAX = 365;

export type ChatFileKind = 'image' | 'document' | 'text';

/** 与 ChatAttachment.kind 字段一致；新增 kind 时同步扩展。 */
const KNOWN_KINDS: ReadonlySet<string> = new Set(['image', 'document', 'text']);

export interface ChatFileCleanupParams {
  /** 必填 (1..365)。0 / 负数 / 非整数都视为 invalid。 */
  olderThanDays?: number;
  /** 可选：仅删除字节数大于此阈值的附件（用于"先扫大件"场景）。 */
  sizeBytesGT?: number;
  /** 可选：仅删此用户的附件。 */
  userId?: string;
  /** 可选：仅删指定种类。空数组等同于"不过滤"。 */
  kinds?: string[];
  /** 可选：仅删指定 conversation 下的附件。 */
  conversationId?: string;
}

export interface ChatFileCleanupValidation {
  ok: boolean;
  error?: string;
  olderThanDays: number;
  sizeBytesGT: number;
  userId?: string;
  kinds: ChatFileKind[];
  conversationId?: string;
}

/**
 * 把入参校验为可安全传给 prisma 的字段。失败返回带 error 的对象，让 handler
 * 直接返回 400。所有未识别字段都会被拒绝（白名单优于黑名单）。
 */
export function validateChatFileCleanupParams(
  raw: ChatFileCleanupParams
): ChatFileCleanupValidation {
  const days = Number(raw.olderThanDays);
  if (
    !Number.isInteger(days) ||
    days < CHAT_FILE_CLEANUP_DAYS_MIN ||
    days > CHAT_FILE_CLEANUP_DAYS_MAX
  ) {
    return {
      ok: false,
      error: `olderThanDays 必须为 ${CHAT_FILE_CLEANUP_DAYS_MIN}–${CHAT_FILE_CLEANUP_DAYS_MAX} 之间的整数`,
      olderThanDays: 0,
      sizeBytesGT: 0,
      kinds: [],
    };
  }

  // sizeBytesGT 可省略，默认 0 即不过滤。负数 clamp 到 0。
  const sizeRaw = Number(raw.sizeBytesGT);
  const sizeBytesGT = Number.isFinite(sizeRaw) ? Math.max(0, Math.floor(sizeRaw)) : 0;

  const kindsArr: ChatFileKind[] = [];
  if (Array.isArray(raw.kinds)) {
    const seen = new Set<string>();
    for (const k of raw.kinds) {
      if (typeof k !== 'string' || !KNOWN_KINDS.has(k)) {
        return {
          ok: false,
          error: `未知附件种类：${String(k)}`,
          olderThanDays: 0,
          sizeBytesGT: 0,
          kinds: [],
        };
      }
      if (!seen.has(k)) {
        seen.add(k);
        kindsArr.push(k as ChatFileKind);
      }
    }
  }

  const userId =
    typeof raw.userId === 'string' && raw.userId ? raw.userId : undefined;
  const conversationId =
    typeof raw.conversationId === 'string' && raw.conversationId
      ? raw.conversationId
      : undefined;

  return {
    ok: true,
    olderThanDays: days,
    sizeBytesGT,
    userId,
    kinds: kindsArr,
    conversationId,
  };
}

/**
 * 释放某个用户的 storageBytesUsed —— raw SQL clamp 到 0，幂等。被批量清理
 * 与单条 DELETE 共用。
 *
 * TODO U2 合并后改用 releaseStorageBytes(userId, bytes) 替代 raw SQL。
 */
export async function releaseUserStorageBytesRaw(
  tx: Prisma.TransactionClient,
  userId: string,
  bytes: bigint | number
): Promise<void> {
  const value = typeof bytes === 'bigint' ? bytes.toString() : String(bytes);
  await tx.$executeRawUnsafe(
    'UPDATE User SET storageBytesUsed = GREATEST(0, CAST(storageBytesUsed AS SIGNED) - ?) WHERE id = ?',
    value,
    userId
  );
}

interface ChatFileDeleteCandidate {
  id: string;
  userId: string;
  bytes: bigint;
  cloudrevePath: string;
  extractedTextPath: string | null;
}

export interface ChatFileDatabaseMutationSummary {
  candidateCount: number;
  deleted: number;
  releasedBytes: number;
  queuedArtifactCount: number;
  deletedIds: string[];
  ownerIds: string[];
}

export interface ChatFileCleanupOptions {
  /** Runs after delete/quota mutation and before commit. Throwing rolls the mutation back. */
  onDatabaseMutation?: (
    tx: Prisma.TransactionClient,
    summary: ChatFileDatabaseMutationSummary
  ) => Promise<void>;
  /**
   * Runs in the same transaction that releases ledger-backed quota after the remote delete.
   * Throwing leaves the durable DELETE_PENDING rows charged and retryable.
   */
  onArtifactReleaseMutation?: (
    tx: Prisma.TransactionClient,
    summary: ChatFileArtifactReleaseSummary
  ) => Promise<void>;
}

export interface ChatFileArtifactReleaseSummary {
  artifactCount: number;
  releasedArtifactCount: number;
  releasedBytes: number;
}

export interface ChatFileCleanupResult {
  deleted: number;
  releasedBytes: number;
  truncated: boolean;
  /** False means durable StoredArtifact DELETE_PENDING rows or owner rows remain retryable. */
  physicalDeleteComplete: boolean;
  pendingArtifactCount: number;
}

async function deleteChatFileCandidates(
  toDelete: ChatFileDeleteCandidate[],
  truncated: boolean,
  options?: ChatFileCleanupOptions
): Promise<ChatFileCleanupResult> {
  if (toDelete.length === 0 && !options?.onDatabaseMutation) {
    return {
      deleted: 0,
      releasedBytes: 0,
      truncated,
      physicalDeleteComplete: true,
      pendingArtifactCount: 0,
    };
  }
  const ZERO = BigInt(0);
  const ids = toDelete.map((row) => row.id);
  const ledgerRows = await findBillableStoredArtifactsByOwners(
    'chat_attachment',
    ids
  );
  const ledgerOwnerIds = new Set(ledgerRows.map((row) => row.ownerId));

  // Legacy rows have no durable artifact reference after their owner is deleted. Delete their
  // physical objects first and only remove DB rows when the whole legacy batch is confirmed. A
  // crash leaves the owner rows intact; replay treats remote 404 as success. Ledger-backed rows
  // instead transition to DELETE_PENDING in the same transaction as owner deletion.
  const legacyRows = toDelete.filter((row) => !ledgerOwnerIds.has(row.id));
  const legacyPhysicalComplete =
    legacyRows.length === 0 ||
    (await deleteCloudreveAttachmentFiles(legacyRows));
  const eligibleIds = new Set([
    ...toDelete
      .filter((row) => ledgerOwnerIds.has(row.id))
      .map((row) => row.id),
    ...(legacyPhysicalComplete ? legacyRows.map((row) => row.id) : []),
  ]);

  let totalReleased = ZERO;
  let deletedIds: string[] = [];
  let queuedArtifactCount = 0;
  await prisma.$transaction(async (tx) => {
    const lockedRows =
      eligibleIds.size === 0
        ? []
        : await tx.$queryRaw<
            Array<{ id: string; userId: string; bytes: bigint }>
          >(Prisma.sql`
            SELECT id, userId, bytes FROM ChatAttachment
            WHERE id IN (${Prisma.join([...eligibleIds])})
            FOR UPDATE
          `);

    const releaseByUser = new Map<string, bigint>();
    for (const row of lockedRows) {
      // Ledger rows retain chargedBytes until their physical delete is confirmed.
      if (ledgerOwnerIds.has(row.id)) continue;
      releaseByUser.set(
        row.userId,
        (releaseByUser.get(row.userId) ?? ZERO) + row.bytes
      );
    }
    for (const [userId, bytes] of releaseByUser) {
      await releaseUserStorageBytesRaw(tx, userId, bytes);
      totalReleased += bytes;
    }

    deletedIds = lockedRows.map((row) => row.id);
    const deletedIdSet = new Set(deletedIds);
    if (deletedIds.length > 0) {
      const pendingArtifactIds = ledgerRows
        .filter((row) => deletedIdSet.has(row.ownerId))
        .map((row) => row.id);
      const pending =
        pendingArtifactIds.length > 0
          ? await markStoredArtifactsDeletePendingInTransaction(
              tx,
              pendingArtifactIds
            )
          : [];
      queuedArtifactCount = pending.length;
      await tx.chatAttachment.deleteMany({
        where: { id: { in: deletedIds } },
      });
    }

    await options?.onDatabaseMutation?.(tx, {
      candidateCount: toDelete.length,
      deleted: deletedIds.length,
      releasedBytes: Number(totalReleased),
      queuedArtifactCount,
      deletedIds,
      ownerIds: [...new Set(lockedRows.map((row) => row.userId))],
    });
  });

  const deletedIdSet = new Set(deletedIds);
  const ledgerDeletedRows = toDelete.filter(
    (row) => deletedIdSet.has(row.id) && ledgerOwnerIds.has(row.id)
  );
  const ledgerPhysicalComplete =
    ledgerDeletedRows.length === 0 ||
    (await deleteCloudreveAttachmentFiles(ledgerDeletedRows));
  let ledgerReleaseComplete = true;
  let releasedArtifactCount = 0;
  const artifactsToRelease = ledgerRows.filter((artifact) =>
    deletedIdSet.has(artifact.ownerId)
  );
  if (ledgerPhysicalComplete && artifactsToRelease.length > 0) {
    let releasedLedgerBytes = ZERO;
    await prisma.$transaction(async (tx) => {
      for (const artifact of artifactsToRelease) {
        const released = await releaseStoredArtifactInTransaction(tx, artifact.id);
        if (released) {
          releasedArtifactCount += 1;
          releasedLedgerBytes += artifact.chargedBytes;
        } else {
          ledgerReleaseComplete = false;
        }
      }
      await options?.onArtifactReleaseMutation?.(tx, {
        artifactCount: artifactsToRelease.length,
        releasedArtifactCount,
        releasedBytes: Number(releasedLedgerBytes),
      });
    });
    totalReleased += releasedLedgerBytes;
  }

  return {
    deleted: deletedIds.length,
    releasedBytes: Number(totalReleased),
    truncated,
    physicalDeleteComplete:
      legacyPhysicalComplete &&
      ledgerPhysicalComplete &&
      ledgerReleaseComplete,
    pendingArtifactCount: Math.max(
      0,
      queuedArtifactCount - releasedArtifactCount
    ),
  };
}

/**
 * DELETE / POST 共用的核心清理逻辑。Ledger-backed paths are persisted as
 * DELETE_PENDING before the owner row is removed; legacy paths remain on the owner row until the
 * remote delete succeeds. The optional callback is the transaction boundary for required audit.
 */
export async function performChatFileCleanup(input: {
  olderThanDays: number;
  sizeBytesGT: number;
  userId?: string;
  kinds: ChatFileKind[];
  conversationId?: string;
}, options?: ChatFileCleanupOptions): Promise<ChatFileCleanupResult> {
  const HARD_LIMIT = 5000;
  const cutoff = olderThanDaysToCutoff(input.olderThanDays);

  const where: Prisma.ChatAttachmentWhereInput = {
    createdAt: { lt: cutoff },
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.kinds.length > 0 ? { kind: { in: input.kinds } } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.sizeBytesGT > 0 ? { bytes: { gt: BigInt(input.sizeBytesGT) } } : {}),
    ...({ source: 'UPLOAD' } as unknown as Prisma.ChatAttachmentWhereInput),
  };

  const toDelete = await prisma.chatAttachment.findMany({
    where,
    // U6：多取 cloudrevePath/extractedTextPath，供删行前删物理文件用。
    select: {
      id: true,
      userId: true,
      bytes: true,
      cloudrevePath: true,
      extractedTextPath: true,
    },
    take: HARD_LIMIT,
    orderBy: [{ createdAt: 'asc' }],
  });

  return deleteChatFileCandidates(
    toDelete,
    toDelete.length === HARD_LIMIT,
    options
  );
}

export async function performChatFileDelete(
  id: string,
  options?: ChatFileCleanupOptions
): Promise<ChatFileCleanupResult & { found: boolean; ownerId: string | null }> {
  const row = await prisma.chatAttachment.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      bytes: true,
      cloudrevePath: true,
      extractedTextPath: true,
    },
  });
  if (!row) {
    await prisma.$transaction(async (tx) => {
      await options?.onDatabaseMutation?.(tx, {
        candidateCount: 0,
        deleted: 0,
        releasedBytes: 0,
        queuedArtifactCount: 0,
        deletedIds: [],
        ownerIds: [],
      });
    });
    return {
      found: false,
      ownerId: null,
      deleted: 0,
      releasedBytes: 0,
      truncated: false,
      physicalDeleteComplete: true,
      pendingArtifactCount: 0,
    };
  }
  return {
    found: true,
    ownerId: row.userId,
    ...(await deleteChatFileCandidates([row], false, options)),
  };
}
