'use client';

import {
  getAuthBoundarySnapshot,
  useAuthStore,
} from '@/stores/authStore';

interface PersistedAuthBoundary {
  userId: string | null;
  sessionBinding: string | null;
}

export function parsePersistedAuthBoundary(
  value: string | null
): PersistedAuthBoundary {
  try {
    const parsed = value
      ? (JSON.parse(value) as {
          state?: {
            user?: { id?: unknown } | null;
            sessionBinding?: unknown;
          };
        })
      : null;
    return {
      userId:
        typeof parsed?.state?.user?.id === 'string'
          ? parsed.state.user.id
          : null,
      sessionBinding:
        typeof parsed?.state?.sessionBinding === 'string'
          ? parsed.state.sessionBinding
          : null,
    };
  } catch {
    return { userId: null, sessionBinding: null };
  }
}

/**
 * 处理另一 Tab 的 auth persist 变化。先使本 Tab 匿名、递增 epoch、abort 旧请求并完成
 * 两轮 account cleanup，之后才 reload；清理期间不会把 null 写回去覆盖来源 Tab 的新值。
 */
export async function handleExternalAuthStorageBoundary(
  newValue: string | null,
  reload: () => void = () => window.location.reload()
): Promise<boolean> {
  const incoming = parsePersistedAuthBoundary(newValue);
  const current = getAuthBoundarySnapshot();
  if (
    incoming.userId === current.userId &&
    incoming.sessionBinding === current.sessionBinding
  ) {
    return false;
  }

  await useAuthStore.getState().clearForExternalAuthBoundary();
  reload();
  return true;
}
