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
 *  1. 把符合条件的行拉出来（硬上限 5000，超出留给下一次或 cron）。
 *  2. 在一个事务里：raw SQL clamp 释放每个用户的 storageBytesUsed + 删行。
 *
 * **不会动 Cloudreve 物理文件** —— 那是 U14 cron 的职责。
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
    select: { id: true, userId: true, bytes: true },
    take: HARD_LIMIT,
    orderBy: [{ createdAt: 'asc' }],
  });

  if (toDelete.length === 0) {
    return { deleted: 0, releasedBytes: 0, truncated: false };
  }

  const ZERO = BigInt(0);
  const byUser = new Map<string, bigint>();
  for (const row of toDelete) {
    byUser.set(row.userId, (byUser.get(row.userId) ?? ZERO) + row.bytes);
  }

  const ids = toDelete.map((r) => r.id);
  let totalReleased = ZERO;

  await prisma.$transaction(async (tx) => {
    for (const [userId, bytes] of byUser) {
      await releaseUserStorageBytesRaw(tx, userId, bytes);
      totalReleased += bytes;
    }
    await tx.chatAttachment.deleteMany({ where: { id: { in: ids } } });
  });

  return {
    deleted: toDelete.length,
    releasedBytes: Number(totalReleased),
    truncated: toDelete.length === HARD_LIMIT,
  };
}
