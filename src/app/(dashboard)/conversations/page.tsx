import ConversationsClient from './ConversationsClient';

/**
 * /conversations — 对话历史页（独立路由）。
 *
 * 相对 /chat 的「最近对话」入口，这里是完整管理面：搜索、归档区、归档/取消归档、
 * 删除、清空全部。server component 外壳，交互全在 ConversationsClient（client）。
 */
export default function ConversationsPage() {
  return <ConversationsClient />;
}
