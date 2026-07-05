// POST /api/conversations/[id]/generate-title
//
// 给一个尚无标题的对话自动生成标题（基于首条用户消息，用 KEYWORD_EXTRACTION 模型）。
// 幂等：已有非空标题 → 直接返回现有标题，不重复生成。
// 由前端在首轮对话完成后触发（fire-and-forget）；生成失败返回 { title: null }，不报错。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { prisma } from '@/lib/prisma';
import {
  assertConversationOwnership,
  ownershipErrorResponse,
} from '@/lib/conversations';
import { generateConversationTitle } from '@/lib/llm/conversationTitle';
import { logger, serializeError } from '@/lib/logger';

const apiLogger = logger.child({ component: 'conversation-generate-title' });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 安全：标题生成会调用 LLM（成本操作），按用户限流防成本型 DoS。
  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'conversations:generate-title',
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

  const { id } = await params;
  try {
    await assertConversationOwnership(id, user.id);
  } catch (err) {
    const mapped = ownershipErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }

  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: {
      title: true,
      messages: {
        where: { role: 'user' },
        orderBy: { seq: 'asc' },
        take: 1,
        select: { content: true },
      },
    },
  });
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  // 幂等：已有标题不重复生成
  if (conv.title && conv.title.trim()) {
    return NextResponse.json({ title: conv.title });
  }

  const firstUser = conv.messages[0]?.content;
  if (!firstUser) {
    // 还没有用户消息 → 无可生成
    return NextResponse.json({ title: null });
  }

  const title = await generateConversationTitle({ firstUserMessage: firstUser });
  if (!title) {
    return NextResponse.json({ title: null });
  }

  try {
    // U50：原子条件更新 —— 只在标题仍为 null 时写入，避免覆盖用户在 LLM 生成期间
    // 经 PATCH 手动改好的标题（check-then-act 竞态）。updateMany 的 where 里带 title 条件，
    // 命中 0 行即说明期间已被改名，静默跳过。
    await prisma.conversation.updateMany({
      where: { id, title: null },
      data: { title },
    });
  } catch (err) {
    apiLogger.warn(
      { id, err: serializeError(err) },
      'persist conversation title failed'
    );
  }

  return NextResponse.json({ title });
}
