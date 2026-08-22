'use client';

/**
 * 全局认证会话监控器
 *
 * 拦截所有 fetch 请求的响应，当检测到后端 API 返回 401 时，
 * 自动清除登录态并跳转到登录页面。
 *
 * 放在根 layout 的 ClientProviders 中，全局生效，
 * 无需在每个页面单独处理 token 过期的情况。
 */

import { useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  type AuthBoundarySnapshot,
  getAuthBoundaryAbortSignal,
  getAuthBoundarySnapshot,
  isAuthBoundaryCurrent,
  isPersistedAuthBoundaryCurrent,
  useAuthStore,
} from '@/stores/authStore';
import { AUTH_SESSION_BINDING_HEADER } from '@/lib/authProtocol';
import {
  clearPendingAuthRevocation,
  rememberPendingAuthRevocation,
  runAuthCookieMutation,
  runAuthCookieRead,
} from '@/lib/clientAuthCookieMutation';
import { toast } from '@/stores/toastStore';
import { useI18n } from '@/lib/i18n';

// 不需要拦截 401 的路径（认证相关接口本身会返回 401，属于正常流程）
const AUTH_API_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
];

// 这些调用方自己用全局 auth-cookie lock 持有 fetch + body + boundary commit，并能从
// 稳定响应头补偿撤销。全局 monitor 不能先 abort/丢弃其 Response，否则 Set-Cookie 已由
// 浏览器应用、调用方却拿不到 binding 做 containment。
const AUTH_COOKIE_MUTATION_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/change-password',
  '/api/auth/verify-email',
  '/api/setup',
];

// 不需要跳转的页面路径（已经在登录/注册等公开页面上）
const PUBLIC_PAGES = ['/login', '/register', '/setup', '/privacy', '/terms'];

function abortError() {
  return new DOMException('Auth boundary changed', 'AbortError');
}

function requestApiPath(input: RequestInfo | URL): string | null {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof Request
        ? input.url
        : input.toString();
  try {
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/')
      ? url.pathname
      : null;
  } catch {
    return raw.startsWith('/api/') ? raw.split(/[?#]/, 1)[0] : null;
  }
}

function withAuthBoundarySignal(
  args: Parameters<typeof fetch>,
  boundarySignal: AbortSignal
): Parameters<typeof fetch> {
  const inputSignal =
    args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined);
  let signal = boundarySignal;
  if (inputSignal) {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([inputSignal, boundarySignal]);
    } else {
      const controller = new AbortController();
      const abort = () => controller.abort();
      inputSignal.addEventListener('abort', abort, { once: true });
      boundarySignal.addEventListener('abort', abort, { once: true });
      if (inputSignal.aborted || boundarySignal.aborted) abort();
      signal = controller.signal;
    }
  }
  return [args[0], { ...args[1], signal }];
}

