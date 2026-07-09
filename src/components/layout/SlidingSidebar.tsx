'use client';

/**
 * 区域侧栏的通用滑动外壳 —— 站内「切换左侧栏」的标准动画模式。
 *
 * 用法（见 dashboard layout）：
 *   1. 主 Sidebar 传 slideOut={进入某区域}，整体向左滑出；
 *   2. 区域侧栏（ChatSidebar / AdminSidebar / 未来的其它区域栏）用本组件包内容，
 *      传 visible={进入该区域}，从左滑入接替；
 *   3. 两者在 layout 里**常驻挂载**（卸载就没有离场动画了），互斥滑动；
 *   4. layout 的 <main> 在区域内固定 ml-56（本外壳宽度）。
 *
 * 隐藏态用 visibility 而非卸载：visibility 参与 transition（离场时在动画结束后
 * 才变 hidden），既保留双向动画，又让离屏侧栏不可聚焦（Tab 键跳不进去）。
 */
export default function SlidingSidebar({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  return (
    <aside
      className={`
        fixed left-0 top-0 h-full z-40 w-56
        bg-white dark:bg-charcoal-800
        border-r border-cream-200 dark:border-charcoal-700
        flex flex-col overflow-hidden
        transition-[transform,visibility] duration-300 ease-in-out
        ${visible ? 'translate-x-0 visible' : '-translate-x-full invisible'}
      `}
      aria-hidden={!visible}
    >
      {children}
    </aside>
  );
}
