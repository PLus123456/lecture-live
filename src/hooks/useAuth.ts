'use client';

import { useCallback } from 'react';
import {
  AUTH_PERSIST_STORAGE_KEY,
  getAuthBoundarySnapshot,
  isAuthBoundaryCurrent,
  isPersistedAuthBoundaryCurrent,
  useAuthStore,
  type AuthBoundarySnapshot,
} from '@/stores/authStore';
import { AUTH_SESSION_BINDING_HEADER } from '@/lib/authProtocol';
import {
  clearPendingAuthRevocation,
  consumeAuthMutationJson,
  getPendingAuthRevocation,
  getPendingAuthRevocations,
  parseAuthMutationSession,
  rememberPendingAuthRevocation,
  revokeUncommittedAuthSession,
  runAuthBoundaryCommit,
  runAuthCookieMutation,
} from '@/lib/clientAuthCookieMutation';
import { parsePersistedAuthBoundary } from '@/lib/clientAuthStorageBoundary';

interface RestoreResult {
  ok: boolean;
  stale?: boolean;
  unavailable?: boolean;
}

export type RestoreSessionResult =
  | 'restored'
  | 'invalid'
  | 'unavailable'
  | 'stale';

export interface LogoutResult {
  /** true 仅表示服务端已确认该 family 的持久撤销；本机状态无论如何都会先清理。 */
  durableRevocation: boolean;
  status: number | null;
  pendingRevocation: boolean;
}

interface AuthMutationResponse {
  sessionBinding?: unknown;
  error?: string;
  verificationRequired?: boolean;
  email?: string;
  message?: string;
  emailSendFailed?: boolean;
  needsVerification?: boolean;
  user?: unknown;
  token?: unknown;
}

function readPersistedSessionBinding(): string | null {
  try {
    return parsePersistedAuthBoundary(
      localStorage.getItem(AUTH_PERSIST_STORAGE_KEY)
    ).sessionBinding;
  } catch {
    return null;
  }
}

function requestDurableLogout(sessionBinding: string): Promise<Response> {
  return fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: {
      [AUTH_SESSION_BINDING_HEADER]: sessionBinding,
    },
  });
}

let inTabRefresh: {
  epoch: number;
  promise: Promise<RestoreResult>;
} | null = null;

/** 同 Tab 合并 + 跨 Tab Web Lock，避免共享 cookie 的同一 refresh 叶子并发触发 reuse 撤族。 */
function requestSessionRefresh(
  expected: AuthBoundarySnapshot
): Promise<RestoreResult> {
  if (inTabRefresh?.epoch === expected.epoch) return inTabRefresh.promise;

  const request = async (): Promise<RestoreResult> => {
    if (!isPersistedAuthBoundaryCurrent(expected)) {
      return isAuthBoundaryCurrent(expected)
        ? { ok: false, unavailable: true }
        : { ok: false, stale: true };
    }
    let res: Response;
    try {
      res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: expected.sessionBinding
          ? { [AUTH_SESSION_BINDING_HEADER]: expected.sessionBinding }
          : undefined,
      });
    } catch {
      return isAuthBoundaryCurrent(expected)
        ? { ok: false, unavailable: true }
        : { ok: false, stale: true };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, unavailable: true };
    }
    if (!res.ok) return { ok: false };
    const { data, sessionBinding } = await consumeAuthMutationJson<{
      user?: unknown;
      token?: unknown;
      sessionBinding?: unknown;
    }>(res, { expected });
    const session = parseAuthMutationSession(data);
    if (!session || !sessionBinding) {
      await revokeUncommittedAuthSession(sessionBinding, expected);
      return { ok: false, stale: true };
    }
    if (!isPersistedAuthBoundaryCurrent(expected)) {
      await revokeUncommittedAuthSession(sessionBinding, expected);
      return { ok: false, stale: true };
    }
    const committed = await useAuthStore.getState().setAuth(
      session.user,
      session.token,
      { expected, sessionBinding }
    );
    if (!committed) {
      await revokeUncommittedAuthSession(sessionBinding, expected);
      return { ok: false, stale: true };
    }
    return { ok: true };
  };

  const entry = {
    epoch: expected.epoch,
    promise: runAuthCookieMutation(request),
  };
  entry.promise = entry.promise.finally(() => {
    if (inTabRefresh === entry) inTabRefresh = null;
  });
  inTabRefresh = entry;
  return entry.promise;
}

