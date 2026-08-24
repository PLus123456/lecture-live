import 'server-only';

import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';
import {
  loadCloudreveContext,
  deleteCloudreveFile,
  type CloudreveDeleteContext,
} from '@/lib/storage/cloudreveFileDelete';
import { CHAT_IMAGE_ROOT } from '@/lib/llm/chatImageStorage';
import { logger, serializeError } from '@/lib/logger';
import {
  STORED_ARTIFACT_TYPE,
  findBillableStoredArtifactsByConversations,
  findBillableStoredArtifactsByOwner,
  markStoredArtifactsDeletePendingInTransaction,
  releaseStoredArtifact,
} from '@/lib/storage/storedArtifactLedger';

const jobLogger = logger.child({ component: 'chat-files-cleanup-job' });

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_SOFT_CAP_PERCENT = 90;
/**
 * 软上限触发清理后，目标下沉到 (softCap - SOFT_CAP_TARGET_DROP)% 再停。
 * 留一个缓冲，避免在临界点附近反复触发。
 */
const SOFT_CAP_TARGET_DROP = 10;

/** L57：软上限 LRU 清理的分页大小（每轮只把这么多行载进内存）。 */
const SOFT_CAP_PAGE_SIZE = 200;

/**
 * L52：孤儿图片目录的「新生保护期」。
 *
 * `readdir` 与 `findMany` 之间新建会话的图片目录不在 existingSet 里，随后会被
 * `rm -rf` 误删（毫秒-秒级窗口，但删的是用户刚上传的图，不可逆）。
 * 目录 mtime 比本轮开始时间还新（或在保护期内）的一律跳过 —— 真孤儿目录不会自己变新，
 * 下一轮 cron 照样收走它。
 */
const ORPHAN_DIR_GRACE_MS = 60 * 60 * 1000; // 1h

export interface ChatFilesCleanupResult {
  agingDeleted: number;
  softCapDeleted: number;
  bytesReleased: bigint;
  errors: number;
}

interface AttachmentRow {
  id: string;
  userId: string;
  bytes: bigint;
  cloudrevePath: string;
  extractedTextPath: string | null;
}

/**
 * 主入口：跑 aging + soft-cap 两路清理。可被定时 worker 调用，也可被 admin 手动触发
 * （但 admin 手动批量清理另有路由，本函数主要给 cron）。
 *
 * 两种模式都由 SiteSetting 控制（U13 单元引入 key），本函数防御性读取并附带默认值：
 *   - chat_files_retention_days   默认 14；置 0 表示不做老化清理
 *   - chat_files_soft_cap_percent 默认 90；置 0 表示不做软上限 LRU 清理
 */
