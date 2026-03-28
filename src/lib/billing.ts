export type AppUserRole = 'ADMIN' | 'PRO' | 'FREE';

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_AUDIO_ACTIVITY_LEVEL_THRESHOLD = 0.015;
export const QUOTA_WARNING_LEAD_MS = 2 * 60_000;

const MAX_SESSION_DURATION_BY_ROLE_MS: Record<Exclude<AppUserRole, 'ADMIN'>, number> = {
  FREE: 2 * 60 * 60_000,
  PRO: 4 * 60 * 60_000,
};

export function getMaxSessionDurationMs(role: AppUserRole): number | null {
  if (role === 'ADMIN') {
    return null;
  }

  return MAX_SESSION_DURATION_BY_ROLE_MS[role];
}

export function clampSessionDurationMs(
  durationMs: number,
  role: AppUserRole
): number {
  const normalizedDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, Math.trunc(durationMs))
    : 0;
  const limitMs = getMaxSessionDurationMs(role);

  if (limitMs == null) {
    return normalizedDurationMs;
  }

  return Math.min(normalizedDurationMs, limitMs);
}

export function getBillableMinutes(durationMs: number): number {
  const normalizedDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : 0;

  if (normalizedDurationMs <= 0) {
    return 0;
  }

  return Math.ceil(normalizedDurationMs / 60_000);
}

export function getRemainingTranscriptionMinutes(
  usedMinutes: number,
  limitMinutes: number
): number {
  if (!Number.isFinite(limitMinutes) || limitMinutes <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(limitMinutes - Math.max(0, usedMinutes)));
}

export function getRemainingTranscriptionMs(
  usedMinutes: number,
  limitMinutes: number
): number {
  return getRemainingTranscriptionMinutes(usedMinutes, limitMinutes) * 60_000;
}

export function getNextQuotaResetAt(baseDate = new Date()): Date {
  return new Date(
    Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0
    )
  );
}

export function getQuotaCycleStartAt(quotaResetAt: Date | null): Date {
  if (!quotaResetAt) {
    return new Date(0);
  }

  return new Date(
    Date.UTC(
      quotaResetAt.getUTCFullYear(),
      quotaResetAt.getUTCMonth() - 1,
      1,
      0,
      0,
      0,
      0
    )
  );
}
