'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, UserQuotas } from '@/types/user';

interface AuthStore {
  user: User | null;
  token: string | null;
  quotas: UserQuotas | null;
  /** 标记是否已尝试过从 cookie 恢复会话 */
  sessionChecked: boolean;

  setAuth: (user: User, token: string) => void;
  setQuotas: (quotas: UserQuotas) => void;
  setSessionChecked: (checked: boolean) => void;
  logout: () => void;
  isLoggedIn: () => boolean;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      quotas: null,
      sessionChecked: false,

      setAuth: (user, token) => set({ user, token, sessionChecked: true }),

      setQuotas: (quotas) => set({ quotas }),

      setSessionChecked: (checked) => set({ sessionChecked: checked }),

      logout: () => set({ user: null, token: null, quotas: null, sessionChecked: true }),

      isLoggedIn: () => get().token !== null && get().user !== null,
    }),
    {
      name: 'lecture-live-auth',
      // 仅持久化非敏感状态；token 只保存在内存，页面刷新后通过 HttpOnly cookie 恢复会话。
      // sessionChecked 不持久化，每次页面加载都重新检查。
      partialize: (state) => ({
        user: state.user,
        quotas: state.quotas,
      }),
    }
  )
);

/**
 * 追踪 Zustand persist 水合状态。
 * token 不持久化，页面刷新后需要依赖 /api/auth/refresh 从 HttpOnly cookie 恢复会话。
 * 用这个标志避免 AuthGuard 在水合期间误跳转到 /login。
 */
let _hydrated = false;
export const isAuthHydrated = () => _hydrated;

if (typeof window !== 'undefined') {
  // 检查水合是否已完成（getOptions 返回的 rehydrated 标志）
  // 同时注册回调以防水合尚未完成
  if (useAuthStore.persist?.hasHydrated?.()) {
    _hydrated = true;
  }
  useAuthStore.persist?.onFinishHydration?.(() => {
    _hydrated = true;
  });
}
