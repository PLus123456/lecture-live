'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { User, UserQuotas } from '@/types/user';
import { clearAccountBoundClientState } from '@/lib/clientAccountCleanup';

let authBoundaryEpoch = 0;
let authBoundaryAbortController = new AbortController();
let authBoundaryBarrier: Promise<void> = Promise.resolve();
let suppressAuthPersistence = false;
export const AUTH_PERSIST_STORAGE_KEY = 'lecture-live-auth';

export interface AuthBoundarySnapshot {
  epoch: number;
  userId: string | null;
  sessionBinding: string | null;
}

interface AuthMutationOptions {
  expected?: AuthBoundarySnapshot;
}

interface SetAuthOptions extends AuthMutationOptions {
  sessionBinding?: string | null;
}

interface AuthStore {
  user: User | null;
  token: string | null;
  /** token family 的非授权型哈希绑定，用于防止延迟 logout 命中新 cookie及跨 Tab 切换。 */
  sessionBinding: string | null;
  /** 每次主体/session 边界单调递增；异步请求只能提交到其发起时的 epoch。 */
  authEpoch: number;
  quotas: UserQuotas | null;
  /** 标记是否已尝试过从 cookie 恢复会话 */
  sessionChecked: boolean;

  setAuth: (user: User, token: string, options?: SetAuthOptions) => Promise<boolean>;
  adoptSessionBinding: (
    sessionBinding: string,
    options?: AuthMutationOptions
  ) => boolean;
  setQuotas: (
    quotas: UserQuotas,
    options?: AuthMutationOptions
  ) => boolean;
  setSessionChecked: (checked: boolean) => void;
  logout: (options?: AuthMutationOptions) => Promise<boolean>;
  clearForExternalAuthBoundary: () => Promise<void>;
  isLoggedIn: () => boolean;
}

function rotateBoundaryAbortSignal() {
  authBoundaryAbortController.abort();
  authBoundaryAbortController = new AbortController();
}

function queueBoundary<T>(work: () => Promise<T>): Promise<T> {
  const run = authBoundaryBarrier.then(work, work);
  authBoundaryBarrier = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function clearBoundaryStateTwice(): Promise<boolean> {
  // 第一轮同步清 store/abort 任务并等待 IDB/cache；第二轮清掉第一轮等待窗口中已经
  // 排队的旧主体回写。fetch epoch/signal 同时阻止之后才到达的旧响应继续提交。
  let finalPassSucceeded = false;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      await clearAccountBoundClientState();
      finalPassSucceeded = true;
    } catch {
      // 仍执行下一轮同步清扫，但只有最后一轮能证明等待窗口中的旧写入也已清除。
      finalPassSucceeded = false;
    }
  }
  return finalPassSucceeded;
}

