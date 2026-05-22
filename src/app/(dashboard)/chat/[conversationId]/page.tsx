import ChatDetailClient from './ChatDetailClient';

/**
 * /chat/[id] — 具体对话页。
 *
 * Server component 外壳，渲染 client 子组件做实际工作。鉴权 + 归属
 * 检查在 ChatDetailClient 里通过 API 调用完成；如果服务器返回
 * 404/403，client 会通过 useRouter 跳回 /chat 并 toast。
 *
 * 为什么不在 server component 里直接读数据库做归属校验？
 *   1. 现网鉴权基于 JWT cookie + Authorization header，没有
 *      next/headers 适配层；
 *   2. server-side fetch 调本机 API 还要拼内部 baseURL，比
 *      在 client 直接调更脆弱；
 *   3. AuthGuard 已在 layout 层挡未登录用户。
 */
export default async function ChatDetailPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <ChatDetailClient conversationId={conversationId} />;
}
