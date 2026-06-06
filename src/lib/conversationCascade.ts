import 'server-only';

import { prisma } from '@/lib/prisma';
import { deleteCloudreveAttachmentFiles } from '@/lib/storage/cloudreveFileDelete';
import { deleteConversationImages } from '@/lib/llm/chatImageStorage';
import { releaseStorageBytes } from '@/lib/quota';
import { logger, serializeError } from '@/lib/logger';

const cascadeLogger = logger.child({ component: 'conversation-cascade' });

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
 *   4. 单事务内显式按 FK 顺序删子表 + 对话本体（不依赖级联触发时序）
 *   5. 事务后按 owner 聚合 releaseStorageBytes 释放配额（GREATEST(0,…) clamp，best-effort）
 *
 * 注：不需要 invalidate RAG 缓存——删对话不改动任何 transcript，缓存的 transcript embedding
 * 仍然有效（RAG 缓存键是 sessionId 而非 conversationId，见 transcriptRag ADR-009）。
 *
 * @returns 实际删除的对话数
 */
export async function deleteConversationsCascade(
  conversationIds: string[]
): Promise<number> {
  const ids = Array.from(new Set(conversationIds.filter(Boolean)));
  if (ids.length === 0) return 0;

  // 1. 查出待删对话的全部附件（含物理路径与配额信息）
  const attachments = await prisma.chatAttachment.findMany({
    where: { conversationId: { in: ids } },
    select: {
      userId: true,
      bytes: true,
      cloudrevePath: true,
      extractedTextPath: true,
    },
  });

  // 2. best-effort 删 Cloudreve 物理文件（事务外，失败不阻塞 DB 清理）
  await deleteCloudreveAttachmentFiles(attachments);

  // 3. best-effort 删本地内嵌图片目录（逐对话）
  for (const id of ids) {
    await deleteConversationImages(id);
  }

  // 4. 单事务内按 FK 依赖顺序删除（子表虽 onDelete: Cascade，仍显式先删更稳）
  const txResults = await prisma.$transaction([
    prisma.chatAttachment.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.conversationMessage.deleteMany({
      where: { conversationId: { in: ids } },
    }),
    prisma.conversationSession.deleteMany({
      where: { conversationId: { in: ids } },
    }),
    prisma.conversation.deleteMany({ where: { id: { in: ids } } }),
  ]);
  const deletedCount = txResults[txResults.length - 1].count;

  // 5. 按 owner 聚合释放字节配额（best-effort；失败留给每日字节对账兜底）
  const bytesByOwner = new Map<string, bigint>();
  for (const att of attachments) {
    bytesByOwner.set(
      att.userId,
      (bytesByOwner.get(att.userId) ?? BigInt(0)) + att.bytes
    );
  }
  for (const [ownerId, bytes] of bytesByOwner) {
    if (bytes > BigInt(0)) {
      await releaseStorageBytes(ownerId, Number(bytes)).catch((err) => {
        cascadeLogger.warn(
          { ownerId, bytes: bytes.toString(), err: serializeError(err) },
          'releaseStorageBytes 失败；字节对账会兜底'
        );
      });
    }
  }

  return deletedCount;
}
