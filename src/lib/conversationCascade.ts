import 'server-only';

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { deleteCloudreveAttachmentFiles } from '@/lib/storage/cloudreveFileDelete';
import { deleteConversationImages } from '@/lib/llm/chatImageStorage';
// P5-13：配额释放改走 chatFileCleanup 的 raw-in-tx 写法（见下方步骤 4 注释）。
import { releaseUserStorageBytesRaw } from '@/lib/chatFileCleanup';
import {
  STORED_ARTIFACT_TYPE,
  findBillableStoredArtifactsByConversations,
  markStoredArtifactsDeletePendingInTransaction,
  releaseStoredArtifact,
  type StoredArtifactRow,
} from '@/lib/storage/storedArtifactLedger';

interface ConversationCascadeAttachment {
  id: string;
  conversationId: string;
  userId: string;
  bytes: bigint;
  cloudrevePath: string;
  extractedTextPath: string | null;
}

/**
 * Immutable deletion plan. Keeping the physical references outside the owner
 * rows lets a caller include conversation deletion in a larger transaction
 * (for example deleting a Session and all of its legacy conversations) and
 * only touch storage after that transaction commits.
 */
export interface PreparedConversationCascade {
  ids: string[];
  attachments: ConversationCascadeAttachment[];
  ledgerRows: StoredArtifactRow[];
}

export async function prepareConversationsCascade(
  conversationIds: ReadonlyArray<string>
): Promise<PreparedConversationCascade> {
  const ids = Array.from(new Set(conversationIds.filter(Boolean)));
  if (ids.length === 0) return { ids: [], attachments: [], ledgerRows: [] };

  const [attachments, ledgerRows] = await Promise.all([
    prisma.chatAttachment.findMany({
      where: { conversationId: { in: ids } },
      select: {
        id: true,
        conversationId: true,
        userId: true,
        bytes: true,
        cloudrevePath: true,
        extractedTextPath: true,
      },
    }),
    findBillableStoredArtifactsByConversations(ids),
  ]);
  return { ids, attachments, ledgerRows };
}

/** Owner rows and their durable DELETE_PENDING intents mutate together. */
export async function deletePreparedConversationsInTransaction(
  tx: Prisma.TransactionClient,
  prepared: PreparedConversationCascade
): Promise<number> {
  if (prepared.ids.length === 0) return 0;
  const ledgerOwnerIds = new Set(prepared.ledgerRows.map((row) => row.ownerId));
  const lockedRows = await tx.$queryRaw<
    Array<{ id: string; userId: string; bytes: bigint }>
  >(Prisma.sql`
    SELECT id, userId, bytes FROM ChatAttachment
    WHERE conversationId IN (${Prisma.join(prepared.ids)})
    FOR UPDATE
  `);

  const bytesByOwner = new Map<string, bigint>();
  for (const row of lockedRows) {
    // Ledger-backed rows remain charged while DELETE_PENDING. Legacy rows use
    // the old counter path, but their owner row is still removed atomically.
    if (ledgerOwnerIds.has(row.id)) continue;
    bytesByOwner.set(
      row.userId,
      (bytesByOwner.get(row.userId) ?? BigInt(0)) + row.bytes
    );
  }
  for (const [ownerId, bytes] of bytesByOwner) {
    if (bytes > BigInt(0)) {
      await releaseUserStorageBytesRaw(tx, ownerId, bytes);
    }
  }

  await markStoredArtifactsDeletePendingInTransaction(
    tx,
    prepared.ledgerRows.map((row) => row.id)
  );
  await tx.chatAttachment.deleteMany({
    where: { conversationId: { in: prepared.ids } },
  });
  await tx.conversationMessage.deleteMany({
    where: { conversationId: { in: prepared.ids } },
  });
  await tx.conversationSession.deleteMany({
    where: { conversationId: { in: prepared.ids } },
  });
  const deleted = await tx.conversation.deleteMany({
    where: { id: { in: prepared.ids } },
  });
  return deleted.count;
}

