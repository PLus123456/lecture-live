import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  getBillableMinutes,
  getNextQuotaResetAt,
  getQuotaCycleStartAt,
  getRemainingTranscriptionMinutes,
} from '@/lib/billing';

/**
 * 可选 Prisma 客户端：默认用全局 `prisma`；调用方可传入事务客户端（`$transaction`
 * 的 tx），让配额窗口校验 + 扣减与外层事务在同一事务里原子提交。
 * PrismaClient 是 TransactionClient 的超集，故 `= prisma` 默认值类型相容。
 */
type QuotaDbClient = Prisma.TransactionClient;

type QuotaCheckType = 'transcription_minutes' | 'storage_hours' | 'storage_bytes';

type QuotaUserRecord = {
  id: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  storageHoursUsed: number;
  storageHoursLimit: number;
  storageBytesUsed: bigint;
  storageBytesLimit: bigint;
  allowedModels: string;
  quotaResetAt: Date | null;
};

export interface UserQuotaSnapshot {
  id: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  remainingTranscriptionMinutes: number;
  remainingTranscriptionMs: number;
  storageHoursUsed: number;
  storageHoursLimit: number;
  storageBytesUsed: number;
  storageBytesLimit: number;
  remainingStorageBytes: number;
  allowedModels: string;
  quotaResetAt: Date | null;
}

/** ADMIN 配额视为无限 — 使用一个足够大的 sentinel 值（JSON 不支持 Infinity） */
const ADMIN_UNLIMITED_MINUTES = 999_999;
/** ADMIN bytes sentinel ≈ 1 TB，远小于 Number.MAX_SAFE_INTEGER (~9 PB)，可安全 JSON 序列化 */
const ADMIN_UNLIMITED_BYTES = 1_000_000_000_000;

/** 把外部传入的 amount 归一化为非负整数：NaN/Infinity/负数都视为 0 */
function normalizeNonNegativeAmount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
}

function toQuotaSnapshot(user: QuotaUserRecord): UserQuotaSnapshot {
  const remainingTranscriptionMinutes =
    user.role === 'ADMIN'
      ? ADMIN_UNLIMITED_MINUTES
      : getRemainingTranscriptionMinutes(
          user.transcriptionMinutesUsed,
          user.transcriptionMinutesLimit
        );

  const storageBytesUsed = Number(user.storageBytesUsed);
  const storageBytesLimit = Number(user.storageBytesLimit);
  const remainingStorageBytes =
    user.role === 'ADMIN'
      ? ADMIN_UNLIMITED_BYTES
      : Math.max(0, storageBytesLimit - storageBytesUsed);

  return {
    id: user.id,
    role: user.role,
    transcriptionMinutesUsed: user.transcriptionMinutesUsed,
    transcriptionMinutesLimit: user.transcriptionMinutesLimit,
    remainingTranscriptionMinutes,
    remainingTranscriptionMs: remainingTranscriptionMinutes * 60_000,
    storageHoursUsed: user.storageHoursUsed,
    storageHoursLimit: user.storageHoursLimit,
    storageBytesUsed,
    storageBytesLimit,
    remainingStorageBytes,
    allowedModels: user.allowedModels,
    quotaResetAt: user.quotaResetAt,
  };
}

const QUOTA_USER_SELECT = {
  id: true,
  role: true,
  transcriptionMinutesUsed: true,
  transcriptionMinutesLimit: true,
  storageHoursUsed: true,
  storageHoursLimit: true,
  storageBytesUsed: true,
  storageBytesLimit: true,
  allowedModels: true,
  quotaResetAt: true,
} as const;

async function ensureQuotaWindow(
  userId: string,
  now = new Date(),
  db: QuotaDbClient = prisma
): Promise<QuotaUserRecord | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: QUOTA_USER_SELECT,
  });

  if (!user) {
    return null;
  }

  // 首次：初始化配额窗口
  if (user.quotaResetAt == null) {
    return db.user.update({
      where: { id: userId },
      data: {
        quotaResetAt: getNextQuotaResetAt(now),
      },
      select: QUOTA_USER_SELECT,
    });
  }

  // 未过期：直接返回
  if (user.quotaResetAt > now) {
    return user;
  }

  // 已过期：用乐观锁重置，防止并发请求同时重置清零刚扣的配额
  const resetResult = await db.user.updateMany({
    where: {
      id: userId,
      quotaResetAt: { lte: now },
    },
    data: {
      transcriptionMinutesUsed: 0,
      quotaResetAt: getNextQuotaResetAt(now),
    },
  });

  if (resetResult.count === 0) {
    // 另一个请求已经完成了重置，重新读取最新值
    return db.user.findUnique({
      where: { id: userId },
      select: QUOTA_USER_SELECT,
    });
  }

  // 重置成功，返回最新值
  return db.user.findUnique({
    where: { id: userId },
    select: QUOTA_USER_SELECT,
  });
}

