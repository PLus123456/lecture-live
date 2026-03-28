'use client';

/**
 * 视口适配器 — 处理两种特殊场景：
 * 1. 用户在手机浏览器选择「请求桌面版网站」
 * 2. 折叠屏手机展开后屏幕接近正方形，适合桌面布局
 *
 * 原理：动态修改 <meta name="viewport"> 的 width，
 * 让浏览器以桌面宽度渲染页面并自动缩放适配物理屏幕。
 */

import { useEffect } from 'react';

/** 桌面模式下的虚拟视口宽度 */
const DESKTOP_VIEWPORT_WIDTH = 1024;

/**
 * 检测浏览器是否处于「请求桌面版网站」模式。
 * 特征：有触摸屏 + UA 不含移动端标识 + 物理屏幕较小。
 */
function isDesktopModeRequested(): boolean {
  const ua = navigator.userAgent;
  const hasTouchScreen =
    'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const hasMobileUA = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);

  // 触摸设备 + 桌面UA + 物理屏幕 < 768 → 请求了桌面版
  // 真正的触摸屏笔记本 screen.width 通常 >= 1024
  return hasTouchScreen && !hasMobileUA && window.screen.width < 900;
}

/**
 * 检测折叠屏展开状态。
 * 特征：物理屏幕最小边 >= 480px 且宽高比 < 1.4（接近正方形）。
 * 普通手机宽高比一般 > 1.8（如 20:9 ≈ 2.22）。
 */
function isFoldableUnfolded(): boolean {
  const w = window.screen.width;
  const h = window.screen.height;
  const minDim = Math.min(w, h);
  const maxDim = Math.max(w, h);
  const ratio = maxDim / minDim;

  return minDim >= 480 && ratio < 1.4;
}

/**
 * 检测当前是否需要切换到桌面视口。
 * 已经是宽屏设备（>= 768）不需要处理。
 */
function shouldUseDesktopViewport(): boolean {
  // 如果已经是宽屏，不需要处理
  if (window.screen.width >= 768 && window.screen.height >= 768) return false;

  return isDesktopModeRequested() || isFoldableUnfolded();
}

function applyViewport() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;

  if (shouldUseDesktopViewport()) {
    const scale = Math.min(1, window.screen.width / DESKTOP_VIEWPORT_WIDTH);
    meta.setAttribute(
      'content',
      `width=${DESKTOP_VIEWPORT_WIDTH}, initial-scale=${scale.toFixed(4)}, viewport-fit=cover`,
    );
  } else {
    meta.setAttribute(
      'content',
      'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
    );
  }
}

export default function ViewportAdapter() {
  useEffect(() => {
    applyViewport();

    // 折叠/展开、旋转等都会触发 resize
    const handleResize = () => {
      // 延迟一帧，等浏览器更新 screen 尺寸
      requestAnimationFrame(applyViewport);
    };

    window.addEventListener('resize', handleResize);

    // 监听屏幕方向变化（折叠屏展开/折叠）
    if (window.screen?.orientation) {
      window.screen.orientation.addEventListener('change', handleResize);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      if (window.screen?.orientation) {
        window.screen.orientation.removeEventListener('change', handleResize);
      }
    };
  }, []);

  return null;
}