function availableLocalStorage(): Storage | null {
  try {
    if (
      typeof localStorage === 'undefined' ||
      typeof localStorage.getItem !== 'function' ||
      typeof localStorage.setItem !== 'function' ||
      typeof localStorage.removeItem !== 'function'
    ) {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

const authPersistStorage = createJSONStorage(() => ({
  getItem: (name: string) => availableLocalStorage()?.getItem(name) ?? null,
  setItem: (name: string, value: string) => {
    if (!suppressAuthPersistence) availableLocalStorage()?.setItem(name, value);
  },
  removeItem: (name: string) => {
    if (!suppressAuthPersistence) availableLocalStorage()?.removeItem(name);
  },
}));

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      sessionBinding: null,
      authEpoch: authBoundaryEpoch,
      quotas: null,
      sessionChecked: false,

      setAuth: async (user, token, options) => {
        if (options?.expected && !isAuthBoundaryCurrent(options.expected)) {
          return false;
        }

        const current = get();
        const nextBinding =
          options?.sessionBinding !== undefined
            ? options.sessionBinding
            : current.user?.id === user.id
              ? current.sessionBinding
              : null;
        const boundaryChanged =
          current.user?.id !== user.id ||
          current.sessionBinding !== nextBinding;

        if (!boundaryChanged) {
          set({ user, token, sessionChecked: true });
          return true;
        }

        authBoundaryEpoch += 1;
        const boundaryEpoch = authBoundaryEpoch;
        rotateBoundaryAbortSignal();
        // 必须在任何 await 前先匿名化；旧主体不能在 IDB/cache 清理窗口继续显示或发请求。
        set({
          user: null,
          token: null,
          sessionBinding: null,
          authEpoch: boundaryEpoch,
          quotas: null,
          // 这是“已验证的新主体正在做 account cleanup”的过渡态，不是显式匿名。
          // 保持 false，避免 AuthGuard/独立 session 页在 setAuth commit 前误跳 /login。
          sessionChecked: false,
        });

        return queueBoundary(async () => {
          if (!(await clearBoundaryStateTwice())) return false;
          if (authBoundaryEpoch !== boundaryEpoch) return false;
          set({
            user,
            token,
            sessionBinding: nextBinding,
            authEpoch: boundaryEpoch,
            quotas: null,
            sessionChecked: true,
          });
          return true;
        });
      },

      adoptSessionBinding: (sessionBinding, options) => {
        if (!sessionBinding || !get().user) return false;
        if (options?.expected && !isAuthBoundaryCurrent(options.expected)) {
          return false;
        }
        if (get().sessionBinding === sessionBinding) return true;

        authBoundaryEpoch += 1;
        rotateBoundaryAbortSignal();
        // 同一账号改密后换了 family：数据主体不变，无需清业务 store，但必须让旧 family
        // 发起的请求失去提交资格，并让后续 logout 绑定到新 family。
        set({ sessionBinding, authEpoch: authBoundaryEpoch });
        return true;
      },

      // featureFlags 仅由 /api/users/quota 附带；其他来源（如同传扣费）更新配额时不带此字段，
      // 合并时保留上一次的 featureFlags，避免功能开关被临时清空导致 UI 闪烁。
      setQuotas: (quotas, options) => {
        if (
          options?.expected &&
          !isPersistedAuthBoundaryCurrent(options.expected)
        ) {
          return false;
        }
        set((state) => ({
          quotas: {
            ...quotas,
            featureFlags: quotas.featureFlags ?? state.quotas?.featureFlags,
          },
        }));
        return true;
      },

      setSessionChecked: (checked) => set({ sessionChecked: checked }),

      logout: async (options) => {
        if (options?.expected && !isAuthBoundaryCurrent(options.expected)) {
          return false;
        }

        authBoundaryEpoch += 1;
        const boundaryEpoch = authBoundaryEpoch;
        rotateBoundaryAbortSignal();
        set({
          user: null,
          token: null,
          sessionBinding: null,
          authEpoch: boundaryEpoch,
          quotas: null,
          sessionChecked: true,
        });

        await queueBoundary(async () => {
          try {
            await clearBoundaryStateTwice();
          } finally {
            if (authBoundaryEpoch === boundaryEpoch) {
              await useAuthStore.persist.clearStorage();
            }
          }
        });
        return authBoundaryEpoch === boundaryEpoch;
      },

      clearForExternalAuthBoundary: async () => {
        authBoundaryEpoch += 1;
        const boundaryEpoch = authBoundaryEpoch;
        rotateBoundaryAbortSignal();

        // storage event 的 newValue 已是另一 Tab 写入的新主体。这里只清当前 Tab 内存，绝不能
        // 把 null 再写回 localStorage 覆盖新主体；reload 会从新值和最新 cookie 重建。
        suppressAuthPersistence = true;
        try {
          set({
            user: null,
            token: null,
            sessionBinding: null,
            authEpoch: boundaryEpoch,
            quotas: null,
            sessionChecked: true,
          });
        } finally {
          suppressAuthPersistence = false;
        }

        const cleared = await queueBoundary(clearBoundaryStateTwice);
        if (!cleared) {
          throw new Error('External account boundary cleanup failed');
        }
      },

      isLoggedIn: () => get().token !== null && get().user !== null,
    }),
    {
      name: AUTH_PERSIST_STORAGE_KEY,
      storage: authPersistStorage,
      // 仅持久化非敏感状态；token 只保存在内存，页面刷新后通过 HttpOnly cookie 恢复会话。
      // sessionChecked 不持久化，每次页面加载都重新检查。
      partialize: (state) => ({
        user: state.user,
        sessionBinding: state.sessionBinding,
        quotas: state.quotas,
      }),
    }
  )
);

export function getAuthBoundarySnapshot(): AuthBoundarySnapshot {
  const state = useAuthStore.getState();
  return {
    epoch: authBoundaryEpoch,
    userId: state.user?.id ?? null,
    sessionBinding: state.sessionBinding,
  };
}

export function isAuthBoundaryCurrent(
  snapshot: AuthBoundarySnapshot
): boolean {
  const state = useAuthStore.getState();
  return (
    snapshot.epoch === authBoundaryEpoch &&
    snapshot.userId === (state.user?.id ?? null) &&
    snapshot.sessionBinding === state.sessionBinding
  );
}

/**
 * Web Lock 内再次核对跨 Tab 共享的持久主体。storage 事件是异步派发的，另一个 Tab
 * 即使尚未更新内存，也不能拿旧 expected 发出会写 HttpOnly cookie 的请求。
 */
export function isPersistedAuthBoundaryCurrent(
  snapshot: AuthBoundarySnapshot
): boolean {
  if (!isAuthBoundaryCurrent(snapshot)) return false;
  try {
    const raw = localStorage.getItem(AUTH_PERSIST_STORAGE_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as {
          state?: {
            user?: { id?: unknown } | null;
            sessionBinding?: unknown;
          };
        })
      : null;
    const persistedUserId =
      typeof parsed?.state?.user?.id === 'string'
        ? parsed.state.user.id
        : null;
    const persistedBinding =
      typeof parsed?.state?.sessionBinding === 'string'
        ? parsed.state.sessionBinding
        : null;
    return (
      persistedUserId === snapshot.userId &&
      persistedBinding === snapshot.sessionBinding
    );
  } catch {
    // 无法读取共享边界时不能安全协调跨 Tab Set-Cookie 顺序。
    return false;
  }
}

export function getAuthBoundaryAbortSignal(): AbortSignal {
  return authBoundaryAbortController.signal;
}

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
