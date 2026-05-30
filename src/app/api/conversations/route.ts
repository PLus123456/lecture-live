// /api/conversations
//
// 历史契约：
//   GET  ?sessionId=xxx  → 列出 session 下所有 conversation
//   POST { sessionId }   → 新建 conversation，并把当前活跃的关闭
//
// U9（fancy-wiggling-harbor）扩展 — 为 `/chat` 全局对话服务：
//   GET  ?scope=session&sessionId=xxx   旧行为，向后兼容
//   GET  ?scope=global                   仅返回"无录音"全局对话（最近 50 条）
//   GET  ?recent=N (1..50)               跨 session 拉用户最近 N 个对话
//   POST { sessionId }                   旧行为，向后兼容（会关闭同 session 的活跃对话）
//   POST { recordingIds: string[] }      新建对话并把多条录音挂为 ConversationSession 行
//   POST {}                              新建一个"全局对话"（无 sessionId、无 junction 行）
//
// 设计参考：一节录音可以有多个对话上下文，每次"新建对话"把上一个 conversation
// 的 endedAt 写上时间戳，新建一个 endedAt=null 的活跃 conversation。
// 旧 conversation 仍可只读查看（不能再发消息）。
//
// 所有权说明：归属用 `Conversation.userId`（创建时由服务端写入）。零录音的纯 global
// 对话也带 userId，故创建即对列表可见，不再依赖挂载录音反推。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateRagCache } from '@/lib/llm/embedding/transcriptRag';
import { logger, serializeError } from '@/lib/logger';
import { collectSessionIds } from '@/lib/conversations';

const apiLogger = logger.child({ component: 'conversations-api' });

const RECENT_MIN = 1;
const RECENT_MAX = 50;
const GLOBAL_LIMIT = 50;

type ConversationListItem = {
  id: string;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  degradationLevel: number;
  messageCount: number;
  sessionIds: string[];
};

function serializeConversation(c: {
  id: string;
  title: string | null;
  startedAt: Date;
  endedAt: Date | null;
  degradationLevel: number;
  sessionId: string | null;
  sessions: Array<{ sessionId: string }>;
  _count: { messages: number };
}): ConversationListItem {
  return {
    id: c.id,
    title: c.title,
    startedAt: c.startedAt.toISOString(),
    endedAt: c.endedAt?.toISOString() ?? null,
    degradationLevel: c.degradationLevel,
    messageCount: c._count.messages,
    sessionIds: collectSessionIds(c),
  };
}