function guardResponseConsumption(
  response: Response,
  boundary: AuthBoundarySnapshot
): Response {
  const assertCurrent = () => {
    if (
      !isAuthBoundaryCurrent(boundary) ||
      !isPersistedAuthBoundaryCurrent(boundary)
    ) {
      throw abortError();
    }
  };
  const json = response.json.bind(response);
  const text = response.text.bind(response);
  const blob = response.blob.bind(response);
  const arrayBuffer = response.arrayBuffer.bind(response);
  const formData = response.formData.bind(response);
  response.json = async () => {
    assertCurrent();
    const value = await json();
    assertCurrent();
    return value;
  };
  response.text = async () => {
    assertCurrent();
    const value = await text();
    assertCurrent();
    return value;
  };
  response.blob = async () => {
    assertCurrent();
    const value = await blob();
    assertCurrent();
    return value;
  };
  response.arrayBuffer = async () => {
    assertCurrent();
    const value = await arrayBuffer();
    assertCurrent();
    return value;
  };
  response.formData = async () => {
    assertCurrent();
    const value = await formData();
    assertCurrent();
    return value;
  };

  // json/text 等高层方法之外，SSE/NDJSON 调用方会直接读取 response.body。底层 fetch
  // 甚至测试替身可能忽略 AbortSignal，所以每次 read 前后都重验 epoch；迟到 chunk 不能
  // 在两轮 cleanup 完成后重新创建旧账号 store slice。
  // ReadableStream 构造后可能立即自动 pull；必须等调用方真正读取 `.body` 才创建，
  // 否则普通 response.json()/clone() 之前原 body 就被 getReader() 锁死。
  let guardedBody: ReadableStream<Uint8Array> | null | undefined;
  const clone = response.clone.bind(response);
  return new Proxy(response, {
    get(target, property) {
      if (property === 'body') {
        if (guardedBody === undefined) {
          guardedBody = target.body
            ? guardReadableStream(target.body, boundary)
            : null;
        }
        return guardedBody;
      }
      if (property === 'clone') {
        return () => {
          assertCurrent();
          return guardResponseConsumption(clone(), boundary);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function guardReadableStream(
  stream: ReadableStream<Uint8Array>,
  boundary: AuthBoundarySnapshot
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const assertCurrent = () => {
    if (
      !isAuthBoundaryCurrent(boundary) ||
      !isPersistedAuthBoundaryCurrent(boundary)
    ) {
      throw abortError();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        assertCurrent();
        reader ??= stream.getReader();
        const chunk = await reader.read();
        assertCurrent();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (reader) void reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (reader) await reader.cancel(reason);
      else await stream.cancel(reason);
    },
  });
}

export default function AuthSessionMonitor() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const pathnameRef = useRef(pathname);
  const isRedirectingRef = useRef(false);

  // 保持 pathname 最新
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const originalFetch = window.fetch;

    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const apiPath = requestApiPath(args[0]);
      const isAuthCookieMutation = Boolean(
        apiPath &&
          AUTH_COOKIE_MUTATION_PATHS.some(
            (path) => apiPath === path || apiPath.startsWith(`${path}/`)
          )
      );
      // Capture intent at invocation time. A queued A action must be aborted
      // after B commits; it must never be reinterpreted and sent as a B action
      // merely because the shared lock was acquired later.
      const invocationBoundary =
        apiPath && !isAuthCookieMutation ? getAuthBoundarySnapshot() : null;
      let requestBoundary: AuthBoundarySnapshot | null = null;
      let response: Response;
      if (invocationBoundary) {
        // Auth Set-Cookie is applied when response headers arrive, before the
        // mutation caller consumes the body and commits its local boundary.
        // Hold a shared lock while sending ordinary API requests so they can
        // never observe cookie B with still-visible account A. Revalidate the
        // invocation boundary only after acquiring the lock: another Tab may
        // have committed B while this request was queued, before its storage
        // event reaches this Tab.
        const protectedResult = await runAuthCookieRead(async () => {
          if (
            !isAuthBoundaryCurrent(invocationBoundary) ||
            !isPersistedAuthBoundaryCurrent(invocationBoundary)
          ) {
            throw abortError();
          }
          const guardedArgs = withAuthBoundarySignal(
            args,
            getAuthBoundaryAbortSignal()
          );
          const protectedResponse = await originalFetch.apply(this, guardedArgs);
          if (
            !isAuthBoundaryCurrent(invocationBoundary) ||
            !isPersistedAuthBoundaryCurrent(invocationBoundary)
          ) {
            throw abortError();
          }
          return { boundary: invocationBoundary, response: protectedResponse };
        });
        requestBoundary = protectedResult.boundary;
        response = protectedResult.response;
      } else {
        response = await originalFetch.apply(this, args);
      }

      // 即使底层 fetch/mock 没遵守 AbortSignal，也不把旧 epoch 的响应交还给调用方写 store。
      if (
        requestBoundary &&
        (!isAuthBoundaryCurrent(requestBoundary) ||
          !isPersistedAuthBoundaryCurrent(requestBoundary))
      ) {
        throw abortError();
      }
      const guardedResponse = requestBoundary
        ? guardResponseConsumption(response, requestBoundary)
        : response;

      // 只拦截我们自己后端 API 的 401 响应
      if (response.status === 401 && apiPath && requestBoundary) {
        // 跳过认证相关 API（它们返回 401 是正常业务逻辑）
        const isAuthApi = AUTH_API_PATHS.some((p) => apiPath.startsWith(p));
        if (isAuthApi) return guardedResponse;

        // 当前已在公开页面，不需要跳转
        const currentPath = pathnameRef.current;
        if (PUBLIC_PAGES.some((p) => currentPath === p || currentPath.startsWith(p + '/'))) {
          return guardedResponse;
        }

        // 防止多个并发请求同时触发重复跳转
        if (isRedirectingRef.current) return guardedResponse;
        isRedirectingRef.current = true;

        // 必须先取得同一个 auth-cookie lock，再重验 A boundary，才允许匿名化/撤族。
        // 否则 B login 已收到 Set-Cookie 但尚未 commit 时，A 的迟到 401 会先推进 epoch，
        // 令 B 调用方拿不到响应 binding，随后 A logout 又会错撞 B cookie。
        const handled = await runAuthCookieMutation(
          async () => {
            if (!isPersistedAuthBoundaryCurrent(requestBoundary)) return false;
            const store = useAuthStore.getState();
            if (requestBoundary.sessionBinding) {
              rememberPendingAuthRevocation(requestBoundary.sessionBinding);
            }
            const localCleanup = store.logout({ expected: requestBoundary });
            const logoutBoundary = getAuthBoundarySnapshot();
            const logoutHeaders = requestBoundary.sessionBinding
              ? { [AUTH_SESSION_BINDING_HEADER]: requestBoundary.sessionBinding }
              : undefined;
            const [, serverLogoutResult] = await Promise.allSettled([
              localCleanup,
              // 用 originalFetch 避免递归包装；logout route 本身不写 cookie。
              originalFetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include',
                headers: logoutHeaders,
              }),
            ]);
            const serverLogoutFailed =
              serverLogoutResult.status === 'rejected' ||
              !serverLogoutResult.value.ok;
            if (!serverLogoutFailed && requestBoundary.sessionBinding) {
              clearPendingAuthRevocation(requestBoundary.sessionBinding);
            }
            if (serverLogoutFailed) {
              console.error(
                'Persistent auth-family revocation could not be confirmed after 401'
              );
              toast.error(
                t('auth.logoutIncomplete'),
                t('auth.logoutIncompleteDescription')
              );
            }

            const afterLogout = getAuthBoundarySnapshot();
            if (
              afterLogout.epoch === logoutBoundary.epoch &&
              afterLogout.userId === null
            ) {
              router.replace('/login');
            }
            return true;
          },
          { allowPendingRevocation: true }
        );

        if (!handled) {
          isRedirectingRef.current = false;
          return guardedResponse;
        }

        // 短暂延迟后重置标志，允许下次触发
        setTimeout(() => {
          isRedirectingRef.current = false;
        }, 3000);
      }

      return guardedResponse;
    };

    return () => {
      // 组件卸载时恢复原始 fetch
      window.fetch = originalFetch;
    };
  }, [router, t]);

  return null;
}
