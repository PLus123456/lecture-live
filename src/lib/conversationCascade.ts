import 'server-only';

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { deleteCloudreveAttachmentFiles } from '@/lib/storage/cloudreveFileDelete';
import { deleteConversationImages } from '@/lib/llm/chatImageStorage';
// P5-13：配额释放改走 chatFileCleanup 的 raw-in-tx 写法（见下方步骤 4 注释）。
import { releaseUserStorageBytesRaw } from '@/lib/chatFileCleanup';

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
 *   5. 提交后补删「步骤 1 快照里没有、但步骤 4 真的删掉了」的那些行的物理文件（M28 窗口 1）
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
  //    M28：多取 id —— 步骤 5 要拿它和事务内真正删掉的行做差集。
  const attachments = await prisma.chatAttachment.findMany({
    where: { conversationId: { in: ids } },
    select: {
      id: true,
      userId: true,
      bytes: true,
      cloudrevePath: true,
      extractedTextPath: true,
    },
  });
  const snapshotIds = new Set(attachments.map((a) => a.id));

  // 2. best-effort 删 Cloudreve 物理文件（事务外，失败不阻塞 DB 清理）
  await deleteCloudreveAttachmentFiles(attachments);

  // 3. best-effort 删本地内嵌图片目录（逐对话）
  for (const id of ids) {
    await deleteConversationImages(id);
  }

  // 4. 单事务内：先 FOR UPDATE 锁行再释放配额，最后按 FK 依赖顺序删除
  //    （子表虽 onDelete: Cascade，仍显式先删更稳）
  //
  // P5-13（防重复退额度）：释放口径必须是「本事务真正锁到并删掉的行」，而非事务外快照
  // `attachments`。此前两个并发删同一批对话（如用户点两次 / 批量删与单删撞车）各自按自己的
  // 快照无条件退一份，同一附件的字节被退两次，用户凭空多出配额，直到次日字节对账才纠正。
  // 与 chatFileCleanup.ts:201-207 同一范式：后到者的 SELECT ... FOR UPDATE 会阻塞到先到者
  // 提交，其后锁定结果为空 → 不再退。释放与删行同事务，也不留「提交后崩溃就漏退」的窗口。
  //
  // M28（窗口 1）：步骤 4 删的是 `deleteMany({ conversationId })` —— 一个**范围**谓词，
  // 会把「步骤 1 快照之后才插入本对话」的新附件一并删掉，而那些行的物理文件从没进过
  // 步骤 2 的快照。行一删 cloudrevePath 永久丢失，兜底 cron 也再扫不到 → 永久孤儿。
  // 所以事务内的 FOR UPDATE 锁读要顺带把物理路径取回来（那才是「真正被删的那批行」），
  // 与快照做差集，留给步骤 5 在**提交之后**补删。
  //
  // 为什么不干脆把物理删除整个挪到提交后（审计报告的建议）：那是作者刻意否决的方案，
  // 见 chatFileCleanup.ts:191 —— 提交后进程崩溃/断电就再也拿不到 cloudrevePath。
  // 这里只补齐「快照没覆盖到」的那部分，主路径的删除顺序保持不变。
  let deletedCount = 0;
  let orphanedByRace: Array<{
    cloudrevePath: string;
    extractedTextPath: string | null;
  }> = [];
  await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<
      Array<{
        id: string;
        userId: string;
        bytes: bigint;
        cloudrevePath: string;
        extractedTextPath: string | null;
      }>
    >(Prisma.sql`
      SELECT id, userId, bytes, cloudrevePath, extractedTextPath FROM ChatAttachment
      WHERE conversationId IN (${Prisma.join(ids)})
      FOR UPDATE
    `);

    // 差集：本事务锁到并即将删掉、但不在事务外快照里的行 = 竞态插入的新附件。
    orphanedByRace = lockedRows
      .filter((row) => !snapshotIds.has(row.id))
      .map((row) => ({
        cloudrevePath: row.cloudrevePath,
        extractedTextPath: row.extractedTextPath,
      }));

    const bytesByOwner = new Map<string, bigint>();
    for (const row of lockedRows) {
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

    await tx.chatAttachment.deleteMany({ where: { conversationId: { in: ids } } });
    await tx.conversationMessage.deleteMany({
      where: { conversationId: { in: ids } },
    });
    await tx.conversationSession.deleteMany({
      where: { conversationId: { in: ids } },
    });
    const deleted = await tx.conversation.deleteMany({ where: { id: { in: ids } } });
    deletedCount = deleted.count;
  });

  // 5. M28 窗口 1 补删：**必须在事务提交之后**。
  //    $transaction 回滚会抛出，控制流根本走不到这里 —— 行还在、文件也就必须还在
  //    （提前删会把「行存在但内容 404」的悬垂引用做成既成事实，而回滚本就意味着没删）。
  if (orphanedByRace.length > 0) {
    await deleteCloudreveAttachmentFiles(orphanedByRace);
  }

  return deletedCount;
}
