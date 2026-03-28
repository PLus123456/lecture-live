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
import { useAuthStore } from '@/stores/authStore';

// 不需要拦截 401 的路径（认证相关接口本身会返回 401，属于正常流程）
const AUTH_API_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
];

// 不需要跳转的页面路径（已经在登录/注册等公开页面上）
const PUBLIC_PAGES = ['/login', '/register', '/setup', '/privacy', '/terms'];

export default function AuthSessionMonitor() {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const isRedirectingRef = useRef(false);

  // 保持 pathname 最新
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const originalFetch = window.fetch;

    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const response = await originalFetch.apply(this, args);

      // 只拦截我们自己后端 API 的 401 响应
      if (response.status === 401) {
        const url = typeof args[0] === 'string'
          ? args[0]
          : args[0] instanceof Request
            ? args[0].url
            : String(args[0]);

        // 提取路径部分（兼容完整 URL 和相对路径）
        let apiPath: string;
        try {
          apiPath = new URL(url, window.location.origin).pathname;
        } catch {
          apiPath = url;
        }

        // 跳过认证相关 API（它们返回 401 是正常业务逻辑）
        const isAuthApi = AUTH_API_PATHS.some((p) => apiPath.startsWith(p));
        if (isAuthApi) return response;

        // 只拦截我们自己的 API 路由
        if (!apiPath.startsWith('/api/')) return response;

        // 当前已在公开页面，不需要跳转
        const currentPath = pathnameRef.current;
        if (PUBLIC_PAGES.some((p) => currentPath === p || currentPath.startsWith(p + '/'))) {
          return response;
        }

        // 防止多个并发请求同时触发重复跳转
        if (isRedirectingRef.current) return response;
        isRedirectingRef.current = true;

        // 清除客户端认证状态
        const store = useAuthStore.getState();
        store.logout();
        try {
          localStorage.removeItem('lecture-live-auth');
        } catch {
          // localStorage 不可用时忽略
        }

        // 跳转到登录页
        router.replace('/login');

        // 短暂延迟后重置标志，允许下次触发
        setTimeout(() => {
          isRedirectingRef.current = false;
        }, 3000);
      }

      return response;
    };

    return () => {
      // 组件卸载时恢复原始 fetch
      window.fetch = originalFetch;
    };
  }, [router]);

  return null;
}