export async function runChatFilesCleanup(): Promise<ChatFilesCleanupResult> {
  const [retentionDays, softCapPercent, cloudreveContext] = await Promise.all([
    readNumericSiteSetting('chat_files_retention_days', DEFAULT_RETENTION_DAYS),
    readNumericSiteSetting(
      'chat_files_soft_cap_percent',
      DEFAULT_SOFT_CAP_PERCENT
    ),
    loadCloudreveContext(),
  ]);

  const result: ChatFilesCleanupResult = {
    agingDeleted: 0,
    softCapDeleted: 0,
    bytesReleased: BigInt(0),
    errors: 0,
  };

  // ─── Aging cleanup ───
  if (retentionDays > 0) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    // 必须同时满足 createdAt < cutoff 且 lastAccessedAt < cutoff：仅看 createdAt 会把
    // 14 天前上传、但近期仍在引用的附件误删（RAG 检索/聊天会刷新 lastAccessedAt）。
    const stale = await prisma.chatAttachment.findMany({
      where: {
        createdAt: { lt: cutoff },
        lastAccessedAt: { lt: cutoff },
        source: 'UPLOAD',
      } as never,
      select: {
        id: true,
        userId: true,
        bytes: true,
        cloudrevePath: true,
        extractedTextPath: true,
      },
    });
    for (const att of stale) {
      try {
        await deleteAttachment(att, cloudreveContext);
        result.agingDeleted += 1;
        result.bytesReleased += att.bytes;
      } catch (err) {
        result.errors += 1;
        jobLogger.error(
          { attachmentId: att.id, err: serializeError(err) },
          'aging cleanup failed for attachment'
        );
      }
    }
  }

  // ─── Soft-cap LRU cleanup ───
  if (softCapPercent > 0) {
    // 下沉目标只与全局 softCapPercent 有关，所有用户共享 —— 提到循环外避免重复算。
    const targetPercent = Math.max(
      0,
      Math.min(100, softCapPercent - SOFT_CAP_TARGET_DROP)
    );

    // 找出所有 used > softCap * limit / 100 的用户。Prisma 不支持 column-to-column
    // 比较直接 where；用 raw SQL。ADMIN 用户配额事实上无限，不参与 LRU 清理。
    const overCapUsers: Array<{
      id: string;
      storageBytesUsed: bigint;
      storageBytesLimit: bigint;
    }> = await prisma.$queryRaw`
      SELECT id, storageBytesUsed, storageBytesLimit
      FROM User
      WHERE role <> 'ADMIN'
        AND storageBytesLimit > 0
        AND storageBytesUsed * 100 >= storageBytesLimit * ${softCapPercent}
    `;

    for (const u of overCapUsers) {
      const target =
        (u.storageBytesLimit * BigInt(targetPercent)) / BigInt(100);
      let used = u.storageBytesUsed;

      if (used <= target) continue;

      // L57：原来是不带 take 的全量 findMany —— 重度用户（数万附件）每轮 cron 都会
      // 把整张表属于他的那一片全载进内存，而实际要删的往往只是最旧的几十条。
      // 改成按 lastAccessedAt 升序**分页**拉：删够就停，任一时刻只驻留一批。
      //
      // 不用 cursor 分页：本循环会把刚取到的行删掉，cursor 指向的行随即不存在。
      // 直接反复取「最旧的一页」即可自然前进；删失败的行记进 skipIds 排除，
      // 避免同一批反复撞上同一个失败行导致死循环。
      const skipIds: string[] = [];

      while (used > target) {
        const attachments: AttachmentRow[] =
          await prisma.chatAttachment.findMany({
            where: {
              userId: u.id,
              // 只清用户上传的附件；内嵌图片等其它来源由各自的清理路径负责。
              source: 'UPLOAD',
              ...(skipIds.length > 0 ? { id: { notIn: skipIds } } : {}),
            } as never,
            orderBy: [{ lastAccessedAt: 'asc' }, { id: 'asc' }],
            take: SOFT_CAP_PAGE_SIZE,
            select: {
              id: true,
              userId: true,
              bytes: true,
              cloudrevePath: true,
              extractedTextPath: true,
            },
          });

        if (attachments.length === 0) break;

        let deletedThisPage = 0;
        for (const att of attachments) {
          if (used <= target) break;
          try {
            await deleteAttachment(att, cloudreveContext);
            result.softCapDeleted += 1;
            result.bytesReleased += att.bytes;
            used -= att.bytes;
            deletedThisPage += 1;
          } catch (err) {
            result.errors += 1;
            skipIds.push(att.id);
            jobLogger.error(
              { attachmentId: att.id, err: serializeError(err) },
              'soft-cap cleanup failed for attachment'
            );
          }
        }

        // 整页一条都没删掉（全失败）→ 再循环也只会重复失败，退出
        if (deletedThisPage === 0) break;
      }
    }
  }

  jobLogger.info(
    {
      agingDeleted: result.agingDeleted,
      softCapDeleted: result.softCapDeleted,
      // bigint 不能直接被 pino 序列化为 JSON，转字符串
      bytesReleased: result.bytesReleased.toString(),
      errors: result.errors,
    },
    'chat-files cleanup finished'
  );

  return result;
}

/**
 * 清理本地孤儿聊天图片目录 `data/chatimages/<conversationId>/`。
 *
 * 扫描该根目录下所有子项，删掉其名字（=conversationId）在 Conversation 表中已不存在的目录。
 * 背景：内嵌聊天图片只落本地磁盘、不进 ChatAttachment、不计配额；B1 起“删对话”会主动删
 * 对应目录，但删 Session 触发的级联删对话、以及 B1 之前删掉的对话都会遗留孤儿目录 —— 本函数
 * 兜底清理它们。挂在每日 billingMaintenance 里跑。
 *
 * best-effort：根目录不存在 / 单条删除失败都不抛，返回已删的目录数。
 */
