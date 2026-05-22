// GET /api/conversations/[id]/messages → 拉取 conversation 的所有消息（按 createdAt asc）
//
// 旧 conversation（endedAt 非 null）也可读，UI 用来展示历史对话只读视图。
// 全局对话（无 sessionId）也走这个端点 — 所有权用 assertConversationOwnership 统一判定。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  assertConversationOwnership,
  ownershipErrorResponse,
} from '@/lib/conversations';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    await assertConversationOwnership(id, user.id);
  } catch (err) {
    const mapped = ownershipErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      startedAt: true,
      endedAt: true,
      degradationLevel: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          transcriptOffsetMs: true,
          degradationLevel: true,
          inputTokens: true,
          outputTokens: true,
          createdAt: true,
        },
      },
    },
  });

  if (!conversation) {
    // 罕见竞态：刚通过所有权校验，期间被删
    return NextResponse.json(
      { error: 'Conversation not found' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      startedAt: conversation.startedAt.toISOString(),
      endedAt: conversation.endedAt?.toISOString() ?? null,
      degradationLevel: conversation.degradationLevel,
    },
    messages: conversation.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      transcriptOffsetMs: m.transcriptOffsetMs,
      degradationLevel: m.degradationLevel,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}
