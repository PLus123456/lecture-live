import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  callLLM,
  callLLMWithHistoryStream,
  getProviderForPurpose,
  type ChatHistoryMessage,
  type ChatImageInput,
  type LLMStreamEvent,
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
import {
  parseImageDataUrl,
  persistChatImage,
  type DecodedChatImage,
} from '@/lib/llm/chatImageStorage';

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

/**
 * 解析请求体里的 images 字段（base64 data URL 数组），校验张数与单张大小。
 * 任一张非法 / 超限即抛 LLMValidationError。
 */
function parseChatImages(value: unknown): DecodedChatImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new LLMValidationError('images must be an array');
  }
  if (value.length > LLM_LIMITS.chatImageCount) {
    throw new LLMValidationError(
      `Too many images (max ${LLM_LIMITS.chatImageCount})`
    );
  }
  const out: DecodedChatImage[] = [];
  for (const raw of value) {
    const decoded = parseImageDataUrl(raw);
    if (!decoded) {
      throw new LLMValidationError('Invalid image data URL');
    }
    if (decoded.byteLength > LLM_LIMITS.chatImageBytes) {
      throw new LLMValidationError('Image too large');
    }
    out.push(decoded);
  }
  return out;
}

/** SSE 帧编码：event: <name>\ndata: <json>\n\n */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
    const images = parseChatImages(body.images);
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

    // 拿到 contextWindow 用于预算。复用 access.ts 已解析好的 providerConfig，
    // 必须与下方流式调用的 provider 解析保持一致，否则预算与实调指向不同 provider。
    const provider =
      selection.providerConfig ?? (await getProviderForPurpose('CHAT'));
    const budget = computeContextBudget(provider, provider.contextWindow);

    // ── 持久化 user 消息（在 LLM 调用之前）──
    // 早写一步：刷新页面 / 思考阶段中断时，用户的提问已经在 DB 里，不会丢失（修复 2.2）。
    // 图片落本地磁盘，content 里内嵌 markdown 图片引用，刷新后能重新渲染（修复 2.1）。
    const userTranscriptOffset = totalTranscriptMs;
    let persistedQuestionContent = question;
    if (images.length > 0) {
      const saved = await Promise.all(
        images.map(async (img) => {
          try {
            return `![image](${await persistChatImage(conversationId, img)})`;
          } catch (err) {
            chatLogger.warn(
              { conversationId, err: serializeError(err) },
              '聊天图片持久化失败，本轮仍会发给模型但刷新后不可见'
            );
            return null;
          }
        })
      );
      const refs = saved.filter((ref): ref is string => ref !== null);
      if (refs.length > 0) {
        persistedQuestionContent = `${question}\n\n${refs.join('\n')}`;
      }
    }
    await prisma.conversationMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: persistedQuestionContent,
        transcriptOffsetMs: userTranscriptOffset,
      },
    });

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

    // 当前轮要发给模型的图片（仅当前轮；历史轮图片不重发）
    const currentTurnImages: ChatImageInput[] = images.map((img) => ({
      mediaType: img.mediaType,
      data: img.data,
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

    const ragRetriever = makeRagRetrieverForSession(sessionId);
    const routingOptions = buildLlmRoutingOptions(selection, 'CHAT');
    const modelLabel =
      selection.providerConfig?.displayName ||
      selection.providerName ||
      process.env.LLM_ACTIVE_PROVIDER ||
      'default';

    // ── 流式响应：SSE ReadableStream ──
    // withRequestLogging 只读 response.status，不缓冲 body，故流可直接透传。
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        };

        let currentLevel: DegradationLevel = Math.max(
          conversation.degradationLevel,
          1
        ) as DegradationLevel;
        let effectiveLevel: DegradationLevel = currentLevel;
        let accumulatedText = '';
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        // 一旦向客户端发出过 thinking/text 字节，就不能再重试降级了 —— 已 commit。
        let emittedBytes = false;
        let succeeded = false;

        // 落库 assistant 消息（成功路径 / 部分失败兜底共用）
        const persistAssistantMessage = () =>
          prisma.conversationMessage.create({
            data: {
              conversationId,
              role: 'assistant',
              content: accumulatedText,
              transcriptOffsetMs: userTranscriptOffset,
              degradationLevel: effectiveLevel,
              inputTokens: inputTokens ?? null,
              outputTokens: outputTokens ?? null,
            },
          });

        try {
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
                callLLM: (s: string, u: string) =>
                  callLLM(s, u, { purpose: 'CHAT' }),
                language,
                ragRetrieve: ragRetriever,
              });
              effectiveLevel = ctx.level;

              // 把 chatContextBuilder 产出的纯文本 messages 转成可带图的 ChatHistoryMessage。
              // 仅最后一条（当前轮 user 输入）挂图片。
              const streamMessages: ChatHistoryMessage[] = ctx.messages.map(
                (m, idx) => {
                  const isCurrentTurn =
                    idx === ctx.messages.length - 1 && m.role === 'user';
                  return isCurrentTurn && currentTurnImages.length > 0
                    ? { ...m, images: currentTurnImages }
                    : { role: m.role, content: m.content };
                }
              );

              const result = await callLLMWithHistoryStream(
                ctx.systemPrompt,
                streamMessages,
                {
                  ...routingOptions,
                  thinkingPreference: effectivePreference,
                },
                (ev: LLMStreamEvent) => {
                  if (ev.type === 'thinking' && ev.delta) {
                    emittedBytes = true;
                    send('thinking', { delta: ev.delta });
                  } else if (ev.type === 'text' && ev.delta) {
                    emittedBytes = true;
                    accumulatedText += ev.delta;
                    send('text', { delta: ev.delta });
                  } else if (ev.type === 'usage') {
                    if (typeof ev.inputTokens === 'number') {
                      inputTokens = ev.inputTokens;
                    }
                    if (typeof ev.outputTokens === 'number') {
                      outputTokens = ev.outputTokens;
                    }
                  }
                }
              );
              accumulatedText = result.text || accumulatedText;
              if (typeof result.usage?.inputTokens === 'number') {
                inputTokens = result.usage.inputTokens;
              }
              if (typeof result.usage?.outputTokens === 'number') {
                outputTokens = result.usage.outputTokens;
              }
              succeeded = true;
              break;
            } catch (err) {
              // 已经流出字节 → 不能重试，直接抛给外层报错
              if (emittedBytes) throw err;
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
                  send('error', {
                    error:
                      '当前对话上下文已满，所有降级策略均无法塞下。建议新建对话继续。',
                    contextFull: true,
                  });
                  controller.close();
                  return;
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

          if (!succeeded) {
            send('error', {
              error: '上下文降级失败',
              contextFull: true,
            });
            controller.close();
            return;
          }

          // ── 持久化 assistant 消息 + 更新 conversation.degradationLevel ──
          await prisma.$transaction([
            persistAssistantMessage(),
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

          send('done', {
            model: modelLabel,
            thinkingDepth: finalDepth,
            level: effectiveLevel,
            budget: budget.inputBudget,
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
          });
          controller.close();
        } catch (err) {
          chatLogger.error(
            { conversationId, err: serializeError(err) },
            'chat 流式生成失败'
          );
          // 已经流出部分内容时，仍把 partial assistant 消息落库，避免用户刷新后看到空回复
          if (accumulatedText.trim()) {
            await persistAssistantMessage().catch(() => {});
          }
          send('error', {
            error:
              err instanceof Error ? err.message : 'Chat generation failed',
            contextFull: false,
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
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
