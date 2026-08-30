'use client';

import {
  AUTH_SESSION_BINDING_HEADER,
  CLIENT_SESSION_TOKEN,
} from '@/lib/authProtocol';
import {
  isAuthBoundaryCurrent,
  isPersistedAuthBoundaryCurrent,
  type AuthBoundarySnapshot,
} from '@/stores/authStore';
import type { User } from '@/types/user';

/** 所有可能写/清 HttpOnly auth cookie 的浏览器请求共用一个跨 Tab 排他锁。 */
export const AUTH_COOKIE_MUTATION_LOCK =
  'lecture-live-auth-cookie-mutation-v1';
export const PENDING_AUTH_REVOCATION_KEY =
  'lecture-live-pending-auth-revocation-v1';

let inTabBarrier: Promise<void> = Promise.resolve();
let inMemoryPendingRevocations = new Set<string>();
let pendingRevocationWasPersisted = false;

const MAX_PENDING_AUTH_REVOCATIONS = 64;
// Keep this aligned with AUTH_SESSION_REVOCATION_MAX_LENGTH on the server.
const MAX_AUTH_REVOCATION_CAPABILITY_LENGTH = 2_048;
const MAX_PENDING_AUTH_REVOCATIONS_STORAGE_LENGTH =
  MAX_PENDING_AUTH_REVOCATIONS *
    (MAX_AUTH_REVOCATION_CAPABILITY_LENGTH + 3);

function isValidSessionBinding(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AUTH_REVOCATION_CAPABILITY_LENGTH
  );
}

function parsePendingRevocations(value: string | null): string[] {
  if (!value) return [];
  if (
    value.startsWith('[') &&
    value.length <= MAX_PENDING_AUTH_REVOCATIONS_STORAGE_LENGTH
  ) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return Array.from(
        new Set(parsed.filter(isValidSessionBinding))
      ).slice(0, MAX_PENDING_AUTH_REVOCATIONS);
    } catch {
      return [];
    }
  }
  // Backward-compatible single-binding representation.
  return isValidSessionBinding(value) ? [value] : [];
}

function persistPendingRevocations(bindings: Iterable<string>): void {
  const values = Array.from(new Set(bindings)).filter(isValidSessionBinding);
  inMemoryPendingRevocations = new Set(values);
  try {
    if (values.length === 0) {
      localStorage.removeItem(PENDING_AUTH_REVOCATION_KEY);
      pendingRevocationWasPersisted = false;
    } else {
      // Keep the historic scalar form for one item; use JSON only when multiple
      // independently live families must survive concurrent compensation.
      localStorage.setItem(
        PENDING_AUTH_REVOCATION_KEY,
        values.length === 1 ? values[0] : JSON.stringify(values)
      );
      pendingRevocationWasPersisted = true;
    }
  } catch {
    // The in-memory set still preserves every binding for this page lifetime.
  }
}

export function getPendingAuthRevocations(): string[] {
  try {
    const stored = localStorage.getItem(PENDING_AUTH_REVOCATION_KEY);
    const parsed = parsePendingRevocations(stored);
    if (parsed.length > 0) {
      inMemoryPendingRevocations = new Set(parsed);
      pendingRevocationWasPersisted = true;
      return parsed;
    }
    if (pendingRevocationWasPersisted) {
      inMemoryPendingRevocations = new Set();
      pendingRevocationWasPersisted = false;
    }
  } catch {
    // Session-memory fallback; a read failure cannot erase known pending families.
  }
  return Array.from(inMemoryPendingRevocations);
}

export function getPendingAuthRevocation(): string | null {
  return getPendingAuthRevocations()[0] ?? null;
}

export function rememberPendingAuthRevocation(sessionBinding: string): void {
  if (!isValidSessionBinding(sessionBinding)) return;
  try {
    const persisted = parsePendingRevocations(
      localStorage.getItem(PENDING_AUTH_REVOCATION_KEY)
    );
    persistPendingRevocations([
      ...inMemoryPendingRevocations,
      ...persisted,
      sessionBinding,
    ]);
  } catch {
    persistPendingRevocations([...inMemoryPendingRevocations, sessionBinding]);
  }
}

export function clearPendingAuthRevocation(sessionBinding: string): void {
  try {
    const persisted = parsePendingRevocations(
      localStorage.getItem(PENDING_AUTH_REVOCATION_KEY)
    );
    const remaining = new Set([
      ...inMemoryPendingRevocations,
      ...persisted,
    ]);
    remaining.delete(sessionBinding);
    persistPendingRevocations(remaining);
  } catch {
    inMemoryPendingRevocations.delete(sessionBinding);
  }
}

/**
 * 串行执行 auth-cookie mutation 请求。
 *
 * 服务端的 Set-Cookie 在 fetch resolve 前就由浏览器应用，客户端无法在响应到达后再做
 * epoch 校验撤回。因此 login/register/verify/setup/change-password/refresh 必须连“发请求”
 * 本身一起排他：旧 A 响应先完成，新 B 请求后发送，最终 cookie 必然属于 B。Web Locks
 * 覆盖同源多 Tab；不支持它的浏览器至少保留同 Tab 串行语义。
 */
