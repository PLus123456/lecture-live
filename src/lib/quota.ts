import { prisma } from '@/lib/prisma';
import {
  getBillableMinutes,
  getNextQuotaResetAt,
  getQuotaCycleStartAt,
  getRemainingTranscriptionMinutes,
} from '@/lib/billing';

type QuotaCheckType = 'transcription_minutes' | 'storage_hours';

type QuotaUserRecord = {
  id: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  storageHoursUsed: number;
  storageHoursLimit: number;
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
  allowedModels: string;
  quotaResetAt: Date | null;
}

/** ADMIN 配额视为无限 — 使用一个足够大的 sentinel 值（JSON 不支持 Infinity） */
const ADMIN_UNLIMITED_MINUTES = 999_999;

function toQuotaSnapshot(user: QuotaUserRecord): UserQuotaSnapshot {
  const remainingTranscriptionMinutes =
    user.role === 'ADMIN'
      ? ADMIN_UNLIMITED_MINUTES
      : getRemainingTranscriptionMinutes(
          user.transcriptionMinutesUsed,
          user.transcriptionMinutesLimit
        );

  return {
    id: user.id,
    role: user.role,
    transcriptionMinutesUsed: user.transcriptionMinutesUsed,
    transcriptionMinutesLimit: user.transcriptionMinutesLimit,
    remainingTranscriptionMinutes,
    remainingTranscriptionMs: remainingTranscriptionMinutes * 60_000,
    storageHoursUsed: user.storageHoursUsed,
    storageHoursLimit: user.storageHoursLimit,
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

  const normalizedMinutes = Number.isFinite(minutes)
    ? Math.max(0, Math.ceil(minutes))
    : 0;

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
    select: {
      id: true,
      role: true,
      transcriptionMinutesUsed: true,
      transcriptionMinutesLimit: true,
      storageHoursUsed: true,
      storageHoursLimit: true,
      allowedModels: true,
      quotaResetAt: true,
    },
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

export async function reconcileTranscriptionUsage() {
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
        select: { durationMs: true },
      });

      const actualMinutes = sessions.reduce((total, session) => {
        if (!session.durationMs || session.durationMs <= 0) {
          return total;
        }
        return total + getBillableMinutes(session.durationMs);
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