export async function cleanupOrphanChatImageDirs(): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(CHAT_IMAGE_ROOT);
  } catch {
    return 0; // 根目录不存在 = 没有任何聊天图片
  }
  if (entries.length === 0) return 0;

  // 这些目录名中，哪些 conversationId 仍存在（存在的保留，其余视为孤儿）
  const existing = await prisma.conversation.findMany({
    where: { id: { in: entries } },
    select: { id: true },
  });
  const existingSet = new Set(existing.map((c) => c.id));
  const orphanNames = entries.filter((name) => !existingSet.has(name));
  const inlineLedgers = await findBillableStoredArtifactsByConversations(
    orphanNames
  );
  const inlineArtifactIds = inlineLedgers
    .filter(
      (artifact) =>
        artifact.artifactType === STORED_ARTIFACT_TYPE.INLINE_IMAGE
    )
    .map((artifact) => artifact.id);
  if (inlineArtifactIds.length > 0) {
    await prisma.$transaction((tx) =>
      markStoredArtifactsDeletePendingInTransaction(tx, inlineArtifactIds)
    );
  }

  const graceCutoff = Date.now() - ORPHAN_DIR_GRACE_MS;

  let removed = 0;
  for (const name of entries) {
    if (existingSet.has(name)) continue;

    const dirPath = path.join(CHAT_IMAGE_ROOT, name);

    // L52：TOCTOU 保护。readdir 之后、findMany 之前（甚至之后）新建的会话，其图片目录
    // 不在 existingSet 里，直接 rm -rf 就把用户刚上传的图删了。真正的孤儿目录 mtime
    // 只会越来越旧，所以「太新就跳过」不会漏收，只会晚一轮 cron。
    try {
      const stat = await fs.stat(dirPath);
      if (stat.mtimeMs > graceCutoff) continue;
    } catch {
      // stat 不到（已被别处删掉/竞态）：跳过，交给下一轮
      continue;
    }

    try {
      await fs.rm(dirPath, {
        recursive: true,
        force: true,
      });
      for (const artifact of inlineLedgers) {
        if (
          artifact.conversationId === name &&
          artifact.artifactType === STORED_ARTIFACT_TYPE.INLINE_IMAGE
        ) {
          await releaseStoredArtifact(artifact.id).catch(() => undefined);
        }
      }
      removed += 1;
    } catch (err) {
      jobLogger.warn(
        { name, err: serializeError(err) },
        '[chat-files-cleanup] 删孤儿图片目录失败'
      );
    }
  }
  return removed;
}

/**
 * 删除一条 ChatAttachment：
 *   1) 先尽力删 Cloudreve 物理文件（失败不抛 — 删不掉就让它残留，配置/网络问题不应阻塞 DB 清理）
 *   2) 然后删 DB 行 + 扣字节（一旦走到这步必须成功，否则下次循环还会撞上同一条）
 *      —— 二者包进同一事务，保证原子：要么行删掉且字节扣掉，要么都不变；
 *      避免"行已删但扣字节失败"导致 storageBytesUsed 永久虚高（字节鬼占配额）。
 *      GREATEST(0, ...) 防止减到负数。
 */
async function deleteAttachment(
  att: AttachmentRow,
  cloudreve: CloudreveDeleteContext | null
): Promise<void> {
  const ledgerRows = await findBillableStoredArtifactsByOwner(
    'chat_attachment',
    att.id
  );
  await prisma.$transaction(async (tx) => {
    await markStoredArtifactsDeletePendingInTransaction(
      tx,
      ledgerRows.map((row) => row.id)
    );
    await tx.chatAttachment.delete({ where: { id: att.id } });
    if (ledgerRows.length === 0) {
      await tx.$executeRaw`
        UPDATE User
        SET storageBytesUsed = GREATEST(0, storageBytesUsed - ${att.bytes})
        WHERE id = ${att.userId}
      `;
    }
  });

  let rawDeleted = false;
  let extractedDeleted = att.extractedTextPath === null;
  if (cloudreve) {
    rawDeleted = await deleteCloudreveFile(att.cloudrevePath, cloudreve);
    if (att.extractedTextPath) {
      extractedDeleted = await deleteCloudreveFile(
        att.extractedTextPath,
        cloudreve
      );
    }
  }

  for (const artifact of ledgerRows) {
    const deleted =
      artifact.artifactType === STORED_ARTIFACT_TYPE.CHAT_EXTRACTED
        ? extractedDeleted
        : rawDeleted;
    if (deleted) {
      await releaseStoredArtifact(artifact.id);
    }
  }
}

/**
 * 读取一个数值型 SiteSetting；找不到 / 解析失败时返回 fallback。
 * 不走 getSiteSettings()：这些 key 尚未在 SiteSettings 接口中声明（U13 单元负责注册），
 * 直接 raw 读 DB 是当前阶段最稳妥的方式 —— 即使 U13 还没上线，本 cron 也能正常跑。
 */
async function readNumericSiteSetting(
  key: string,
  fallback: number
): Promise<number> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key } });
    if (!row?.value) return fallback;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}
