'use client';

import { useCallback } from 'react';
import { useAuthStore } from '@/stores/authStore';

export function useAuth() {
  const { user, token, quotas, sessionChecked, setAuth, setQuotas, setSessionChecked, logout: clearStore } = useAuthStore();

  const registerUser = useCallback(
    async (email: string, password: string, displayName: string) => {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Registration failed');
      }
      const data = await res.json();
      setAuth(data.user, data.token);
      return data;
    },
    [setAuth]
  );

  const loginUser = useCallback(
    async (email: string, password: string) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Login failed');
      }
      const data = await res.json();
      setAuth(data.user, data.token);
      return data;
    },
    [setAuth]
  );

  /**
   * 从 HttpOnly cookie 恢复会话。
   * 页面加载时调用，如果 cookie 中有有效 JWT 则自动登录，
   * 用户无需重新输入密码。
   */
  const restoreSession = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'GET',
        credentials: 'include', // 携带 HttpOnly cookie
      });
      if (res.ok) {
        const data = await res.json();
        setAuth(data.user, data.token);
        return true;
      }
    } catch {
      // cookie 无效或过期，静默失败
    }
    setSessionChecked(true);
    return false;
  }, [setAuth, setSessionChecked]);

  /**
   * 安全登出：清除服务端 cookie + 清除客户端 store + 清除 localStorage
   * 多层防御确保退出后不会自动恢复会话
   */
  const logout = useCallback(async () => {
    // 1. 先清除客户端 store（立即阻止后续请求携带 token）
    clearStore();

    // 2. 显式清除 localStorage 中 persist 的数据，防止刷新后恢复
    try {
      localStorage.removeItem('lecture-live-auth');
    } catch {
      // SSR 或 localStorage 不可用时忽略
    }

    // 3. 调用服务端清除 HttpOnly cookie
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // 即使请求失败，客户端状态已经清除
    }
  }, [clearStore]);

  const fetchQuotas = useCallback(async () => {
    if (!token) return;
    const res = await fetch('/api/users/quota', {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      setQuotas(data.quotas);
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
    isLoggedIn: !!user && !!token,
    registerUser,
    loginUser,
    restoreSession,
    logout,
    fetchQuotas,
    authHeaders,
  };
}