export function runAuthCookieMutation<T>(
  operation: () => Promise<T>,
  options?: { allowPendingRevocation?: boolean }
): Promise<T> {
  const guardedOperation = () => {
    if (!options?.allowPendingRevocation && getPendingAuthRevocation()) {
      throw new Error('Pending logout revocation must be retried');
    }
    return operation();
  };
  const run = async (): Promise<T> => {
    const lockManager =
      typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (lockManager) {
      return lockManager.request(
        AUTH_COOKIE_MUTATION_LOCK,
        { mode: 'exclusive' },
        guardedOperation
      );
    }
    return guardedOperation();
  };

  const result = inTabBarrier.then(run, run);
  inTabBarrier = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Keep an ordinary same-origin API request from being sent while an auth
 * response may already have changed the HttpOnly cookie but has not committed
 * its account boundary yet. Readers only need to hold the shared lock through
 * response headers; the existing epoch/body guards contain later body writes.
 *
 * Without Web Locks we conservatively serialize readers with writers in this
 * tab. Cross-tab atomicity requires Web Locks, which is the same primitive used
 * by the cookie mutation protocol.
 */
export async function runAuthCookieRead<T>(
  operation: () => Promise<T>
): Promise<T> {
  const lockManager =
    typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (lockManager) {
    return lockManager.request(
      AUTH_COOKIE_MUTATION_LOCK,
      { mode: 'shared' },
      operation
    );
  }

  const result = inTabBarrier.then(operation, operation);
  inTabBarrier = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export type AuthBoundaryCommitResult<T> =
  | { committed: true; value: T }
  | { committed: false };

/**
 * Atomically validate an operation's original account owner and perform its
 * synchronous global/persisted-store sink under the cookie protocol's shared
 * lock. The callback must not await; long work belongs before this final
 * commit so account switching is never blocked on application I/O.
 */
export function runAuthBoundaryCommit<T>(
  expected: AuthBoundarySnapshot,
  commit: () => T
): Promise<AuthBoundaryCommitResult<T>> {
  return runAuthCookieRead(async () => {
    if (
      !isAuthBoundaryCurrent(expected) ||
      !isPersistedAuthBoundaryCurrent(expected)
    ) {
      return { committed: false };
    }
    return { committed: true, value: commit() };
  });
}

/**
 * Set-Cookie 已到达、但主体 commit 因 epoch/shared boundary 变化被拒绝时的补偿撤销。
 * 调用方仍持有全局 cookie mutation lock，所以此请求看到的就是刚写入且尚未被后继覆盖
 * 的 family。logout 路由自身不写 cookie，不会引入新的 response-order 竞态。
 */
export async function revokeUncommittedAuthSession(
  sessionBinding: string | null,
  expected?: AuthBoundarySnapshot
): Promise<boolean> {
  let revoked = false;
  if (sessionBinding) {
    rememberPendingAuthRevocation(sessionBinding);
  }
  try {
    if (sessionBinding) {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { [AUTH_SESSION_BINDING_HEADER]: sessionBinding },
      });
      revoked = response.ok;
      if (revoked) clearPendingAuthRevocation(sessionBinding);
    }
  } catch {
    revoked = false;
  }

  // 浏览器已经应用了新 cookie，但该主体没有完成客户端 commit。即使服务端补偿撤销成功，
  // 旧 store 也已不再与 cookie 对应；撤销失败时更绝不能继续显示/写回旧账号 A。
  // 动态导入避免 authStore -> cleanup 与本模块形成运行时循环。expected 已过期时 logout
  // 会拒绝清理，因此不会误伤已经提交的新主体 B。
  const { useAuthStore } = await import('@/stores/authStore');
  await useAuthStore.getState().logout(expected ? { expected } : undefined);
  return revoked;
}

export interface AuthMutationSession {
  user: User;
  token: string;
}

/** 对成功签发会话的响应做运行时结构校验，避免合法 `{}` 走到 setAuth 后才抛错。 */
export function parseAuthMutationSession(
  value: unknown
): AuthMutationSession | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    user?: unknown;
    token?: unknown;
  };
  if (!candidate.user || typeof candidate.user !== 'object') return null;
  const user = candidate.user as Record<string, unknown>;
  if (
    typeof user.id !== 'string' ||
    !user.id ||
    typeof user.email !== 'string' ||
    !user.email ||
    typeof user.displayName !== 'string' ||
    !['ADMIN', 'PRO', 'FREE'].includes(String(user.role)) ||
    candidate.token !== CLIENT_SESSION_TOKEN
  ) {
    return null;
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role as User['role'],
      // 现有 auth routes 不返回 createdAt；保持 User 契约且不信任任意非字符串值。
      createdAt: typeof user.createdAt === 'string' ? user.createdAt : '',
    },
    token: candidate.token,
  };
}

/**
 * 在全局 cookie lock 内消费认证响应 JSON，并优先信任由签名 JWT 派生的稳定响应头。
 * 2xx body 截断、缺字段或 header/body binding 不一致时，先撤销浏览器刚应用的 family。
 */
export async function consumeAuthMutationJson<T extends {
  sessionBinding?: unknown;
}>(
  response: Response,
  options?: { expected?: AuthBoundarySnapshot }
): Promise<{ data: T; sessionBinding: string | null }> {
  const headerBinding =
    response.headers?.get?.(AUTH_SESSION_BINDING_HEADER) ?? null;
  let data: T;
  try {
    data = (await response.json()) as T;
  } catch (error) {
    if (response.ok) {
      await revokeUncommittedAuthSession(headerBinding, options?.expected);
    }
    throw error;
  }

  const bodyBinding =
    typeof data?.sessionBinding === 'string' ? data.sessionBinding : null;
  if (
    response.ok &&
    headerBinding &&
    bodyBinding &&
    headerBinding !== bodyBinding
  ) {
    await revokeUncommittedAuthSession(headerBinding, options?.expected);
    throw new Error('Auth session binding mismatch');
  }
  return { data, sessionBinding: headerBinding ?? bodyBinding };
}
