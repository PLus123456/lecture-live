// /api/conversations/[id]
//
//   GET     返回单个对话元数据（不含消息正文）—— 详情页/历史页用，省去拉全部消息的开销
//   DELETE  物理删除对话本体 + 连带清理：Cloudreve 附件文件、本地内嵌图片、storageBytes 配额
//
// 归属：`Conversation.userId === user.id` 或 `user.role === 'ADMIN'`。
//   - userId 为 NULL 的历史无主对话：非 ADMIN 一律 403（任何人都不拥有），ADMIN 可清理。
//   - 对话不存在：404。
//
// 物理删除（无软删除/回收站），与全站其它 model 一致。级联清理委托给
// deleteConversationsCascade（详见该函数：为何不能裸调 prisma.conversation.delete）。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { collectSessionIds } from '@/lib/conversations';
import { deleteConversationsCascade } from '@/lib/conversationCascade';
import { logger, serializeError } from '@/lib/logger';

const apiLogger = logger.child({ component: 'conversation-detail-api' });

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      title: true,
      startedAt: true,
      endedAt: true,
      degradationLevel: true,
      archived: true,
      sessionId: true,
      sessions: { select: { sessionId: true }, orderBy: { addedAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  });
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const owned = conv.userId !== null && conv.userId === user.id;
  if (!owned && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({
    conversation: {
      id: conv.id,
      title: conv.title,
      startedAt: conv.startedAt.toISOString(),
      endedAt: conv.endedAt?.toISOString() ?? null,
      degradationLevel: conv.degradationLevel,
      archived: conv.archived,
      messageCount: conv._count.messages,
      sessionIds: collectSessionIds(conv),
    },
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });
  }

  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const owned = conv.userId !== null && conv.userId === user.id;
  if (!owned && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await deleteConversationsCascade([id]);
  } catch (err) {
    apiLogger.error(
      { conversationId: id, err: serializeError(err) },
      'delete conversation failed'
    );
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// PATCH —— 改对话标题（重命名）和/或归档状态。owner 或 ADMIN。
//   body { title?: string, archived?: boolean }，至少给一个。
const MAX_TITLE_LEN = 100;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body: { title?: unknown; archived?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const data: { title?: string; archived?: boolean } = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') {
      return NextResponse.json({ error: 'title must be a string' }, { status: 400 });
    }
    const title = body.title.trim();
    if (title.length === 0 || title.length > MAX_TITLE_LEN) {
      return NextResponse.json(
        { error: `title must be 1..${MAX_TITLE_LEN} chars` },
        { status: 400 }
      );
    }
    data.title = title;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') {
      return NextResponse.json(
        { error: 'archived must be a boolean' },
        { status: 400 }
      );
    }
    data.archived = body.archived;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: 'nothing to update (title or archived)' },
      { status: 400 }
    );
  }

  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const owned = conv.userId !== null && conv.userId === user.id;
  if (!owned && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await prisma.conversation.update({ where: { id }, data });
  } catch (err) {
    apiLogger.error(
      { conversationId: id, err: serializeError(err) },
      'update conversation failed'
    );
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...data });
}
