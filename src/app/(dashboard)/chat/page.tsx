import ChatHomeClient from './ChatHomeClient';

/**
 * /chat — 全局对话入口页（新对话 + 最近对话列表）。
 *
 * Next.js 15 App Router: 文件本身是 server component（无 'use client'）。
 * 数据获取和交互全部委托给 ChatHomeClient（client component），
 * 因为：
 *   1. 鉴权状态保存在 client zustand store / localStorage 里，
 *      server component 拿不到 token；
 *   2. AuthGuard 已经在 layout 层做了重定向 / 骨架屏；
 *   3. 「新建对话」按钮需要 onClick，强制 client。
 *
 * 此 server component 只保留可静态预渲染的外层 wrap。
 */
export default function ChatPage() {
  return <ChatHomeClient />;
}
