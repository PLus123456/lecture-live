import type { UserRole } from '@prisma/client';

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

export function getDefaultQuotasForRole(role: UserRole) {
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
