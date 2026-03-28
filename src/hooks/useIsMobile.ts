'use client';

import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT = 768;

/**
 * 检测是否应显示移动端布局。
 *
 * 判断逻辑（满足任一即为桌面）：
 * 1. 视口宽度 >= 768px
 * 2. 折叠屏展开状态（屏幕接近正方形且最小边 >= 480px）
 * 3. 浏览器处于「请求桌面版网站」模式
 */

/** 检测浏览器是否处于「请求桌面版网站」模式 */
function isDesktopModeRequested(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const hasTouchScreen =
    'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const hasMobileUA = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  return hasTouchScreen && !hasMobileUA && window.screen.width < 900;
}

/** 检测折叠屏展开状态 */
function isFoldableUnfolded(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window.screen.width;
  const h = window.screen.height;
  const minDim = Math.min(w, h);
  const maxDim = Math.max(w, h);
  const ratio = maxDim / minDim;
  return minDim >= 480 && ratio < 1.4;
}

function detectMobile(): boolean {
  if (typeof window === 'undefined') return false;

  // 视口宽度 >= 768 → 桌面（包含 ViewportAdapter 修改视口后的情况）
  if (window.innerWidth >= MOBILE_BREAKPOINT) return false;

  // 折叠屏展开 → 桌面（ViewportAdapter 会随后修改视口宽度）
  if (isFoldableUnfolded()) return false;

  // 请求了桌面版网站 → 桌面
  if (isDesktopModeRequested()) return false;

  return true;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => detectMobile());

  useEffect(() => {
    setIsMobile(detectMobile());

    const handleChange = () => setIsMobile(detectMobile());

    window.addEventListener('resize', handleChange);

    // 监听屏幕方向变化（折叠屏展开/折叠）
    if (window.screen?.orientation) {
      window.screen.orientation.addEventListener('change', handleChange);
    }

    return () => {
      window.removeEventListener('resize', handleChange);
      if (window.screen?.orientation) {
        window.screen.orientation.removeEventListener('change', handleChange);
      }
    };
  }, []);

  return isMobile;
}
