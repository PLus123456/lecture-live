'use client';

import { type RefObject, useEffect } from 'react';

interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeDown?: () => void;
  threshold?: number;
}

export function useSwipeGesture(
  ref: RefObject<HTMLElement>,
  options: SwipeOptions
): void {
  const { onSwipeLeft, onSwipeRight, onSwipeDown, threshold = 50 } = options;

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let endX = 0;
    let endY = 0;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      startX = touch.clientX;
      startY = touch.clientY;
      endX = touch.clientX;
      endY = touch.clientY;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      endX = touch.clientX;
      endY = touch.clientY;
    };

    const handleTouchEnd = () => {
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

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
    };
  }, [onSwipeDown, onSwipeLeft, onSwipeRight, ref, threshold]);
}
