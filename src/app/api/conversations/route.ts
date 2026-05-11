// GET /api/conversations?sessionId=xxx      → 列出 session 下所有 conversation
// POST /api/conversations { sessionId }      → 新建 conversation，并把当前活跃的关闭
//
// 设计参考：一节录音可以有多个对话上下文，每次"新建对话"把上一个 conversation
// 的 endedAt 写上时间戳，新建一个 endedAt=null 的活跃 conversation。
// 旧 conversation 仍可只读查看（不能再发消息）。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateRagCache } from '@/lib/llm/embedding/transcriptRag';
import { logger, serializeError } from '@/lib/logger';

const apiLogger = logger.child({ component: 'conversations-api' });

export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId required' },
      { status: 400 }
    );
  }

  // 验证 session 归属
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== user.id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const conversations = await prisma.conversation.findMany({
    where: { sessionId },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      title: true,
      startedAt: true,
      endedAt: true,
      degradationLevel: true,
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt?.toISOString() ?? null,
      degradationLevel: c.degradationLevel,
      messageCount: c._count.messages,
    })),
  });
}

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId required' },
      { status: 400 }
    );
  }

  // 验证 session 归属
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== user.id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // 关闭当前活跃 + 新建一个
  try {
    const [, newConv] = await prisma.$transaction([
      prisma.conversation.updateMany({
        where: { sessionId, endedAt: null },
        data: { endedAt: new Date() },
      }),
      prisma.conversation.create({
        data: { sessionId },
        select: {
          id: true,
          title: true,
          startedAt: true,
          endedAt: true,
          degradationLevel: true,
        },
      }),
    ]);

    // 主动清空 RAG cache（虽然 sessionId 相同，但新对话应该重置降级状态）
    invalidateRagCache(sessionId);

    return NextResponse.json({
      conversation: {
        id: newConv.id,
        title: newConv.title,
        startedAt: newConv.startedAt.toISOString(),
        endedAt: null,
        degradationLevel: newConv.degradationLevel,
        messageCount: 0,
      },
    });
  } catch (err) {
    apiLogger.error(
      { sessionId, err: serializeError(err) },
      '新建 conversation 失败'
    );
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 }
    );
  }
}
