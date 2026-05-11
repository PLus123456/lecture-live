// GET /api/conversations/[id]/messages → 拉取 conversation 的所有消息（按 createdAt asc）
//
// 旧 conversation（endedAt 非 null）也可读，UI 用来展示历史对话只读视图。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      session: { select: { userId: true } },
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

  if (!conversation || conversation.session.userId !== user.id) {
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
