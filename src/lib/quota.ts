import { prisma } from '@/lib/prisma';
import {
  getBillableMinutes,
  getNextQuotaResetAt,
  getQuotaCycleStartAt,
  getRemainingTranscriptionMinutes,
} from '@/lib/billing';

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
  now = new Date()
): Promise<QuotaUserRecord | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: QUOTA_USER_SELECT,
  });

  if (!user) {
    return null;
  }

  // 首次：初始化配额窗口
  if (user.quotaResetAt == null) {
    return prisma.user.update({
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
  const resetResult = await prisma.user.updateMany({
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
    return prisma.user.findUnique({
      where: { id: userId },
      select: QUOTA_USER_SELECT,
    });
  }

  // 重置成功，返回最新值
  return prisma.user.findUnique({
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
    case 'storage_hours':
      return user.storageHoursUsed < user.storageHoursLimit;
    case 'storage_bytes':
      return user.storageBytesUsed < user.storageBytesLimit;
    default:
      return false;
  }
}

export async function deductTranscriptionMinutes(
  userId: string,
  minutes: number
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId);
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

  const updated = await prisma.user.update({
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
  const expiredUsers = await prisma.user.findMany({
    where: {
      quotaResetAt: {
        lte: now,
      },
    },
    select: {
      id: true,
    },
  });

  if (expiredUsers.length === 0) {
    return 0;
  }

  const nextResetAt = getNextQuotaResetAt(now);

  await prisma.$transaction(
    expiredUsers.map((user) =>
      prisma.user.update({
        where: { id: user.id },
        data: {
          transcriptionMinutesUsed: 0,
          quotaResetAt: nextResetAt,
        },
      })
    )
  );

  return expiredUsers.length;
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