export async function getQuotaSnapshot(
  userId: string
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId);
  return user ? toQuotaSnapshot(user) : null;
}

/**
 * 实时计算某用户已用的"录音存储小时"。
 *
 * 口径：SUM(session.durationMs)/3600000，覆盖该用户全部 session。删录音即删 Session 行
 *（见 DELETE /api/sessions/[id]，整行级联删除，无"删录音留行"路径），故对剩余行求和即为
 * 当前真实占用——天然随删除回落、无漂移，也无须 increment 维护 storageHoursUsed 列。
 *
 * 注意：与按月重置的 transcriptionMinutesUsed 不同，录音存储是累计占用、不随配额周期重置，
 * 因此这里不按 quotaResetAt 截断，聚合全部历史 session。
 */
export async function getStorageHoursUsed(
  userId: string,
  db: QuotaDbClient = prisma
): Promise<number> {
  const agg = await db.session.aggregate({
    where: { userId },
    _sum: { durationMs: true },
  });
  const totalMs = agg._sum.durationMs ?? 0;
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return 0;
  }
  return totalMs / 3_600_000;
}

export async function checkQuota(
  userId: string,
  type: QuotaCheckType
): Promise<boolean> {
  const user = await getQuotaSnapshot(userId);
  if (!user) {
    return false;
  }

  if (user.role === 'ADMIN') {
    return true;
  }

  switch (type) {
    case 'transcription_minutes':
      return user.transcriptionMinutesUsed < user.transcriptionMinutesLimit;
    case 'storage_hours': {
      // storageHoursUsed 列从不 increment（死维度）；实时用 SUM(durationMs)/3600000 作为
      // 已用量，与 storageHoursLimit 比较。这样删录音后占用自动回落，杜绝"恒 0<limit 恒真"。
      const usedHours = await getStorageHoursUsed(userId);
      return usedHours < user.storageHoursLimit;
    }
    case 'storage_bytes':
      return user.storageBytesUsed < user.storageBytesLimit;
    default:
      return false;
  }
}

/**
 * 扣减转录分钟（finalize / 异步上传 / interpret 共用）。
 *
 * 内部先 `ensureQuotaWindow` 做跨月度重置点的窗口校正，再 increment —— 保证扣减
 * 总是落在正确的当月窗口（裸 increment 会在跨月时把分钟加到未重置的旧窗口，造成隐性 drift）。
 *
 * @param db 可选事务客户端。实时 finalize 传入 `$transaction` 的 tx，使"扣减 ⟺ session
 *   置 COMPLETED"在同一事务原子提交（失败一起回滚，杜绝并发/重试双扣或漏扣）。
 */
export async function deductTranscriptionMinutes(
  userId: string,
  minutes: number,
  db: QuotaDbClient = prisma
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId, new Date(), db);
  if (!user) {
    return null;
  }

  if (user.role === 'ADMIN') {
    return toQuotaSnapshot(user);
  }

  const normalizedMinutes = normalizeNonNegativeAmount(minutes);

  if (normalizedMinutes <= 0) {
    return toQuotaSnapshot(user);
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: {
      transcriptionMinutesUsed: {
        increment: normalizedMinutes,
      },
    },
    select: QUOTA_USER_SELECT,
  });

  return toQuotaSnapshot(updated);
}

export async function resetExpiredTranscriptionQuotas(
  now = new Date()
): Promise<number> {
  const nextResetAt = getNextQuotaResetAt(now);

  // 乐观锁条件重置（对齐 ensureQuotaWindow 的 updateMany WHERE quotaResetAt<=now）：
  // 单条原子 updateMany 取代"先 findMany 再逐个无条件 update"。无条件 update 会与请求
  // 路径上的 ensureQuotaWindow / 扣费在毫秒级并发时互相覆写——把刚被重置并扣过费的窗口
  // 再次清零（白送额度）。以 updateMany 的 count 为返回值，且消除 findMany→update 的 TOCTOU。
  const result = await prisma.user.updateMany({
    where: {
      quotaResetAt: { lte: now },
    },
    data: {
      transcriptionMinutesUsed: 0,
      quotaResetAt: nextResetAt,
    },
  });

  return result.count;
}

