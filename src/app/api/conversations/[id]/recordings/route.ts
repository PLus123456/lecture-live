// /api/conversations/[id]/recordings — 管理某对话挂载的录音（ConversationSession 行）
//
//   GET    返回 [{ sessionId, title, addedAt }]
//   POST   { sessionIds: string[] }  追加挂载（重复用 skipDuplicates 跳过）
//   DELETE { sessionIds: string[] }  从联表删除指定行
//
// 鉴权：401 未登录；404 对话不存在；403 非所有者；403 录音不属于当前用户。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  assertConversationOwnership,
  ownershipErrorResponse,
} from '@/lib/conversations';
import { invalidateRagCacheForRecordings } from '@/lib/llm/embedding/transcriptRag';
import { logger, serializeError } from '@/lib/logger';

const apiLogger = logger.child({ component: 'conversation-recordings-api' });

type RecordingRow = {
  sessionId: string;
  title: string | null;
  addedAt: string;
};

async function listRecordings(conversationId: string): Promise<RecordingRow[]> {
  const rows = await prisma.conversationSession.findMany({
    where: { conversationId },
    orderBy: { addedAt: 'asc' },
    select: {
      sessionId: true,
      addedAt: true,
      session: { select: { title: true } },
    },
  });
  return rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.session?.title ?? null,
    addedAt: r.addedAt.toISOString(),
  }));
}

type SessionIdsResult =
  | { ok: true; sessionIds: string[] }
  | { ok: false; response: NextResponse };

async function parseSessionIds(req: Request): Promise<SessionIdsResult> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }),
    };
  }
  const raw = (body as { sessionIds?: unknown })?.sessionIds;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((v) => typeof v === 'string' && v.length > 0)
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'sessionIds must be a non-empty string[]' },
        { status: 400 }
      ),
    };
  }
  return { ok: true, sessionIds: Array.from(new Set(raw as string[])) };
}

async function authorize(
  req: Request,
  conversationId: string
): Promise<
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse }
> {
  const user = await verifyAuth(req);
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  try {
    await assertConversationOwnership(conversationId, user.id);
  } catch (err) {
    const mapped = ownershipErrorResponse(err);
    if (mapped) return { ok: false, response: mapped };
    throw err;
  }
  return { ok: true, userId: user.id };
}

/** 已关闭（endedAt 非空）的对话只读：禁止增删挂载录音。 */
async function isConversationClosed(conversationId: string): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { endedAt: true },
  });
  return Boolean(conv?.endedAt);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorize(req, id);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ recordings: await listRecordings(id) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorize(req, id);
  if (!auth.ok) return auth.response;

  const parsed = await parseSessionIds(req);
  if (!parsed.ok) return parsed.response;

  if (await isConversationClosed(id)) {
    return NextResponse.json(
      { error: 'Conversation is closed (read-only)' },
      { status: 409 }
    );
  }

  // 验证所有待挂载录音都属于当前用户
  const ownedCount = await prisma.session.count({
    where: { id: { in: parsed.sessionIds }, userId: auth.userId },
  });
  if (ownedCount !== parsed.sessionIds.length) {
    return NextResponse.json(
      { error: 'one or more sessionIds not owned by current user' },
      { status: 403 }
    );
  }

  try {
    await prisma.conversationSession.createMany({
      data: parsed.sessionIds.map((sid) => ({
        conversationId: id,
        sessionId: sid,
      })),
      skipDuplicates: true,
    });
  } catch (err) {
    apiLogger.error(
      { conversationId: id, err: serializeError(err) },
      'attach recordings failed'
    );
    return NextResponse.json(
      { error: 'Failed to attach recordings' },
      { status: 500 }
    );
  }

  const recordings = await listRecordings(id);
  // 挂载集合变了 → 该对话下次 chat 会以新的录音组合为 cache key 重建 RAG；这里主动清掉
  // 恰好命中“新组合”的旧 multi-entry（若历史上曾出现过同一组合且其中某录音 transcript
  // 已变动），避免复用陈旧向量。死代码 invalidateRagCacheForRecordings 的唯一生产接线。
  invalidateRagCacheForRecordings(recordings.map((r) => r.sessionId));

  return NextResponse.json({ recordings });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorize(req, id);
  if (!auth.ok) return auth.response;

  const parsed = await parseSessionIds(req);
  if (!parsed.ok) return parsed.response;

  if (await isConversationClosed(id)) {
    return NextResponse.json(
      { error: 'Conversation is closed (read-only)' },
      { status: 409 }
    );
  }

  try {
    await prisma.conversationSession.deleteMany({
      where: { conversationId: id, sessionId: { in: parsed.sessionIds } },
    });
  } catch (err) {
    apiLogger.error(
      { conversationId: id, err: serializeError(err) },
      'detach recordings failed'
    );
    return NextResponse.json(
      { error: 'Failed to detach recordings' },
      { status: 500 }
    );
  }

  const recordings = await listRecordings(id);
  // 同 POST：移除录音后挂载集合变了，主动清掉恰好命中“新组合”的旧 multi-entry，
  // 避免该对话下次 chat 复用基于旧组合快照的陈旧向量。
  invalidateRagCacheForRecordings(recordings.map((r) => r.sessionId));

  return NextResponse.json({ recordings });
}
