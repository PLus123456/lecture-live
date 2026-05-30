import type { UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSiteSettings } from '@/lib/siteSettings';

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

/** 各角色 chat 字节配额的静态兜底（MB）——与 siteSettings 的 chat_files_quota_*_mb 默认一致。
 *  真实生效值由 admin 在 SiteSetting 配置，通过 resolveRoleStorageBytesLimit 读取。 */
const DEFAULT_ROLE_STORAGE_BYTES_MB: Record<UserRole, number> = {
  ADMIN: 10240,
  PRO: 1024,
  FREE: 100,
};

const MB = 1024 * 1024;

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
 * 从 SiteSetting 读取某角色的 chat 字节配额上限（字节，BigInt）。
 *
 * 这是把 admin 在「Chat 文件」面板配的 chat_files_quota_{free,pro,admin}_mb 真正
 * 落到 User.storageBytesLimit 的唯一来源。此前这三个值只存进 SiteSetting、从未
 * 推给任何用户，导致所有人被钉死在 schema 默认 100MB。
 */
export async function resolveRoleStorageBytesLimit(role: UserRole): Promise<bigint> {
  const settings = await getSiteSettings();
  const mb =
    role === 'ADMIN'
      ? settings.chat_files_quota_admin_mb
      : role === 'PRO'
        ? settings.chat_files_quota_pro_mb
        : settings.chat_files_quota_free_mb;
  const safeMb = Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_ROLE_STORAGE_BYTES_MB[role];
  return BigInt(Math.floor(safeMb)) * BigInt(MB);
}

/**
 * 将自定义用户组的配额同步到指定用户。
 * 字节配额按用户角色从 SiteSetting 解析（自定义组沿用其底层角色的字节上限）。
 */
export async function syncUserQuotas(userId: string, permissions: GroupPermissions) {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const storageBytesLimit = target
    ? await resolveRoleStorageBytesLimit(target.role)
    : undefined;
  await prisma.user.update({
    where: { id: userId },
    data: {
      allowedModels: permissions.allowedModels,
      transcriptionMinutesLimit: permissions.transcriptionMinutesLimit,
      storageHoursLimit: permissions.storageHoursLimit,
      ...(storageBytesLimit !== undefined && { storageBytesLimit }),
    },
  });
}

/**
 * 批量同步自定义组内所有用户的配额。
 * 字节配额按角色解析后逐角色 updateMany（自定义组成员可能跨角色）。
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
  // 字节上限按角色（FREE/PRO/ADMIN）分别回填
  for (const role of ['FREE', 'PRO', 'ADMIN'] as const) {
    const storageBytesLimit = await resolveRoleStorageBytesLimit(role);
    await prisma.user.updateMany({
      where: { customGroupId: groupId, role },
      data: { storageBytesLimit },
    });
  }
}
