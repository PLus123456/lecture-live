// POST /api/llm/chat/compress { conversationId, keepTurns? }
//
// 主动压缩 conversation 的历史：把早期 user/assistant 消息压成一条 role='system'
// 摘要消息，存进 DB。后续 chat/route.ts 组装 history 时会从最近一条 system 消息
// 之后开始取 —— 早期消息在 DB 里保留（UI 折叠展示），但不再发给 LLM。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { callLLM } from '@/lib/llm/gateway';
import { compressHistory } from '@/lib/llm/chatContextBuilder';
import type { ConversationTurn } from '@/lib/llm/chatContextBuilder';
import { logger, serializeError } from '@/lib/logger';

const apiLogger = logger.child({ component: 'chat-compress' });

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { conversationId?: unknown; keepTurns?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const conversationId =
    typeof body.conversationId === 'string' ? body.conversationId : '';
  if (!conversationId) {
    return NextResponse.json(
      { error: 'conversationId required' },
      { status: 400 }
    );
  }
  const keepTurns =
    typeof body.keepTurns === 'number' &&
    body.keepTurns >= 1 &&
    body.keepTurns <= 10
      ? Math.floor(body.keepTurns)
      : 3;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      session: { select: { userId: true, targetLang: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          transcriptOffsetMs: true,
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
  if (conversation.endedAt) {
    return NextResponse.json(
      { error: 'Conversation is closed' },
      { status: 409 }
    );
  }

  // 取最近一条 role='system' 之后的 user/assistant —— 这些才是"未被压缩"的有效消息
  const lastSystemIndex = (() => {
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      if (conversation.messages[i].role === 'system') return i;
    }
    return -1;
  })();

  const effectiveMessages = conversation.messages.slice(lastSystemIndex + 1);
  const turns: ConversationTurn[] = effectiveMessages
    .filter(
      (m): m is typeof m & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant'
    )
    .map((m) => ({
      role: m.role,
      content: m.content,
      transcriptOffsetMs: m.transcriptOffsetMs ?? 0,
    }));

  if (turns.length === 0) {
    return NextResponse.json({
      compressed: false,
      reason: 'no messages to compress',
    });
  }

  const language = conversation.session.targetLang || 'zh';

  let summary: string;
  let recentKept: ReadonlyArray<ConversationTurn>;
  try {
    const result = await compressHistory({
      history: turns,
      keepTurns,
      callLLM: (s: string, u: string) => callLLM(s, u, { purpose: 'CHAT' }),
      language,
    });
    if (!result) {
      return NextResponse.json({
        compressed: false,
        reason: 'history shorter than keepTurns',
      });
    }
    summary = result.summarySystemMessage;
    recentKept = result.recentTurns;
  } catch (err) {
    apiLogger.error(
      { conversationId, err: serializeError(err) },
      '主动压缩失败'
    );
    return NextResponse.json(
      {
        compressed: false,
        error: 'compression_failed',
        message:
          '压缩失败。如果是 API/quota 问题，建议直接新建对话；否则稍后重试。',
      },
      { status: 502 }
    );
  }

  // 插入一条 role='system' 摘要消息。早期 user/assistant 消息保留在 DB，但
  // chat/route.ts 组装 history 时只取此 system 消息之后的内容 —— 实现"UI 可折叠
  // 看原文，但不再发给 LLM"。
  await prisma.conversationMessage.create({
    data: {
      conversationId,
      role: 'system',
      content: summary,
    },
  });

  return NextResponse.json({
    compressed: true,
    summary,
    keptTurns: recentKept.length,
  });
}
