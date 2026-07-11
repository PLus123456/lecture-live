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

/**
 * DELETE / POST 共用的核心清理逻辑：
 *  1. 把符合条件的行拉出来（硬上限 5000，超出留给下一次或 cron），含物理路径。
 *  2. 事务外 best-effort 删 Cloudreve 物理文件（原文件 + 抽取的 .txt）。
 *  3. 在一个事务里：raw SQL clamp 释放每个用户的 storageBytesUsed + 删行。
 *
 * U6：删物理文件必须在删行前做——行一删 cloudrevePath 即永久丢失，cron 也再扫不到。
 *
 * TODO U2 合并后改用 releaseStorageBytes(userId, bytes) 替代 raw SQL。
 */
export async function performChatFileCleanup(input: {
  olderThanDays: number;
  sizeBytesGT: number;
  userId?: string;
  kinds: ChatFileKind[];
  conversationId?: string;
}): Promise<{
  deleted: number;
  releasedBytes: number;
  truncated: boolean;
}> {
  const HARD_LIMIT = 5000;
  const cutoff = olderThanDaysToCutoff(input.olderThanDays);

  const where: Prisma.ChatAttachmentWhereInput = {
    createdAt: { lt: cutoff },
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.kinds.length > 0 ? { kind: { in: input.kinds } } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.sizeBytesGT > 0 ? { bytes: { gt: BigInt(input.sizeBytesGT) } } : {}),
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

  if (toDelete.length === 0) {
    return { deleted: 0, releasedBytes: 0, truncated: false };
  }

  const ZERO = BigInt(0);
  const ids = toDelete.map((r) => r.id);
  let totalReleased = ZERO;
  let deletedCount = 0;

  // U6：事务外 best-effort 删 Cloudreve 物理文件（原文件 + 抽取的 .txt），再删 DB 行。
  // 顺序刻意放在删行前：一旦行删掉，cloudrevePath 就永久丢失、cron 也再扫不到。
  // 与 conversationCascade.ts 同一范式；失败仅内部 warn，不阻塞 DB 清理。
  await deleteCloudreveAttachmentFiles(toDelete);

  await prisma.$transaction(async (tx) => {
    // B8（防重复退额度）：释放口径必须是「本事务实际删除的行」，而非删除前快照 toDelete。
    // 用 FOR UPDATE 锁定并重读仍存在的行 —— 并发的单条 DELETE /api/chat-uploads/[id] 会被行锁
    // 阻塞到本事务提交，其后 prisma.delete 命中不到行(P2025) → 跳过它自己的 release；反之若单删
    // 先提交，则该行已不在锁定结果里、本处也不再退。故任一行的字节至多被释放一次，杜绝与并发
    // 单删叠加造成的 over-release（此前按快照 byUser 无条件重复退，用户被多退一份直到次日字节对账才纠正）。
    const lockedRows = await tx.$queryRaw<
      Array<{ id: string; userId: string; bytes: bigint }>
    >(Prisma.sql`
      SELECT id, userId, bytes FROM ChatAttachment
      WHERE id IN (${Prisma.join(ids)})
      FOR UPDATE
    `);

    const releaseByUser = new Map<string, bigint>();
    for (const row of lockedRows) {
      releaseByUser.set(row.userId, (releaseByUser.get(row.userId) ?? ZERO) + row.bytes);
    }
    for (const [userId, bytes] of releaseByUser) {
      await releaseUserStorageBytesRaw(tx, userId, bytes);
      totalReleased += bytes;
    }

    const existingIds = lockedRows.map((r) => r.id);
    if (existingIds.length > 0) {
      await tx.chatAttachment.deleteMany({ where: { id: { in: existingIds } } });
    }
    deletedCount = existingIds.length;
  });

  return {
    // 实际删除并释放的行数（并发单删已删走的行不重复计入）。
    deleted: deletedCount,
    releasedBytes: Number(totalReleased),
    // 是否触达本次硬上限（用初始候选量判断，与并发无关）。
    truncated: toDelete.length === HARD_LIMIT,
  };
}