/**
 * 对账：按已完成 session 的实际时长重算应扣分钟，与 transcriptionMinutesUsed 比对。
 *
 * @param asyncMultiplier 异步上传转录的计费倍率（默认 1）。异步路径按倍率计费
 *   （见 async-transcribe-status 扣费），对账侧必须乘同样倍率，否则会把折扣恒报成 drift。
 *   实时转录始终全额（不乘倍率）。
 */
export async function reconcileTranscriptionUsage(asyncMultiplier = 1) {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      transcriptionMinutesUsed: true,
      quotaResetAt: true,
    },
  });

  const results = await Promise.all(
    users.map(async (user) => {
      const cycleStart = getQuotaCycleStartAt(user.quotaResetAt);

      const sessions = await prisma.session.findMany({
        where: {
          userId: user.id,
          status: 'COMPLETED',
          createdAt: { gte: cycleStart },
        },
        select: { durationMs: true, asyncTranscribeStatus: true },
      });

      const actualMinutes = sessions.reduce((total, session) => {
        if (!session.durationMs || session.durationMs <= 0) {
          return total;
        }
        const billable = getBillableMinutes(session.durationMs);
        // 异步上传转录（asyncTranscribeStatus 非空）按倍率，实时转录全额。
        // 与扣费侧 ceil(分钟×倍率) 完全一致，保证折扣不被误报为 drift。
        const charged =
          session.asyncTranscribeStatus != null
            ? Math.ceil(billable * asyncMultiplier)
            : billable;
        return total + charged;
      }, 0);

      return {
        id: user.id,
        email: user.email,
        recordedMinutes: actualMinutes,
        transcriptionMinutesUsed: user.transcriptionMinutesUsed,
        driftMinutes: actualMinutes - user.transcriptionMinutesUsed,
      };
    })
  );

  return results.filter((entry) => entry.driftMinutes !== 0);
}

/**
 * 字节配额对账：用 ChatAttachment 的真实 SUM(bytes) 回写每个用户的 storageBytesUsed。
 *
 * 与转录对账（只记录差异、不自动修）不同，字节用量完全由 ChatAttachment 行决定、是确定性的，
 * 因此这里直接回写自愈：删录音漏扣 / 上传中断漏扣 / 并发偏差等都会被校准。无附件的用户若残留
 * 非零计数也会被清零。返回检查与修正的用户数。
 */
export async function reconcileStorageBytes(): Promise<{
  checked: number;
  corrected: number;
}> {
  const sums = await prisma.chatAttachment.groupBy({
    by: ['userId'],
    _sum: { bytes: true },
  });
  const sumByUser = new Map<string, bigint>();
  for (const row of sums) {
    sumByUser.set(row.userId, row._sum.bytes ?? BigInt(0));
  }

  const users = await prisma.user.findMany({
    select: { id: true, storageBytesUsed: true },
  });

  let corrected = 0;
  for (const user of users) {
    const actual = sumByUser.get(user.id) ?? BigInt(0);
    if (actual !== user.storageBytesUsed) {
      await prisma.user.update({
        where: { id: user.id },
        data: { storageBytesUsed: actual },
      });
      corrected += 1;
    }
  }
  return { checked: users.length, corrected };
}

export function isModelAllowed(
  user: { allowedModels: string; role: string },
  modelName: string
): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.allowedModels === '*') return true;
  return user.allowedModels
    .split(',')
    .map((m) => m.trim())
    .includes(modelName);
}

/**
 * 在用户的 storageBytesUsed 上加增量（用于 chat 上传文件 / 录音文件计费）。
 * 输入 bytes 是 JS number；内部转 BigInt 落库。ADMIN 不扣减但仍返回最新 snapshot。
 */
export async function addStorageBytes(
  userId: string,
  bytes: number
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId);
  if (!user) return null;
  if (user.role === 'ADMIN') return toQuotaSnapshot(user);

  const normalized = normalizeNonNegativeAmount(bytes);
  if (normalized <= 0) return toQuotaSnapshot(user);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      storageBytesUsed: { increment: BigInt(normalized) },
    },
    select: QUOTA_USER_SELECT,
  });
  return toQuotaSnapshot(updated);
}

