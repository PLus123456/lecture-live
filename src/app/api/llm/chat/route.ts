import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  callLLM,
  callLLMWithHistory,
  getProviderForPurpose,
  type ThinkingPreference,
} from '@/lib/llm/gateway';
import { buildChatPrompt } from '@/lib/llm/prompts';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { withRequestLogging } from '@/lib/requestLogger';
import type { ThinkingDepth } from '@/types/llm';
import {
  LLMAccessError,
  resolveAuthorizedLlmSelection,
  resolveEffectiveThinkingDepth,
} from '@/lib/llm/access';
import {
  LLM_LIMITS,
  LLMValidationError,
  readOptionalIdentifier,
  readOptionalText,
  readRequiredText,
} from '@/lib/llm/security';
import {
  buildChatContext,
  ChatContextEOLError,
  type ConversationTurn,
  type DegradationLevel,
  type TranscriptSegment,
  DEGRADATION_MAX_LEVEL,
} from '@/lib/llm/chatContextBuilder';
import { computeContextBudget } from '@/lib/llm/tokenBudget';
import { makeRagRetrieverForSession } from '@/lib/llm/embedding/transcriptRag';
import { findCompressionBoundary } from '@/lib/llm/chatCompression';
import { buildLlmRoutingOptions } from '@/lib/llm/llmRoutingOptions';
import { logger, serializeError } from '@/lib/logger';

const VALID_DEPTHS: ThinkingDepth[] = ['low', 'medium', 'high'];

const chatLogger = logger.child({ component: 'chat-api' });

/**
 * 把任意来源的错误转为"是否上下文超长"判定。
 * 各家 LLM API 在超长时返回的错误文本不一致，统一靠关键字嗅探。
 */
function isContextLengthError(err: unknown): boolean {
  if (err instanceof ChatContextEOLError) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('context_length') ||
    msg.includes('context length') ||
    msg.includes('maximum context') ||
    msg.includes('too many tokens') ||
    msg.includes('reduce the length') ||
    msg.includes('413') // some providers
  );
}

interface TranscriptSegmentInput {
  text?: unknown;
  startMs?: unknown;
}

function parseTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const out: TranscriptSegment[] = [];
  for (const raw of value as TranscriptSegmentInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    const startMs = typeof raw.startMs === 'number' ? raw.startMs : 0;
    if (!text) continue;
    out.push({ text, startMs });
  }
  return out;
}

