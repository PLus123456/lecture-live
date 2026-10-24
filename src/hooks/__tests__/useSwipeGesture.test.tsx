import React, { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import BottomSheet from '@/components/mobile/BottomSheet';

/**
 * useSwipeGesture 回归锁（审计 medium）：
 *   - 父组件在手势途中重渲染（回放页播放时每 100ms、录音页每秒）不得重置触点起点 ——
 *     旧实现会把竖向滚动误判成左右滑（切 Tab）或下滑（关 BottomSheet）；
 *   - 元素晚于首个 effect 才挂载（BottomSheet 打开）时也必须挂上监听器。
 */

function touch(el: Element, type: 'touchstart' | 'touchmove' | 'touchend', x = 0, y = 0) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
  });
  el.dispatchEvent(event);
}

let forceRerender: () => void = () => {};

function Harness({
  onLeft,
  onRight,
  onDown,
}: {
  onLeft: () => void;
  onRight: () => void;
  onDown: () => void;
}) {
  const [, setTick] = useState(0);
  forceRerender = () => setTick((n) => n + 1);
  // 与 MobilePlaybackLayout / MobileSessionLayout 一样传内联回调
  const swipeRef = useSwipeGesture<HTMLDivElement>({
    onSwipeLeft: () => onLeft(),
    onSwipeRight: () => onRight(),
    onSwipeDown: () => onDown(),
    threshold: 60,
  });
  return <div data-testid="area" ref={swipeRef} />;
}

describe('useSwipeGesture', () => {
  it('手势途中父组件重渲染：竖向小幅滚动不得被误判成滑动（旧实现起点被重置为 0,0）', () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const onDown = vi.fn();
    render(<Harness onLeft={onLeft} onRight={onRight} onDown={onDown} />);
    const area = screen.getByTestId('area');

    // 右上区域竖向滚动（x > y，旧实现会误判为右滑 → 切到上一个 Tab）
    touch(area, 'touchstart', 350, 220);
    act(() => forceRerender());
    touch(area, 'touchmove', 352, 180);
    touch(area, 'touchend');

    // 面板下方区域轻微抖动（旧实现误判为下滑 → 关闭 BottomSheet）
    touch(area, 'touchstart', 150, 640);
    act(() => forceRerender());
    touch(area, 'touchmove', 151, 642);
    touch(area, 'touchend');

    expect(onLeft).not.toHaveBeenCalled();
    expect(onRight).not.toHaveBeenCalled();
    expect(onDown).not.toHaveBeenCalled();
  });

  it('真正的滑动跨过重渲染仍正确识别，并调用最新一次渲染的回调', () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const onDown = vi.fn();
    const { rerender } = render(<Harness onLeft={onLeft} onRight={onRight} onDown={onDown} />);
    const area = screen.getByTestId('area');

    touch(area, 'touchstart', 300, 300);
    act(() => forceRerender());
    touch(area, 'touchmove', 200, 305);
    touch(area, 'touchend');
    expect(onLeft).toHaveBeenCalledTimes(1);

    const latestRight = vi.fn();
    rerender(<Harness onLeft={onLeft} onRight={latestRight} onDown={onDown} />);
    touch(area, 'touchstart', 100, 300);
    touch(area, 'touchmove', 200, 300);
    touch(area, 'touchend');
    expect(latestRight).toHaveBeenCalledTimes(1);
    expect(onRight).not.toHaveBeenCalled();

    touch(area, 'touchstart', 100, 100);
    touch(area, 'touchmove', 105, 200);
    touch(area, 'touchend');
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it('点击（无 touchmove）不触发任何滑动', () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const onDown = vi.fn();
    render(<Harness onLeft={onLeft} onRight={onRight} onDown={onDown} />);
    const area = screen.getByTestId('area');

    touch(area, 'touchstart', 300, 500);
    act(() => forceRerender());
    touch(area, 'touchend');

    expect(onLeft).not.toHaveBeenCalled();
    expect(onRight).not.toHaveBeenCalled();
    expect(onDown).not.toHaveBeenCalled();
  });
});

describe('BottomSheet 下滑关闭', () => {
  it('稳定的 onClose + 面板晚于首个 effect 才挂载：下滑把手仍能关闭（旧实现监听器永远挂不上）', () => {
    const onClose = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <BottomSheet open={open} onClose={onClose} title="Sheet">
            <div data-testid="sheet-body">body</div>
          </BottomSheet>
        </>
      );
    }
    render(<Host />);
    act(() => {
      screen.getByText('open').click();
    });

    const handle = screen.getByTestId('bottom-sheet-handle');
    touch(handle, 'touchstart', 200, 500);
    touch(handle, 'touchmove', 202, 600);
    touch(handle, 'touchend');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('在内容区往回滚动（手指下滑）不关闭面板', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Sheet">
        <div data-testid="sheet-body">body</div>
      </BottomSheet>
    );

    const body = screen.getByTestId('sheet-body');
    touch(body, 'touchstart', 200, 400);
    touch(body, 'touchmove', 200, 520);
    touch(body, 'touchend');

    expect(onClose).not.toHaveBeenCalled();
  });
});
