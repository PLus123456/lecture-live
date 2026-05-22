// Conversation 工具 — 统一所有权与可见性判断
//
// 背景：Wave 1 把 `Conversation.sessionId` 改成可空，并新增 `ConversationSession`
// 多对多联接。一个对话现在可以由 0..N 个录音组成（"全局对话"），所以原本的
// `conversation.session.userId === user.id` 不再覆盖所有情况。
//
// 现状：Conversation 表没有 `userId` 列，所有权只能通过录音反推。所以一个
// 真正的"零录音全局对话"暂时无主、对列表不可见，要等 U10 给它挂上首条录音
// 或 follow-up 单元给 Conversation 加 `userId` 才能完全恢复。
//
// TODO: 添加 Conversation.userId 列后即可显示真正零录音的全局对话，
//       并把这里的 OR 子句简化为 `userId === user.id`。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export interface ConversationOwnership {
  conversationId: string;
  isOwned: boolean;
  /** sessionId === null && 无 ConversationSession 行 */
  isFreshGlobal: boolean;
}

/**
 * 判断指定用户是否拥有该对话。
 * 拥有条件（满足任一即可）：
 *  1. `conversation.sessionId !== null` 且 `Session.userId === userId`
 *  2. 至少一行 `ConversationSession` 的 `Session.userId === userId`
 *
 * 同时返回 `isFreshGlobal`：sessionId 为空且 0 行 ConversationSession，
 * 用于"还在初始化的全局对话"特殊处理（当前对非 admin 用户视作不可见）。
 */
export async function getConversationOwnership(
  conversationId: string,
  userId: string
): Promise<ConversationOwnership | null> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      sessionId: true,
      session: { select: { userId: true } },
      sessions: {
        select: { session: { select: { userId: true } } },
      },
    },
  });
  if (!conv) return null;

  const ownedViaSession =
    conv.sessionId !== null && conv.session?.userId === userId;
  const ownedViaJunction = conv.sessions.some(
    (row) => row.session.userId === userId
  );
  const isFreshGlobal =
    conv.sessionId === null && conv.sessions.length === 0;

  return {
    conversationId: conv.id,
    isOwned: ownedViaSession || ownedViaJunction,
    isFreshGlobal,
  };
}

export class ConversationOwnershipError extends Error {
  constructor(
    public readonly kind: 'not-found' | 'forbidden',
    message?: string
  ) {
    super(message ?? kind);
    this.name = 'ConversationOwnershipError';
  }
}

/**
 * 校验用户对会话的所有权，否则抛 `ConversationOwnershipError`。
 *
 * - 对话不存在 → kind: 'not-found'
 * - 对话存在但既未通过 `sessionId` 拥有也未通过 `ConversationSession` 拥有
 *   → kind: 'forbidden'（包括"无主全局对话"）
 *
 * 路由处理器应当 catch 该错误并用 `ownershipErrorResponse` 转 HTTP 响应。
 */
export async function assertConversationOwnership(
  conversationId: string,
  userId: string
): Promise<ConversationOwnership> {
  const result = await getConversationOwnership(conversationId, userId);
  if (!result) {
    throw new ConversationOwnershipError('not-found');
  }
  if (!result.isOwned) {
    throw new ConversationOwnershipError('forbidden');
  }
  return result;
}

/**
 * 把 `ConversationOwnershipError` 映射为标准的 HTTP 响应。
 * 非该错误 → 返回 null，调用方应继续抛出。
 *
 * @param opts.collapseForbiddenTo404 用于不想暴露资源是否存在的端点
 *   （如图片读取端点：所有非授权访问统一回 404）
 */
export function ownershipErrorResponse(
  err: unknown,
  opts?: { collapseForbiddenTo404?: boolean }
): NextResponse | null {
  if (!(err instanceof ConversationOwnershipError)) return null;
  if (err.kind === 'not-found' || opts?.collapseForbiddenTo404) {
    return NextResponse.json(
      { error: 'Conversation not found' },
      { status: 404 }
    );
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

/**
 * 聚合一个对话的 sessionIds — 兼容旧 `sessionId` 字段和新 `ConversationSession` 行，
 * 返回去重后的 string[]（顺序：先 legacy sessionId，再 junction addedAt asc）。
 */
export function collectSessionIds(conversation: {
  sessionId: string | null;
  sessions: Array<{ sessionId: string }>;
}): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  if (conversation.sessionId) {
    ids.push(conversation.sessionId);
    seen.add(conversation.sessionId);
  }
  for (const row of conversation.sessions) {
    if (!seen.has(row.sessionId)) {
      ids.push(row.sessionId);
      seen.add(row.sessionId);
    }
  }
  return ids;
}
