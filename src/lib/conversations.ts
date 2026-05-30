// Conversation 工具 — 统一所有权与可见性判断
//
// 归属权威来源是 `Conversation.userId` 列（创建时由服务端写入，不再靠录音反推）。
// 历史"零录音纯 global 对话"（无 sessionId、无 ConversationSession、无 ChatAttachment）
// 在迁移回填后 userId 仍为 NULL —— 视为"无主"，任何人都不拥有（列表不显示 + 访问 404）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export interface ConversationOwnership {
  conversationId: string;
  isOwned: boolean;
}

/**
 * 判断指定用户是否拥有该对话。
 * 拥有条件：`Conversation.userId === userId`（且非 NULL）。
 * userId 为 NULL 的历史无主孤儿 → 任何人都不拥有。
 */
export async function getConversationOwnership(
  conversationId: string,
  userId: string
): Promise<ConversationOwnership | null> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });
  if (!conv) return null;

  return {
    conversationId: conv.id,
    isOwned: conv.userId !== null && conv.userId === userId,
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
 * - 对话存在但 `userId` 不等于当前用户（含 userId 为 NULL 的无主孤儿）
 *   → kind: 'forbidden'
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