/** Post-commit physical phase. Failed objects remain DELETE_PENDING for retry. */
export async function completePreparedConversationCascade(
  prepared: PreparedConversationCascade
): Promise<boolean> {
  if (prepared.ids.length === 0) return true;
  const remoteAttachments = prepared.attachments.filter((attachment) =>
    attachment.cloudrevePath.startsWith('/')
  );
  const remoteDeleted = await deleteCloudreveAttachmentFiles(remoteAttachments);
  const localDeletedByConversation = new Map<string, boolean>();
  for (const id of prepared.ids) {
    localDeletedByConversation.set(id, await deleteConversationImages(id));
  }

  let complete = true;
  for (const artifact of prepared.ledgerRows) {
    const physicalDeleted =
      artifact.artifactType === STORED_ARTIFACT_TYPE.INLINE_IMAGE
        ? localDeletedByConversation.get(artifact.conversationId ?? '') === true
        : remoteDeleted;
    if (!physicalDeleted) {
      complete = false;
      continue;
    }
    if (!(await releaseStoredArtifact(artifact.id).catch(() => false))) {
      complete = false;
    }
  }
  return complete;
}

/**
 * 物理删除一批对话 + 连带清理其全部附属资源。
 *
 * 调用方负责鉴权（确认这些 conversationId 都归当前用户或 ADMIN 有权删）。本函数只管"删干净"。
 *
 * 为什么不能裸调 `prisma.conversation.delete` 靠 onDelete: Cascade：
 *   级联只删 DB 行（ConversationMessage / ConversationSession / ChatAttachment），
 *   但 Cloudreve 上的物理文件、本地内嵌图片、User.storageBytesUsed 配额计数都不会被处理——
 *   且 DB 行一删，连兜底 cron 也再也拿不到 cloudrevePath，成永久孤儿。
 *
 * 正确顺序（照搬 admin 删用户范式 src/app/api/admin/users/route.ts，并补"释放配额"）：
 *   1. 查出这些对话的全部 ChatAttachment（拿 path + bytes + owner）
 *   2. 事务外 best-effort 删 Cloudreve 物理文件（原文件 + 抽取的 .txt）
 *   3. 事务外 best-effort 删本地 data/chatimages/<id>/ 目录
 *   4. 单事务内：FOR UPDATE 锁住附件行 → 按 owner 释放配额 → 按 FK 顺序删子表 + 对话本体
 *      （不依赖级联触发时序）
 *
 * 注：不需要 invalidate RAG 缓存——删对话不改动任何 transcript，缓存的 transcript embedding
 * 仍然有效（RAG 缓存键是 sessionId 而非 conversationId，见 transcriptRag ADR-009）。
 *
 * @returns 实际删除的对话数
 */
export async function deleteConversationsCascade(
  conversationIds: string[]
): Promise<number> {
  const prepared = await prepareConversationsCascade(conversationIds);
  if (prepared.ids.length === 0) return 0;

  // 4. 单事务内：先 FOR UPDATE 锁行再释放配额，最后按 FK 依赖顺序删除
  //    （子表虽 onDelete: Cascade，仍显式先删更稳）
  //
  // P5-13（防重复退额度）：释放口径必须是「本事务真正锁到并删掉的行」，而非事务外快照
  // `attachments`。此前两个并发删同一批对话（如用户点两次 / 批量删与单删撞车）各自按自己的
  // 快照无条件退一份，同一附件的字节被退两次，用户凭空多出配额，直到次日字节对账才纠正。
  // 与 chatFileCleanup.ts:201-207 同一范式：后到者的 SELECT ... FOR UPDATE 会阻塞到先到者
  // 提交，其后锁定结果为空 → 不再退。释放与删行同事务，也不留「提交后崩溃就漏退」的窗口。
  const deletedCount = await prisma.$transaction((tx) =>
    deletePreparedConversationsInTransaction(tx, prepared)
  );
  await completePreparedConversationCascade(prepared);
  return deletedCount;
}
