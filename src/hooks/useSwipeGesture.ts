'use client';

import { useCallback, useRef } from 'react';

interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeDown?: () => void;
  threshold?: number;
}

/**
 * 横向/下滑手势。返回一个**稳定的 callback ref**，挂到目标元素上即可：
 *
 * ```tsx
 * const swipeRef = useSwipeGesture({ onSwipeLeft, onSwipeRight, threshold: 60 });
 * return <div ref={swipeRef}>…</div>;
 * ```
 *
 * 为什么不再接收 RefObject + 依赖回调的 effect（审计 medium）：
 * 1. 调用方几乎都传内联回调，每次父组件重渲染 effect 都会拆掉重挂监听器，触点起点
 *    （effect 内的局部变量）随之被重置为 (0,0)。回放页播放时每 100ms、录音页每秒都在重渲染，
 *    手势只要跨过一次重渲染，终点就被拿去和 (0,0) 比：竖向滚动被误判成右滑（切 Tab，
 *    ChatTab 被卸载、草稿丢失）或下滑（BottomSheet 被关掉）。
 * 2. effect 只在依赖变化时读 ref.current：元素晚于首个 effect 才挂载（BottomSheet 打开时）
 *    且回调引用稳定时，监听器永远挂不上。
 *
 * 现在：回调与阈值存 ref（监听器里总读最新值）；监听器按元素挂一次、元素卸载时摘掉；
 * 触点状态属于这次挂载，与组件重渲染无关。
 */
export function useSwipeGesture<T extends HTMLElement = HTMLElement>(
  options: SwipeOptions
): (element: T | null) => void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const detachRef = useRef<(() => void) | null>(null);

  return useCallback((element: T | null) => {
    detachRef.current?.();
    detachRef.current = null;
    if (!element) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let endX = 0;
    let endY = 0;
    let tracking = false;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      tracking = true;
      startX = touch.clientX;
      startY = touch.clientY;
      endX = touch.clientX;
      endY = touch.clientY;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking) {
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      endX = touch.clientX;
      endY = touch.clientY;
    };

    const handleTouchCancel = () => {
      tracking = false;
    };

    const handleTouchEnd = () => {
      if (!tracking) {
        return;
      }
      tracking = false;

      const { onSwipeLeft, onSwipeRight, onSwipeDown, threshold = 50 } = optionsRef.current;
      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (absX < threshold && absY < threshold) {
        return;
      }

      if (absX > absY) {
        if (deltaX <= -threshold) {
          onSwipeLeft?.();
          return;
        }

        if (deltaX >= threshold) {
          onSwipeRight?.();
        }
        return;
      }

      if (deltaY >= threshold) {
        onSwipeDown?.();
      }
    };

    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchmove', handleTouchMove, { passive: true });
    element.addEventListener('touchend', handleTouchEnd, { passive: true });
    element.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    detachRef.current = () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
      element.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, []);
}