export const POST = withRequestLogging('llm:chat', async (req: Request) => {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'llm:chat',
    windowMs: 60_000,
    key: `user:${payload.id}`,
  });
  if (rateLimited) return rateLimited;

  try {
    const body = await req.json();

    const conversationId = readRequiredText(
      body.conversationId,
      'conversationId',
      64
    );
    const question = readRequiredText(
      body.question,
      'question',
      LLM_LIMITS.question
    );
    const summaryContext = readOptionalText(
      body.summaryContext,
      'summaryContext',
      LLM_LIMITS.summaryContext
    );
    const transcript = parseTranscriptSegments(body.transcript);
    const totalTranscriptMs =
      typeof body.totalTranscriptMs === 'number'
        ? body.totalTranscriptMs
        : transcript.length > 0
          ? transcript[transcript.length - 1].startMs
          : 0;
    const requestedModel = readOptionalIdentifier(
      body.model,
      'model',
      LLM_LIMITS.requestedModel
    );
    const requestedDepth =
      typeof body.thinkingDepth === 'string'
        ? (body.thinkingDepth as ThinkingDepth)
        : undefined;

    const depth: ThinkingDepth =
      requestedDepth && VALID_DEPTHS.includes(requestedDepth)
        ? requestedDepth
        : 'medium';

    // 把请求体的 thinkingDepth + thinkingEnabled 三态映射成 gateway 的 ThinkingPreference：
    //   缺省字段           → auto（让模型/网关自行决定）
    //   thinkingEnabled=false → off（明确不思考）
    //   thinkingEnabled=true + depth → depth（DEPTH 模式选档位）
    //   thinkingEnabled=true 无 depth → forced（强制思考但用模型默认深度）
    const hasThinkingFlag = typeof body.thinkingEnabled === 'boolean';
    const thinkingPreference: ThinkingPreference = !hasThinkingFlag
      ? 'auto'
      : body.thinkingEnabled === false
        ? 'off'
        : requestedDepth && VALID_DEPTHS.includes(requestedDepth)
          ? requestedDepth
          : 'forced';

    // ── 验证 conversation 归属 ──
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
          },
        },
      },
    });
    if (!conversation || conversation.session.userId !== payload.id) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }
    if (conversation.endedAt) {
      return NextResponse.json(
        { error: 'Conversation is closed (read-only)' },
        { status: 409 }
      );
    }

    const language = conversation.session.targetLang || 'zh';
    const sessionId = conversation.sessionId;

    // 找最近一条 role='system' 作为"主动压缩"截断点。新压缩消息带有
    // compressed-through 标记，不再依赖 system 消息的 createdAt 物理位置。
    const compressionBoundary = findCompressionBoundary(conversation.messages);
    const lastSystemContent = compressionBoundary.summary;
    const effectiveMessages = conversation.messages.slice(
      compressionBoundary.splitIndex + 1
    );

    // ── 解析模型 & provider 配置 ──
    const selection = await resolveAuthorizedLlmSelection(
      payload.id,
      requestedModel
    );
    const finalDepth = resolveEffectiveThinkingDepth(
      selection.user.role,
      depth,
      selection.providerConfig
    );

    // 把请求里带具体档位的 preference 替换为受 access.ts 钳制后的 finalDepth
    // （FREE 用户的 high → medium）。auto/off/forced 不带档位，保持原样。
    const effectivePreference: ThinkingPreference =
      thinkingPreference === 'low' ||
      thinkingPreference === 'medium' ||
      thinkingPreference === 'high'
        ? finalDepth
        : thinkingPreference;

    // 拿到 contextWindow 用于预算
    // 复用 access.ts 已经解析好的 providerConfig（modelId / providerName 路径都会填充），
    // 都没指定时落到 DB CHAT 默认 model（再 fallback 到 env var）。这一路必须与
    // 下方 callLLMWithHistory 的 provider 解析保持完全一致，否则预算和实调会指向
    // 不同 provider，contextWindow / max_tokens 错位会让降级判定失真。
    const provider =
      selection.providerConfig ?? (await getProviderForPurpose('CHAT'));
    const budget = computeContextBudget(provider, provider.contextWindow);

    // ── 把 DB 消息转 ConversationTurn[] ──
    const history: ConversationTurn[] = effectiveMessages
      .filter((m): m is typeof m & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant'
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        transcriptOffsetMs: m.transcriptOffsetMs ?? 0,
      }));

    // 每一级降级都会产出自己的 transcript/summary 窗口，必须在这里重建 prompt。
    const buildSystemPrompt = (
      transcriptContext: string,
      summaryText: string
    ) => {
      const chatSystemPrompt = buildChatPrompt(
        transcriptContext,
        summaryText,
        finalDepth
      );
      return lastSystemContent
        ? `[Earlier conversation summary]:\n${lastSystemContent}\n\n${chatSystemPrompt}`
        : chatSystemPrompt;
    };

    // ── 主循环：降级链 + 反应式 retry ──
    const ragRetriever = makeRagRetrieverForSession(sessionId);

    let currentLevel: DegradationLevel = Math.max(
      conversation.degradationLevel,
      1
    ) as DegradationLevel;
    let llmResponse: { text: string; thinking?: string } | null = null;
    let effectiveLevel: DegradationLevel = currentLevel;

    while (currentLevel <= DEGRADATION_MAX_LEVEL) {
      try {
        const ctx = await buildChatContext({
          history,
          userInput: question,
          transcript,
          summary: summaryContext,
          totalTranscriptMs,
          minLevel: currentLevel,
          inputBudget: budget.inputBudget,
          buildSystemPrompt,
          // 压缩历史用 CHAT 用途（其实更适合用 FINAL_SUMMARY 但 CHAT 模型也行）
          callLLM: (s: string, u: string) =>
            callLLM(s, u, { purpose: 'CHAT' }),
          language,
          ragRetrieve: ragRetriever,
        });
        effectiveLevel = ctx.level;

        llmResponse = await callLLMWithHistory(ctx.systemPrompt, ctx.messages, {
          ...buildLlmRoutingOptions(selection, 'CHAT'),
          thinkingPreference: effectivePreference,
          detailed: true,
        });
        break;
      } catch (err) {
        if (isContextLengthError(err)) {
          if (currentLevel >= DEGRADATION_MAX_LEVEL) {
            chatLogger.warn(
              {
                conversationId,
                level: currentLevel,
                err: serializeError(err),
              },
              'chat 达到 EOL —— 提示用户新建对话'
            );
            return NextResponse.json(
              {
                error: 'context_full',
                message:
                  '当前对话上下文已满，所有降级策略均无法塞下。建议新建对话继续。',
                level: currentLevel,
              },
              { status: 413 }
            );
          }
          chatLogger.info(
            {
              conversationId,
              fromLevel: currentLevel,
              toLevel: currentLevel + 1,
            },
            'chat 上下文超限，反应式降级'
          );
          currentLevel = (currentLevel + 1) as DegradationLevel;
          continue;
        }
        throw err;
      }
    }

    if (!llmResponse) {
      return NextResponse.json(
        { error: 'context_full', message: '上下文降级失败' },
        { status: 413 }
      );
    }

    // ── 持久化：user 消息 + assistant 消息；更新 conversation.degradationLevel ──
    const userTranscriptOffset = totalTranscriptMs;
    await prisma.$transaction([
      prisma.conversationMessage.create({
        data: {
          conversationId,
          role: 'user',
          content: question,
          transcriptOffsetMs: userTranscriptOffset,
        },
      }),
      prisma.conversationMessage.create({
        data: {
          conversationId,
          role: 'assistant',
          content: llmResponse.text,
          transcriptOffsetMs: userTranscriptOffset,
          degradationLevel: effectiveLevel,
        },
      }),
      // 单调降级：DB 里只能向下不能向上
      prisma.conversation.update({
        where: { id: conversationId },
        data: {
          degradationLevel: Math.max(
            conversation.degradationLevel,
            effectiveLevel
          ),
        },
      }),
    ]);

    return NextResponse.json({
      reply: llmResponse.text,
      thinking: llmResponse.thinking ?? null,
      model:
        selection.providerConfig?.displayName ||
        selection.providerName ||
        process.env.LLM_ACTIVE_PROVIDER ||
        'default',
      thinkingDepth: finalDepth,
      level: effectiveLevel,
    });
  } catch (error) {
    if (error instanceof LLMValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof LLMAccessError) {
      const status = error.message === 'User not found' ? 404 : 403;
      return NextResponse.json({ error: error.message }, { status });
    }

    chatLogger.error({ err: serializeError(error) }, 'Chat error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