export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const scopeParam = url.searchParams.get('scope');
  const recentParam = url.searchParams.get('recent');
  const sessionIdParam = url.searchParams.get('sessionId');

  // ── 模式 A：?recent=N
  if (recentParam !== null) {
    const recent = Number.parseInt(recentParam, 10);
    if (
      !Number.isInteger(recent) ||
      recent < RECENT_MIN ||
      recent > RECENT_MAX
    ) {
      return NextResponse.json(
        { error: `recent must be an integer in [${RECENT_MIN}, ${RECENT_MAX}]` },
        { status: 400 }
      );
    }

    // 用户所有对话 = Conversation.userId 命中本人（含零录音纯 global 对话）
    const conversations = await prisma.conversation.findMany({
      where: { userId: user.id },
      orderBy: { startedAt: 'desc' },
      take: recent,
      select: {
        id: true,
        title: true,
        startedAt: true,
        endedAt: true,
        degradationLevel: true,
        sessionId: true,
        sessions: { select: { sessionId: true }, orderBy: { addedAt: 'asc' } },
        _count: { select: { messages: true } },
      },
    });
    return NextResponse.json({
      conversations: conversations.map(serializeConversation),
    });
  }

  // ── 模式 B：?scope=global
  if (scopeParam === 'global') {
    // 全局对话 = 本人拥有 且 无 legacy sessionId 绑定（含零录音纯 global 对话，现已可见）
    const conversations = await prisma.conversation.findMany({
      where: {
        userId: user.id,
        sessionId: null,
      },
      orderBy: { startedAt: 'desc' },
      take: GLOBAL_LIMIT,
      select: {
        id: true,
        title: true,
        startedAt: true,
        endedAt: true,
        degradationLevel: true,
        sessionId: true,
        sessions: { select: { sessionId: true }, orderBy: { addedAt: 'asc' } },
        _count: { select: { messages: true } },
      },
    });
    return NextResponse.json({
      conversations: conversations.map(serializeConversation),
    });
  }

  // ── 模式 C：?scope=session&sessionId=xxx (与默认行为一致)
  const sessionId =
    scopeParam === 'session' || scopeParam === null ? sessionIdParam : null;
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
      sessionId: true,
      sessions: { select: { sessionId: true }, orderBy: { addedAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    conversations: conversations.map(serializeConversation),
  });
}

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sessionId?: unknown; recordingIds?: unknown };
  try {
    body = await req.json();
  } catch {
    // 空 body 视作 `{}`：创建零录音全局对话
    body = {};
  }

  const legacySessionId =
    typeof body.sessionId === 'string' && body.sessionId.length > 0
      ? body.sessionId
      : null;

  // recordingIds：若提供必须是 string[]（允许空数组 = 创建零录音全局对话）
  let recordingIds: string[] | null = null;
  if (body.recordingIds !== undefined) {
    if (
      !Array.isArray(body.recordingIds) ||
      !body.recordingIds.every((v) => typeof v === 'string' && v.length > 0)
    ) {
      return NextResponse.json(
        { error: 'recordingIds must be string[]' },
        { status: 400 }
      );
    }
    recordingIds = Array.from(new Set(body.recordingIds as string[]));
  }

  if (legacySessionId && recordingIds) {
    return NextResponse.json(
      { error: 'specify one of sessionId or recordingIds' },
      { status: 400 }
    );
  }

  // ── 路径 A：legacy sessionId — 保留 1:1 录音绑定并关闭同 session 的活跃对话
  if (legacySessionId) {
    const session = await prisma.session.findUnique({
      where: { id: legacySessionId },
      select: { userId: true },
    });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    try {
      const [, newConv] = await prisma.$transaction([
        prisma.conversation.updateMany({
          where: { sessionId: legacySessionId, endedAt: null },
          data: { endedAt: new Date() },
        }),
        prisma.conversation.create({
          data: { sessionId: legacySessionId, userId: user.id },
          select: {
            id: true,
            title: true,
            startedAt: true,
            endedAt: true,
            degradationLevel: true,
            sessionId: true,
            sessions: { select: { sessionId: true } },
          },
        }),
      ]);

      // 主动清空 RAG cache（虽然 sessionId 相同，但新对话应该重置降级状态）
      invalidateRagCache(legacySessionId);

      return NextResponse.json({
        conversation: serializeConversation({ ...newConv, _count: { messages: 0 } }),
      });
    } catch (err) {
      apiLogger.error(
        { sessionId: legacySessionId, err: serializeError(err) },
        '新建 conversation 失败'
      );
      return NextResponse.json(
        { error: 'Failed to create conversation' },
        { status: 500 }
      );
    }
  }

  // ── 路径 B：recordingIds[] 或 空 body — 创建全局对话，可选 0..N 录音挂载
  // 不自动关闭任何已存在对话（全局对话允许并存）
  const finalRecordingIds = recordingIds ?? [];

  if (finalRecordingIds.length > 0) {
    // 全部录音必须归属当前用户
    const ownedCount = await prisma.session.count({
      where: { id: { in: finalRecordingIds }, userId: user.id },
    });
    if (ownedCount !== finalRecordingIds.length) {
      return NextResponse.json(
        { error: 'one or more recordingIds not owned by current user' },
        { status: 403 }
      );
    }
  }

  try {
    const conv = await prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: { sessionId: null, userId: user.id },
        select: {
          id: true,
          title: true,
          startedAt: true,
          endedAt: true,
          degradationLevel: true,
          sessionId: true,
        },
      });
      if (finalRecordingIds.length > 0) {
        await tx.conversationSession.createMany({
          data: finalRecordingIds.map((sid) => ({
            conversationId: created.id,
            sessionId: sid,
          })),
        });
      }
      return created;
    });

    return NextResponse.json({
      conversation: serializeConversation({
        ...conv,
        // 数据全已知，无需回读 DB
        sessions: finalRecordingIds.map((sessionId) => ({ sessionId })),
        _count: { messages: 0 },
      }),
    });
  } catch (err) {
    apiLogger.error(
      {
        recordingIds: finalRecordingIds,
        err: serializeError(err),
      },
      '新建全局 conversation 失败'
    );
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 }
    );
  }
}
