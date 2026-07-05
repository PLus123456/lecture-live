// POST /api/llm/chat/compress { conversationId, keepTurns? }
//
// 主动压缩 conversation 的历史：把早期 user/assistant 消息压成一条 role='system'
// 摘要消息，存进 DB。后续 chat/route.ts 组装 history 时会从最近一条 system 消息
// 之后开始取 —— 早期消息在 DB 里保留（UI 折叠展示），但不再发给 LLM。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { prisma } from '@/lib/prisma';
import { callLLM } from '@/lib/llm/gateway';
import { compressHistory } from '@/lib/llm/chatContextBuilder';
import type { ConversationTurn } from '@/lib/llm/chatContextBuilder';
import {
  encodeCompressedHistorySystemMessage,
  findCompressionBoundary,
} from '@/lib/llm/chatCompression';
import { logger, serializeError } from '@/lib/logger';

const apiLogger = logger.child({ component: 'chat-compress' });

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 安全：压缩会直接调用 LLM（成本操作），按用户限流防成本型 DoS。
  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'llm:chat:compress',
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

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
        // 按 seq 稳定排序（全局单调，替代 createdAt —— 避免同毫秒时间戳错乱影响切割点定位）
        orderBy: { seq: 'asc' },
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

  // 归属用 Conversation.userId（与其它端点统一）：userId 为 NULL 的无主孤儿、或他人对话 → 404。
  if (!conversation || conversation.userId !== user.id) {
    return NextResponse.json(
      { error: 'Conversation not found' },
      { status: 404 }
    );
  }
  // 压缩仅对挂录音的 legacy 对话有意义（需 session.targetLang 决定摘要语言）；
  // 纯 global 对话暂不支持，保持原 404 行为（本批不扩张 compress 范围）。
  if (!conversation.session) {
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

  // 取最近一条压缩边界之后的 user/assistant —— 这些才是"未被压缩"的有效消息
  const compressionBoundary = findCompressionBoundary(conversation.messages);
  const effectiveMessages = conversation.messages.slice(
    compressionBoundary.splitIndex + 1
  );
  const effectiveChatMessages = effectiveMessages.filter(
    (m): m is typeof m & { role: 'user' | 'assistant' } =>
      m.role === 'user' || m.role === 'assistant'
  );
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

  const compressedCount = turns.length - recentKept.length;
  const compressedThroughMessageId =
    compressedCount > 0
      ? effectiveChatMessages[compressedCount - 1]?.id ?? null
      : null;
  const rawCombinedSummary = compressionBoundary.summary
    ? `${compressionBoundary.summary}\n\n${summary}`.trim()
    : summary;

  // 长度上界：每次 recompress 都把上一条完整摘要重新前置（findCompressionBoundary），
  // combinedSummary 单调增长且无 LLM 输出硬上限。content 是 @db.Text（MySQL 64KB 上限，
  // 按字节计），一旦某次超限 create() 抛 1406，且下次仍复用这条超大摘要 → 永久 500
  // （v3 finding U88）。这里在落库前按字符预算截断（CJK UTF-8 约 3B/字符，16K 字符 ≈ 48KB，
  // 再叠加 encode 包裹的 JSON 结构仍安全落在 64KB 内），保留最新一段（末尾），并在超限时
  // 标注被截断。
  const COMBINED_SUMMARY_MAX_CHARS = 16_000;
  const combinedSummary =
    rawCombinedSummary.length > COMBINED_SUMMARY_MAX_CHARS
      ? `[⚠️ 早期摘要已因长度上限截断]\n` +
        rawCombinedSummary.slice(-COMBINED_SUMMARY_MAX_CHARS)
      : rawCombinedSummary;

  // 插入一条 role='system' 摘要消息。早期 user/assistant 消息保留在 DB，并用
  // compressed-through 标记记录切割点，避免依赖 createdAt 插入位置。
  // 包 try/catch：即使截断后仍触碰某些边界（如 encode 后超限），也优雅降级而非未处理 500。
  try {
    await prisma.conversationMessage.create({
      data: {
        conversationId,
        role: 'system',
        content: encodeCompressedHistorySystemMessage(
          combinedSummary,
          compressedThroughMessageId
        ),
      },
    });
  } catch (err) {
    apiLogger.error(
      { conversationId, err: serializeError(err) },
      '压缩摘要落库失败（可能超 content 长度上限）'
    );
    return NextResponse.json(
      {
        compressed: false,
        error: 'compression_persist_failed',
        message:
          '压缩摘要保存失败（可能内容过长）。建议直接新建对话继续。',
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    compressed: true,
    summary: combinedSummary,
    keptTurns: recentKept.length,
  });
}