export function useAuth() {
  const {
    user,
    token,
    quotas,
    sessionChecked,
    setAuth,
    setQuotas,
    logout: clearStore,
  } = useAuthStore();

  const registerUser = useCallback(
    async (email: string, password: string, displayName: string) => {
      const expected = getAuthBoundarySnapshot();
      return runAuthCookieMutation(async () => {
        if (!isPersistedAuthBoundaryCurrent(expected)) {
          throw new DOMException('Stale auth request', 'AbortError');
        }
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, displayName }),
        });
        const { data, sessionBinding } =
          await consumeAuthMutationJson<AuthMutationResponse>(res, { expected });
        if (!res.ok) {
          throw new Error(data.error || 'Registration failed');
        }
        // 开启邮箱验证硬门禁时，注册不返回会话——不要 setAuth，交回给页面进入「去邮箱验证」态。
        if (data.verificationRequired) {
          if (!isPersistedAuthBoundaryCurrent(expected)) {
            throw new DOMException('Stale auth response', 'AbortError');
          }
          return data as {
            verificationRequired: true;
            email: string;
            message?: string;
            emailSendFailed?: boolean;
          };
        }
        const session = parseAuthMutationSession(data);
        if (!sessionBinding || !session) {
          await revokeUncommittedAuthSession(sessionBinding, expected);
          throw new Error('Registration session binding missing');
        }
        if (!isPersistedAuthBoundaryCurrent(expected)) {
          await revokeUncommittedAuthSession(sessionBinding, expected);
          throw new DOMException('Stale auth response', 'AbortError');
        }
        const committed = await setAuth(session.user, session.token, {
          expected,
          sessionBinding,
        });
        if (!committed) {
          await revokeUncommittedAuthSession(sessionBinding, expected);
          throw new DOMException('Stale auth response', 'AbortError');
        }
        return data;
      });
    },
    [setAuth]
  );

  const loginUser = useCallback(
    async (email: string, password: string) => {
      const expected = getAuthBoundarySnapshot();
      return runAuthCookieMutation(async () => {
        if (!isPersistedAuthBoundaryCurrent(expected)) {
          throw new DOMException('Stale auth request', 'AbortError');
        }
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const { data, sessionBinding } =
          await consumeAuthMutationJson<AuthMutationResponse>(res, { expected });
        if (!res.ok) {
          const err = new Error(data.error || 'Login failed') as Error & {
            needsVerification?: boolean;
            email?: string;
          };
          if (res.status === 403 && data.needsVerification) {
            err.needsVerification = true;
            err.email = data.email;
          }
          throw err;
        }
        const session = parseAuthMutationSession(data);
        if (!sessionBinding || !session) {
          await revokeUncommittedAuthSession(sessionBinding, expected);
          throw new Error('Login session binding missing');
        }
        if (!isPersistedAuthBoundaryCurrent(expected)) {
          await revokeUncommittedAuthSession(sessionBinding, expected);
          throw new DOMException('Stale auth response', 'AbortError');
        }
        const committed = await setAuth(session.user, session.token, {
          expected,
          sessionBinding,
        });
        if (!committed) {
          await revokeUncommittedAuthSession(sessionBinding, expected);
          throw new DOMException('Stale auth response', 'AbortError');
        }
        return data;
      });
    },
    [setAuth]
  );

  /**
   * 从 HttpOnly cookie 恢复会话。
   * 页面加载时调用，如果 cookie 中有有效 JWT 则自动登录，
   * 用户无需重新输入密码。
   */
  const restoreSession = useCallback(async (): Promise<RestoreSessionResult> => {
    // 未确认撤销时必须保留当前 cookie 给 /logout 幂等重试，不能用 refresh 消费它。
    // 独立 session 路由把 invalid 导向登录页，由登录页展示明确的撤销重试入口。
    if (getPendingAuthRevocation()) {
      const pendingExpected = getAuthBoundarySnapshot();
      await clearStore({ expected: pendingExpected });
      return 'invalid';
    }
    const expected = getAuthBoundarySnapshot();
    try {
      const result = await requestSessionRefresh(expected);
      if (result.ok) return 'restored';
      if (result.stale) return 'stale';
      if (result.unavailable) return 'unavailable';
    } catch {
      if (!isAuthBoundaryCurrent(expected)) return 'stale';
      return 'unavailable';
    }
    const cleared = await clearStore({ expected });
    return cleared ? 'invalid' : 'stale';
  }, [clearStore]);

  /**
   * 安全登出：清除服务端 cookie + 清除客户端 store + 清除 localStorage
   * 多层防御确保退出后不会自动恢复会话
   */
  const logout = useCallback(async (): Promise<LogoutResult> => {
    const invocationBoundary = getAuthBoundarySnapshot();
    const invocationBinding = invocationBoundary.sessionBinding;

    // Stage A before waiting for a B login/refresh that may already own the
    // cookie-mutation lock. Pending state is a set, so B compensation can never
    // overwrite and erase A. The request is safe to start immediately because
    // /logout never writes/clears cookies; the signed binding is revoke-only.
    if (invocationBinding) {
      rememberPendingAuthRevocation(invocationBinding);
    }
    const fastAttempt = invocationBinding
      ? requestDurableLogout(invocationBinding).catch(() => null)
      : Promise.resolve<Response | null>(null);

    return runAuthCookieMutation(
      async () => {
        // A cookie writer may have committed B while this logout waited. Revoke
        // both the invocation family and every current/persisted/pending family,
        // then establish one anonymous account boundary.
        const lockedBoundary = getAuthBoundarySnapshot();
        const persistedBinding = readPersistedSessionBinding();
        const targets = Array.from(
          new Set(
            [
              ...getPendingAuthRevocations(),
              invocationBinding,
              lockedBoundary.sessionBinding,
              persistedBinding,
            ].filter((value): value is string => Boolean(value))
          )
        );
        for (const binding of targets) {
          rememberPendingAuthRevocation(binding);
        }

        const localCleanup = clearStore();
        const results = await Promise.allSettled(
          targets.map(async (binding) => {
            const response =
              binding === invocationBinding
                ? await fastAttempt
                : await requestDurableLogout(binding).catch(() => null);
            if (response?.ok) {
              clearPendingAuthRevocation(binding);
            }
            return response;
          })
        );
        await localCleanup;

        const responses = results.map((result) =>
          result.status === 'fulfilled' ? result.value : null
        );
        const firstFailure = responses.find((response) => !response?.ok);
        const pendingRevocation = getPendingAuthRevocations().length > 0;
        return {
          durableRevocation:
            targets.length === 0
              ? invocationBoundary.userId === null
              : !pendingRevocation && responses.every((response) => response?.ok),
          status:
            firstFailure?.status ??
            responses.find((response) => response?.ok)?.status ??
            null,
          pendingRevocation,
        };
      },
      { allowPendingRevocation: true }
    );
  }, [clearStore]);

  const fetchQuotas = useCallback(async () => {
    if (!token) return;
    const expected = getAuthBoundarySnapshot();
    const res = await fetch('/api/users/quota', {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      await runAuthBoundaryCommit(expected, () => {
        setQuotas(data.quotas, { expected });
      });
    }
  }, [token, setQuotas]);

  const authHeaders = useCallback((): Record<string, string> => {
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }, [token]);

  return {
    user,
    token,
    quotas,
    sessionChecked,
    hasPendingLogout: getPendingAuthRevocation() !== null,
    isLoggedIn: !!user && !!token,
    registerUser,
    loginUser,
    restoreSession,
    logout,
    fetchQuotas,
    authHeaders,
  };
}