/**
 * 原子预留字节配额（用于 chat 上传前的"先占额度"）。
 *
 * 与 addStorageBytes 的区别：这是**条件原子**扣减——只有当 `used + bytes <= limit`
 * 时才真正写库并返回 true；否则不写库、返回 false。用一条 `UPDATE ... WHERE` 完成
 * 校验+扣减，杜绝"先 checkQuota 再 addStorageBytes"之间的并发击穿（多个上传同时
 * 通过非原子检查、叠加后超额）。
 *
 * ADMIN 视为无限：直接放行、不写库、返回 true。
 * 调用方在后续步骤失败时应调用 releaseStorageBytes 回滚预留的额度。
 */
export async function reserveStorageBytes(
  userId: string,
  bytes: number
): Promise<boolean> {
  const user = await ensureQuotaWindow(userId);
  if (!user) return false;
  if (user.role === 'ADMIN') return true;

  const normalized = normalizeNonNegativeAmount(bytes);
  if (normalized <= 0) return true;

  // 条件原子扣减：仅当扣减后不超过 limit 才更新。affectedRows=1 表示预留成功。
  const affected = await prisma.$executeRaw`
    UPDATE User
    SET storageBytesUsed = storageBytesUsed + ${BigInt(normalized)}
    WHERE id = ${userId}
      AND storageBytesUsed + ${BigInt(normalized)} <= storageBytesLimit
  `;
  return affected === 1;
}

/**
 * 从 storageBytesUsed 扣减（用于删除 chat 附件释放配额）。低于 0 截断到 0。
 */
export async function releaseStorageBytes(
  userId: string,
  bytes: number
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId);
  if (!user) return null;
  if (user.role === 'ADMIN') return toQuotaSnapshot(user);

  const normalized = normalizeNonNegativeAmount(bytes);
  if (normalized <= 0) return toQuotaSnapshot(user);

  // 用 raw SQL 保证不会减到负数（Prisma decrement 不带 GREATEST）
  await prisma.$executeRaw`
    UPDATE User
    SET storageBytesUsed = GREATEST(0, storageBytesUsed - ${BigInt(normalized)})
    WHERE id = ${userId}
  `;
  const refreshed = await prisma.user.findUnique({
    where: { id: userId },
    select: QUOTA_USER_SELECT,
  });
  return refreshed ? toQuotaSnapshot(refreshed) : null;
}

/**
 * 原子预留转录分钟（用于异步上传入口的"先占额度"门禁）。
 *
 * 与 deductTranscriptionMinutes 的区别：这是**条件原子**扣减——只有当
 * `transcriptionMinutesUsed + minutes <= transcriptionMinutesLimit` 时才真正写库并返回 true；
 * 否则不写库、返回 false。用一条 `UPDATE ... WHERE` 完成校验+扣减，杜绝"先 checkQuota 再上传"
 * 之间的并发击穿（多个上传同时通过非原子读检查、叠加后超额），也修正"还剩 1 分钟仍放行
 * 300 分钟文件"的投影漏洞（按声明时长投影后再判 limit）。
 *
 * 先 ensureQuotaWindow 做跨月窗口校正，再原子预留——保证预留落在正确的当月窗口。
 * ADMIN 视为无限：直接放行、不写库、返回 true。
 * 调用方在后续步骤失败时应调用 releaseTranscriptionMinutes 回滚预留的额度。
 */
export async function reserveTranscriptionMinutes(
  userId: string,
  minutes: number,
  db: QuotaDbClient = prisma
): Promise<boolean> {
  const user = await ensureQuotaWindow(userId, new Date(), db);
  if (!user) return false;
  if (user.role === 'ADMIN') return true;

  const normalized = normalizeNonNegativeAmount(minutes);
  if (normalized <= 0) return true;

  // 条件原子扣减：仅当扣减后不超过 limit 才更新。affectedRows=1 表示预留成功。
  const affected = await db.$executeRaw`
    UPDATE User
    SET transcriptionMinutesUsed = transcriptionMinutesUsed + ${normalized}
    WHERE id = ${userId}
      AND transcriptionMinutesUsed + ${normalized} <= transcriptionMinutesLimit
  `;
  return affected === 1;
}

/**
 * 回滚 reserveTranscriptionMinutes 预留的分钟（低于 0 截断到 0）。
 * 用 raw SQL + GREATEST 保证不会减到负数（Prisma decrement 不带 GREATEST）。
 */
export async function releaseTranscriptionMinutes(
  userId: string,
  minutes: number,
  db: QuotaDbClient = prisma
): Promise<void> {
  const normalized = normalizeNonNegativeAmount(minutes);
  if (normalized <= 0) return;

  await db.$executeRaw`
    UPDATE User
    SET transcriptionMinutesUsed = GREATEST(0, transcriptionMinutesUsed - ${normalized})
    WHERE id = ${userId}
  `;
}
