import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIsMobile } from '@/hooks/useIsMobile';

/**
 * L12：resize 处理必须按帧合并 —— 拖窗口时 resize 每帧连发数十次，
 * 未节流版本会逐次 detectMobile + setState，把重渲染放大到同样的量级。
 */

/** 受控 rAF：手动推进帧，便于断言「一帧内多少次回调」。 */
let rafQueue: FrameRequestCallback[] = [];
let rafId = 0;
const cancelled = new Set<number>();
const idToCb = new Map<number, FrameRequestCallback>();

function flushFrame() {
  const pending = [...idToCb.entries()];
  idToCb.clear();
  rafQueue = [];
  for (const [id, cb] of pending) {
    if (cancelled.has(id)) continue;
    cb(performance.now());
  }
}

beforeEach(() => {
  rafQueue = [];
  rafId = 0;
  cancelled.clear();
  idToCb.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafId += 1;
    idToCb.set(rafId, cb);
    rafQueue.push(cb);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled.add(id);
    idToCb.delete(id);
  });
  window.innerWidth = 1280;
  // jsdom 默认 screen 是 1024×768 → minDim 768、ratio 1.33 会被 isFoldableUnfolded
  // 判成「折叠屏展开=桌面」，窄视口也永远测不出 mobile。改成手机屏尺寸。
  Object.defineProperty(window, 'screen', {
    configurable: true,
    value: { width: 375, height: 812 },
  });
  // jsdom 里 `ontouchstart in window` 为真且 UA 不含 Mobile → 会被当成
  // 「请求桌面版网站」。给个手机 UA 才能走到真正的宽度判据。
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setWidth(w: number) {
  window.innerWidth = w;
  window.dispatchEvent(new Event('resize'));
}

describe('useIsMobile', () => {
  it('一帧内连发 30 次 resize 只安排一次重算', () => {
    renderHook(() => useIsMobile());

    act(() => {
      for (let i = 0; i < 30; i++) setWidth(1280 - i);
    });

    // 关键断言：30 次事件只排了 1 个 rAF 回调
    expect(rafQueue).toHaveLength(1);
  });

  it('帧回调跑完后仍能响应下一轮 resize（不是只跑一次就锁死）', () => {
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      setWidth(400);
      flushFrame();
    });
    expect(result.current).toBe(true);

    act(() => {
      setWidth(1280);
      flushFrame();
    });
    expect(result.current).toBe(false);
  });

  it('卸载时取消在途帧，不再 setState', () => {
    const { unmount } = renderHook(() => useIsMobile());
    act(() => {
      setWidth(400);
    });
    expect(rafQueue).toHaveLength(1);
    unmount();
    // flush 时被 cancel 的回调不会执行（执行了会触发卸载后 setState 警告）
    act(() => {
      flushFrame();
    });
    expect(cancelled.size).toBe(1);
  });
});
