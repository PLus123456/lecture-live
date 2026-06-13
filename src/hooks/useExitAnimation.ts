'use client';

import { useEffect, useState } from 'react';

export interface ExitAnimationState {
  /** 是否应渲染（含离场动画播放期间）。为 false 时调用方应 `return null`。 */
  mounted: boolean;
  /** 是否正在播放离场动画。为 true 时套用 *-leave / *-out 动画 class。 */
  leaving: boolean;
}

/**
 * 管理弹窗 / 抽屉 / 气泡的「挂载 + 离场」两段式动画，
 * 抽取自 UserSettingsModal 的金标准实现，供所有浮层复用。
 *
 * - `open` 变 true：立即挂载并播放进入动画（`leaving=false`）。
 * - `open` 变 false：先保持挂载、置 `leaving=true` 播放离场动画，
 *   等 `durationMs` 后再真正卸载（`mounted=false`）。
 *
 * 用法：
 * ```tsx
 * const { mounted, leaving } = useExitAnimation(open);
 * if (!mounted) return null;
 * // backdrop: leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'
 * // panel:    leaving ? 'animate-modal-leave'    : 'animate-modal-enter'
 * ```
 *
 * @param open       浮层是否应显示
 * @param durationMs 离场动画时长（需与对应 CSS 动画时长一致），默认 180ms
 */
export function useExitAnimation(open: boolean, durationMs = 180): ExitAnimationState {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    // 已经卸载就不必再播离场动画（例如初始即 closed）。
    if (!mounted) return;
    setLeaving(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, durationMs);
    return () => clearTimeout(timer);
  }, [open, mounted, durationMs]);

  return { mounted, leaving };
}
