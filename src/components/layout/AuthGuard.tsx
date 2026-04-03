'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { isAuthHydrated, useAuthStore } from '@/stores/authStore';

/**
 * 订阅 Zustand persist 水合状态，避免水合期间闪烁 loading。
 * useSyncExternalStore 保证 React 18 并发安全。
 */
function useHydrated() {
  return useSyncExternalStore(
    (onStoreChange) => {
      // 如果已经水合完成，无需订阅
      if (isAuthHydrated()) return () => {};
      // 利用 onFinishHydration 监听水合完成
      const unsub = useAuthStore.persist.onFinishHydration(onStoreChange);
      return unsub;
    },
    () => isAuthHydrated(),   // client
    () => false               // server（SSR 时永远未水合）
  );
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, token, sessionChecked, restoreSession } = useAuth();
  const restoreAttempted = useRef(false);
  const hydrated = useHydrated();

  useEffect(() => {
    // 水合未完成，等待 localStorage 数据加载
    if (!hydrated) return;

    // store 里已经有 user/token（来自 localStorage 水合），无需恢复
    if (user && token) return;

    // 尝试从 HttpOnly cookie 恢复会话
    if (!restoreAttempted.current) {
      restoreAttempted.current = true;
      restoreSession().then((restored) => {
        if (!restored) {
          router.replace('/login');
        }
      });
      return;
    }

    // 已经尝试过恢复但失败了
    if (sessionChecked && (!user || !token)) {
      router.replace('/login');
    }
  }, [hydrated, user, token, sessionChecked, restoreSession, router]);

  // 水合完成且 localStorage 有缓存 → 直接渲染，不阻塞
  if (hydrated && user && token) {
    return <>{children}</>;
  }

  // 水合中 或 正在从 cookie 恢复 → 显示骨架屏
  return (
    <div className="min-h-[100dvh] bg-cream-50">
      <div className="animate-pulse">
        {/* 侧边栏骨架 */}
        <div className="fixed left-0 top-0 h-full w-56 bg-white border-r border-cream-200">
          <div className="h-16 border-b border-cream-200 px-3 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cream-200" />
            <div className="space-y-1.5 flex-1">
              <div className="h-3 bg-cream-200 rounded w-20" />
              <div className="h-2 bg-cream-100 rounded w-16" />
            </div>
          </div>
          <div className="p-2 space-y-1 mt-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-cream-100 rounded-lg" />
            ))}
          </div>
        </div>
        {/* 主内容骨架 */}
        <div className="ml-56 px-8 pt-8">
          <div className="h-6 bg-cream-200 rounded w-48 mb-2" />
          <div className="h-10 bg-cream-200 rounded w-72 mb-1.5" />
          <div className="h-4 bg-cream-100 rounded w-56 mb-6" />
          <div className="h-10 bg-cream-100 rounded-xl w-full mb-4" />
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-16 bg-cream-100 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
