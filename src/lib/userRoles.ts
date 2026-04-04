import type { UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export function normalizeUserRole(
  value: unknown,
  fallback: UserRole = 'FREE'
): UserRole {
  if (value === 'ADMIN' || value === 'PRO' || value === 'FREE') {
    return value;
  }
  return fallback;
}

export function resolvePublicRegistrationRole(value: unknown): UserRole {
  return value === 'PRO' ? 'PRO' : 'FREE';
}

export interface GroupPermissions {
  transcriptionMinutesLimit: number;
  storageHoursLimit: number;
  allowedModels: string;
  maxConcurrentSessions?: number;
}

export function getDefaultQuotasForRole(role: UserRole): GroupPermissions {
  switch (role) {
    case 'ADMIN':
      return {
        transcriptionMinutesLimit: 999999,
        storageHoursLimit: 999999,
        allowedModels: '*',
      };
    case 'PRO':
      return {
        transcriptionMinutesLimit: 600,
        storageHoursLimit: 100,
        allowedModels: 'local,gpt,deepseek',
      };
    default:
      return {
        transcriptionMinutesLimit: 60,
        storageHoursLimit: 10,
        allowedModels: 'local',
      };
  }
}

/**
 * 将自定义用户组的配额同步到指定用户
 */
export async function syncUserQuotas(userId: string, permissions: GroupPermissions) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      allowedModels: permissions.allowedModels,
      transcriptionMinutesLimit: permissions.transcriptionMinutesLimit,
      storageHoursLimit: permissions.storageHoursLimit,
    },
  });
}

/**
 * 批量同步自定义组内所有用户的配额
 */
export async function syncUsersOfCustomGroup(groupId: string, permissions: GroupPermissions) {
  await prisma.user.updateMany({
    where: { customGroupId: groupId },
    data: {
      allowedModels: permissions.allowedModels,
      transcriptionMinutesLimit: permissions.transcriptionMinutesLimit,
      storageHoursLimit: permissions.storageHoursLimit,
    },
  });
}
