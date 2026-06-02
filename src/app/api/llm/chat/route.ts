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
  estimateRawContextTokens,
  type ConversationTurn,
  type DegradationLevel,
  type TranscriptSegment,
  DEGRADATION_MAX_LEVEL,
} from '@/lib/llm/chatContextBuilder';
import { computeContextBudget } from '@/lib/llm/tokenBudget';
import {
  makeRagRetrieverForRecordings,
  makeRagRetrieverForSession,
} from '@/lib/llm/embedding/transcriptRag';
import { findCompressionBoundary } from '@/lib/llm/chatCompression';
import { buildLlmRoutingOptions } from '@/lib/llm/llmRoutingOptions';
import { logger, serializeError } from '@/lib/logger';
import {
  parseImageDataUrl,
  persistChatImage,
  type DecodedChatImage,
} from '@/lib/llm/chatImageStorage';
import {
  buildAttachmentsSystemMessage,
  concatRecordingReports,
  extractAttachmentImages,
  loadAttachmentsAsSystemBlocks,
  renderReportAsText,
} from '@/lib/llm/chatAttachments';
import {
  loadSessionReport,
  loadSessionTranscriptBundle,
} from '@/lib/sessionPersistence';
import { toExportSegments } from '@/lib/export/types';
import type { SessionReportData } from '@/types/report';
import type { SummaryBlock } from '@/types/summary';

const VALID_DEPTHS: ThinkingDepth[] = ['low', 'medium', 'high'];

const chatLogger = logger.child({ component: 'chat-api' });

/**
 * 丢弃历史末尾"未配对的 user 消息"。
 * 上一轮若被客户端 abort/中断，user 消息已落库但没有配对的 assistant 回复，
 * 会在历史里留下一条悬空的 user 轮。本轮提问是单独追加的，所以这里安全地把
 * 末尾孤儿 user 去掉，避免 LLM 看到连续两个 user 轮。（见 ISSUES_REPORT 第 1 批）
 */
function dropTrailingOrphanUser(
  history: ConversationTurn[]
): ConversationTurn[] {
  if (history.length > 0 && history[history.length - 1]?.role === 'user') {
    return history.slice(0, -1);
  }
  return history;
}

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

function parseAttachmentIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new LLMValidationError('attachmentIds must be an array');
  }
  if (value.length > 32) {
    throw new LLMValidationError('Too many attachmentIds (max 32)');
  }
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new LLMValidationError('attachmentIds must be strings');
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 64) {
      throw new LLMValidationError('attachmentIds entry invalid');
    }
    ids.push(trimmed);
  }
  return ids;
}

/** SSE 帧编码：event: <name>\ndata: <json>\n\n */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 把 transcript bundle 的 segments （unknown[]） 规范成 TranscriptSegment[]。
 * 复用 toExportSegments 的字段宽容解析，再投影到 chatContextBuilder 期望的最小形状。
 */
function bundleSegmentsToTranscriptSegments(
  segments: unknown[]
): TranscriptSegment[] {
  return toExportSegments(segments).map((s) => ({
    text: s.text,
    startMs: s.startMs,
  }));
}

// ──────────────────────────────────────────────────────────────────────
// 公共类型：两条 chat 路径在 SSE 流式封装上完全一致，参数收敛到这个结构
// ──────────────────────────────────────────────────────────────────────
interface StreamChatArgs {
  conversationId: string;
  /** 完整 system prompt 构造器（包含 transcript/summary 占位） */
  buildSystemPrompt: (transcriptContext: string, summaryContext: string) => string;
  /** 用于 chatContextBuilder 的 transcript（多录音版本可以是拼接后的） */
  transcript: ReadonlyArray<TranscriptSegment>;
  /** 用于 chatContextBuilder 的 summary 文本 */
  summary: string;
  /** 当前对话的总 transcript 长度（毫秒），仅时间锚点用 */
  totalTranscriptMs: number;
  /** 用户语言（zh/en） */
  language: string;
  /** 历史消息（user/assistant） */
  history: ReadonlyArray<ConversationTurn>;
  /** 当前用户输入 */
  question: string;
  /** 历史最低降级级别 */
  initialLevel: DegradationLevel;
  /** 当前对话 record 上记录的 degradationLevel（用于落库 max） */
  conversationDegradationLevel: number;
  /** 输入 token 预算 */
  inputBudget: number;
  /** 当前轮发给模型的图片 */
  currentTurnImages: ChatImageInput[];
  /** Provider routing & thinking */
  routingOptions: ReturnType<typeof buildLlmRoutingOptions>;
  thinkingPreference: ThinkingPreference;
  modelLabel: string;
  finalDepth: ThinkingDepth;
  /** 用户消息存进 DB 时记录的 transcriptOffsetMs，assistant 消息复用相同值 */
  userTranscriptOffset: number;
  /** RAG 检索（单录音或多录音都通过该闭包注入） */
  ragRetriever?: (
    query: string,
    transcript: ReadonlyArray<TranscriptSegment>,
    maxTokens: number
  ) => Promise<string>;
  /** 已应用过截断的多录音 report 文本（可选）；存在则当 L6+ 时作为额外 system 消息 */
  reportText?: string;
  /** 已知 transcript 体量过大时强制起点；buildChatContext 会取 max(minLevel, forceMinLevel) */
  forceMinLevel?: DegradationLevel;
  /** Attachments 抽文本拼好的整段，将作为最前置的 system 段拼到 systemPrompt 头部 */
  attachmentsSystemMessage?: string;
}

/**
 * 把已组装好的 chat 上下文用 SSE 流出去，并落库 assistant 消息 +
 * 更新 conversation.degradationLevel。两条路径共用这块「流式 + 持久化」的尾段。
 */
function streamChatResponse(
  args: StreamChatArgs
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      };

      let currentLevel: DegradationLevel = Math.max(
        args.initialLevel,
        1
      ) as DegradationLevel;
      let effectiveLevel: DegradationLevel = currentLevel;
      let accumulatedText = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      // 一旦向客户端发出过 thinking/text 字节，就不能再重试降级了 —— 已 commit。
      let emittedBytes = false;
      let succeeded = false;

      const persistAssistantMessage = () =>
        prisma.conversationMessage.create({
          data: {
            conversationId: args.conversationId,
            role: 'assistant',
            content: accumulatedText,
            transcriptOffsetMs: args.userTranscriptOffset,
            degradationLevel: effectiveLevel,
            inputTokens: inputTokens ?? null,
            outputTokens: outputTokens ?? null,
          },
        });

      try {
        while (currentLevel <= DEGRADATION_MAX_LEVEL) {
          try {
            const ctx = await buildChatContext({
              history: args.history,
              userInput: args.question,
              transcript: args.transcript,
              summary: args.summary,
              totalTranscriptMs: args.totalTranscriptMs,
              minLevel: currentLevel,
              inputBudget: args.inputBudget,
              buildSystemPrompt: args.buildSystemPrompt,
              callLLM: (s: string, u: string) =>
                callLLM(s, u, { purpose: 'CHAT' }),
              language: args.language,
              ragRetrieve: args.ragRetriever,
              reportText: args.reportText,
              // 把附件 system 文本喂进预算计算：它会和 reportText 一样被恒定前置到
              // 所有降级级别（见下方 systemSegments），传入完整前置串使估算 token 与
              // 真实发送量一致，降级链才能正确感知附件占用、避免反应式重试到 EOL。
              attachmentsText: args.attachmentsSystemMessage,
              forceMinLevel: args.forceMinLevel,
            });
            effectiveLevel = ctx.level;

            // 拼装最终发送给 gateway 的 messages：
            //  - 顶部 system 块（chatContextBuilder 已组装好；含 timeAnchor/compressed-history/...）
            //    我们再在前面追加 attachmentsSystemMessage 和 reportText 两条独立 system 段。
            //  - 中间是 history + 当前轮 user。
            // gateway 的 callLLMWithHistoryStream 只接受 user/assistant 角色的 message 数组 +
            // 单独的 systemPrompt 参数，所以把所有 system 内容合到一段 systemPrompt 里。
            const systemSegments: string[] = [];
            if (args.attachmentsSystemMessage) {
              systemSegments.push(args.attachmentsSystemMessage);
            }
            // ctx.reportText 是 buildChatContext 已截断好的（≤ 8000 字符）
            if (ctx.reportText) {
              systemSegments.push(
                `[Recording reports — long-context anchor]:\n${ctx.reportText}`
              );
            }
            systemSegments.push(ctx.systemPrompt);
            const finalSystemPrompt = systemSegments.join('\n\n');

            const streamMessages: ChatHistoryMessage[] = ctx.messages.map(
              (m, idx) => {
                const isCurrentTurn =
                  idx === ctx.messages.length - 1 && m.role === 'user';
                return isCurrentTurn && args.currentTurnImages.length > 0
                  ? { ...m, images: args.currentTurnImages }
                  : { role: m.role, content: m.content };
              }
            );

            const result = await callLLMWithHistoryStream(
              finalSystemPrompt,
              streamMessages,
              {
                ...args.routingOptions,
                thinkingPreference: args.thinkingPreference,
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
            if (emittedBytes) throw err;
            if (isContextLengthError(err)) {
              if (currentLevel >= DEGRADATION_MAX_LEVEL) {
                chatLogger.warn(
                  {
                    conversationId: args.conversationId,
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
                  conversationId: args.conversationId,
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

        await prisma.$transaction([
          persistAssistantMessage(),
          prisma.conversation.update({
            where: { id: args.conversationId },
            data: {
              degradationLevel: Math.max(
                args.conversationDegradationLevel,
                effectiveLevel
              ),
            },
          }),
        ]);

        send('done', {
          model: args.modelLabel,
          thinkingDepth: args.finalDepth,
          level: effectiveLevel,
          budget: args.inputBudget,
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
        });
        controller.close();
      } catch (err) {
        chatLogger.error(
          { conversationId: args.conversationId, err: serializeError(err) },
          'chat 流式生成失败'
        );
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
}

// ──────────────────────────────────────────────────────────────────────
// 解析过且通过校验的请求体
// ──────────────────────────────────────────────────────────────────────
interface ParsedChatRequest {
  conversationId: string;
  question: string;
  transcript: TranscriptSegment[];
  totalTranscriptMs: number;
  summaryContext: string;
  images: DecodedChatImage[];
  attachmentIds?: string[];
  requestedModel: string;
  depth: ThinkingDepth;
  thinkingPreference: ThinkingPreference;
}

async function parseRequest(req: Request): Promise<ParsedChatRequest> {
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
  const attachmentIds = parseAttachmentIds(body.attachmentIds);
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

  // thinkingEnabled 三态 → ThinkingPreference 映射
  const hasThinkingFlag = typeof body.thinkingEnabled === 'boolean';
  const thinkingPreference: ThinkingPreference = !hasThinkingFlag
    ? 'auto'
    : body.thinkingEnabled === false
      ? 'off'
      : requestedDepth && VALID_DEPTHS.includes(requestedDepth)
        ? requestedDepth
        : 'forced';

  return {
    conversationId,
    question,
    transcript,
    totalTranscriptMs,
    summaryContext,
    images,
    attachmentIds,
    requestedModel: requestedModel ?? '',
    depth,
    thinkingPreference,
  };
}

// ──────────────────────────────────────────────────────────────────────
// 路由 entry
// ──────────────────────────────────────────────────────────────────────
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
    const parsed = await parseRequest(req);

    // 一次性把 conversation + messages + 关联 session/recordings 取出，避免后面分支再多次查询。
    // 归属用 conversation.userId（include 会带回所有标量字段），不再查 attachments 来反推归属；
    // 附件实际下载仍在 chatAttachments.ts 里按 conversationId 做。
    const conversation = await prisma.conversation.findUnique({
      where: { id: parsed.conversationId },
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
          },
        },
        sessions: {
          include: {
            session: {
              select: {
                id: true,
                userId: true,
                targetLang: true,
                title: true,
                recordingPath: true,
                transcriptPath: true,
                summaryPath: true,
                reportPath: true,
              },
            },
          },
        },
      },
    });

    if (!conversation) {
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

    // 统一归属：Conversation.userId 命中本人才放行。userId 为 NULL 的无主孤儿、或他人
    // 对话一律 404（同时关闭此前的 orphan"宽进"与"含他人 session 即整体拒绝"的混合放行）。
    if (conversation.userId !== payload.id) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const isLegacy = conversation.session !== null;

    if (isLegacy) {
      // ── 旧路径：单录音 chat ── 行为完全不变 ──
      return await handleSessionChat({
        parsed,
        conversation: {
          id: conversation.id,
          sessionId: conversation.sessionId!,
          targetLang: conversation.session!.targetLang,
          degradationLevel: conversation.degradationLevel,
          messages: conversation.messages,
        },
        userId: payload.id,
      });
    }

    // ── 新路径：全局 chat（无 session 绑定）──
    // 归属已由 conversation.userId 校验通过。挂载录音在 attach 时已限定属于本人，
    // 这里仍按 userId 过滤一遍做纵深防御（防历史脏数据混入他人 session）。
    const ownedSessions = conversation.sessions
      .map((cs) => cs.session)
      .filter((s) => s.userId === payload.id);

    return await handleGlobalChat({
      parsed,
      conversation: {
        id: conversation.id,
        degradationLevel: conversation.degradationLevel,
        messages: conversation.messages,
        ownedSessions,
      },
      userId: payload.id,
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

// ──────────────────────────────────────────────────────────────────────
// 旧路径：单录音 chat（与改造前的行为 byte-for-byte 一致）
// ──────────────────────────────────────────────────────────────────────
interface HandleSessionChatArgs {
  parsed: ParsedChatRequest;
  conversation: {
    id: string;
    sessionId: string;
    targetLang: string | null;
    degradationLevel: number;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      transcriptOffsetMs: number | null;
    }>;
  };
  userId: string;
}

async function handleSessionChat(args: HandleSessionChatArgs): Promise<Response> {
  const { parsed, conversation, userId } = args;
  const language = conversation.targetLang || 'zh';
  const sessionId = conversation.sessionId;

  // 找最近一条 role='system' 作为"主动压缩"截断点
  const compressionBoundary = findCompressionBoundary(conversation.messages);
  const lastSystemContent = compressionBoundary.summary;
  const effectiveMessages = conversation.messages.slice(
    compressionBoundary.splitIndex + 1
  );

  // ── 解析模型 & provider 配置 ──
  const selection = await resolveAuthorizedLlmSelection(
    userId,
    parsed.requestedModel || undefined
  );
  const finalDepth = resolveEffectiveThinkingDepth(
    selection.user.role,
    parsed.depth,
    selection.providerConfig
  );

  const effectivePreference: ThinkingPreference =
    parsed.thinkingPreference === 'low' ||
    parsed.thinkingPreference === 'medium' ||
    parsed.thinkingPreference === 'high'
      ? finalDepth
      : parsed.thinkingPreference;

  const provider =
    selection.providerConfig ?? (await getProviderForPurpose('CHAT'));
  const budget = computeContextBudget(provider, provider.contextWindow);

  // ── 持久化 user 消息 ──
  const userTranscriptOffset = parsed.totalTranscriptMs;
  let persistedQuestionContent = parsed.question;
  if (parsed.images.length > 0) {
    const saved = await Promise.all(
      parsed.images.map(async (img) => {
        try {
          return `![image](${await persistChatImage(conversation.id, img)})`;
        } catch (err) {
          chatLogger.warn(
            { conversationId: conversation.id, err: serializeError(err) },
            '聊天图片持久化失败，本轮仍会发给模型但刷新后不可见'
          );
          return null;
        }
      })
    );
    const refs = saved.filter((ref): ref is string => ref !== null);
    if (refs.length > 0) {
      persistedQuestionContent = `${parsed.question}\n\n${refs.join('\n')}`;
    }
  }
  // user 消息在调用 LLM 之前落库，避免请求中断丢失用户输入。代价是本轮若被
  // abort/失败且无 assistant 配对会留下"孤儿 user 消息"，由 dropTrailingOrphanUser 兜底。
  await prisma.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: persistedQuestionContent,
      transcriptOffsetMs: userTranscriptOffset,
    },
  });

  const history: ConversationTurn[] = dropTrailingOrphanUser(
    effectiveMessages
      .filter((m): m is typeof m & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant'
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        transcriptOffsetMs: m.transcriptOffsetMs ?? 0,
      }))
  );

  const currentTurnImages: ChatImageInput[] = parsed.images.map((img) => ({
    mediaType: img.mediaType,
    data: img.data,
  }));

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

  // ── 长录音决策（与 global chat 一致）── 估算 transcript+history+input 总 token，
  // 超 L1*80% 直接 forceMinLevel=6 走 RAG：长 transcript 此前在 L1 会因超预算反应式 retry
  // 逐级升级、首条消息慢，直接跳到 L6 省掉中间的失败-重试。短 transcript 不受影响（仍 L1）。
  const rawEstimate = estimateRawContextTokens(
    parsed.transcript,
    history,
    parsed.question
  );
  const forceMinLevel: DegradationLevel | undefined =
    rawEstimate > budget.inputBudget * 0.8 ? 6 : undefined;
  if (forceMinLevel) {
    chatLogger.info(
      {
        conversationId: conversation.id,
        rawEstimate,
        inputBudget: budget.inputBudget,
      },
      'legacy 单录音 chat 超 L1 80% 阈值，forceMinLevel=6（直接走 RAG，省反应式重试）'
    );
  }

  return streamChatResponse({
    conversationId: conversation.id,
    buildSystemPrompt,
    transcript: parsed.transcript,
    summary: parsed.summaryContext,
    totalTranscriptMs: parsed.totalTranscriptMs,
    language,
    history,
    question: parsed.question,
    initialLevel: Math.max(conversation.degradationLevel, 1) as DegradationLevel,
    conversationDegradationLevel: conversation.degradationLevel,
    inputBudget: budget.inputBudget,
    currentTurnImages,
    routingOptions,
    thinkingPreference: effectivePreference,
    modelLabel,
    finalDepth,
    userTranscriptOffset,
    ragRetriever,
    forceMinLevel,
  });
}

// ──────────────────────────────────────────────────────────────────────
// 新路径：全局 chat（多录音 + 报告 + 附件）
// ──────────────────────────────────────────────────────────────────────
interface HandleGlobalChatArgs {
  parsed: ParsedChatRequest;
  conversation: {
    id: string;
    degradationLevel: number;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      transcriptOffsetMs: number | null;
    }>;
    ownedSessions: Array<{
      id: string;
      userId: string;
      targetLang: string;
      title: string;
      recordingPath: string | null;
      transcriptPath: string | null;
      summaryPath: string | null;
      reportPath: string | null;
    }>;
  };
  userId: string;
}

async function handleGlobalChat(args: HandleGlobalChatArgs): Promise<Response> {
  const { parsed, conversation, userId } = args;

  // 全局 chat 没有"当前 session 的 targetLang"。优先取已挂的第一个录音的 targetLang，
  // 否则默认 zh —— buildTimeAnchor 与 history 压缩 prompt 的措辞会跟着语言变。
  const language =
    conversation.ownedSessions[0]?.targetLang || 'zh';

  // ── 解析模型 & provider ──
  const selection = await resolveAuthorizedLlmSelection(
    userId,
    parsed.requestedModel || undefined
  );
  const finalDepth = resolveEffectiveThinkingDepth(
    selection.user.role,
    parsed.depth,
    selection.providerConfig
  );
  const effectivePreference: ThinkingPreference =
    parsed.thinkingPreference === 'low' ||
    parsed.thinkingPreference === 'medium' ||
    parsed.thinkingPreference === 'high'
      ? finalDepth
      : parsed.thinkingPreference;

  const provider =
    selection.providerConfig ?? (await getProviderForPurpose('CHAT'));
  const budget = computeContextBudget(provider, provider.contextWindow);

  // ── 并行加载附件 + 各 session 的 transcript / summary / report ──
  const [attachmentBlocks, sessionAssets] = await Promise.all([
    loadAttachmentsAsSystemBlocks({
      conversationId: conversation.id,
      attachmentIds: parsed.attachmentIds,
    }),
    Promise.all(
      conversation.ownedSessions.map(async (s) => {
        const bundle = await loadSessionTranscriptBundle(s).catch(() => null);
        // 注意：loadSessionTranscriptBundle 内部已经做了 transcript+summary 同时 IO；
        // 对应这里 summary 也复用 bundle.summaries，避免再下载一次 summaryPath。
        return {
          session: s,
          segments: bundle
            ? bundleSegmentsToTranscriptSegments(bundle.segments)
            : ([] as TranscriptSegment[]),
          summaries: (bundle?.summaries ?? []) as SummaryBlock[],
        };
      })
    ),
  ]);

  // ── 拼出 combined transcript（按 session 顺序拼接；每条 segment 的 startMs
  // 平移 + 偏移基准），并准备多录音 RAG 闭包 ──
  const combinedTranscript: TranscriptSegment[] = [];
  let cumulativeMs = 0;
  const segmentsByRecording = new Map<string, TranscriptSegment[]>();
  for (const asset of sessionAssets) {
    segmentsByRecording.set(asset.session.id, asset.segments);
    for (const seg of asset.segments) {
      combinedTranscript.push({
        text: seg.text,
        startMs: cumulativeMs + seg.startMs,
      });
    }
    // 用最后一段的 endMs 作为该 session 的总长度近似（segments 已按时间序）
    const last = asset.segments[asset.segments.length - 1];
    if (last) {
      cumulativeMs += last.startMs + 1000; // 加 1s buffer 防止两段时间锚重叠
    }
  }
  const totalTranscriptMs = cumulativeMs;

  const recordingIds = conversation.ownedSessions.map((s) => s.id);
  // 内容签名 = 所有挂载录音的 segment 总数。挂载录音增长（如录制中的录音继续转写）时签名变化
  // → 多录音 RAG 增量重建感知新内容；集合与各录音长度都不变才整体命中旧快照。
  const ragContentSignature = combinedTranscript.length;
  const ragRetriever =
    recordingIds.length > 0
      ? makeRagRetrieverForRecordings(
          recordingIds,
          async (rid) => segmentsByRecording.get(rid) ?? [],
          ragContentSignature
        )
      : undefined;

  // ── 持久化 user 消息（在 LLM 调用之前）──
  const userTranscriptOffset = parsed.totalTranscriptMs;
  let persistedQuestionContent = parsed.question;
  if (parsed.images.length > 0) {
    const saved = await Promise.all(
      parsed.images.map(async (img) => {
        try {
          return `![image](${await persistChatImage(conversation.id, img)})`;
        } catch (err) {
          chatLogger.warn(
            { conversationId: conversation.id, err: serializeError(err) },
            '聊天图片持久化失败，本轮仍会发给模型但刷新后不可见'
          );
          return null;
        }
      })
    );
    const refs = saved.filter((ref): ref is string => ref !== null);
    if (refs.length > 0) {
      persistedQuestionContent = `${parsed.question}\n\n${refs.join('\n')}`;
    }
  }
  // user 消息在调用 LLM 之前落库，避免请求中断丢失用户输入。代价是本轮若被
  // abort/失败且无 assistant 配对会留下"孤儿 user 消息"，由 dropTrailingOrphanUser 兜底。
  await prisma.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: persistedQuestionContent,
      transcriptOffsetMs: userTranscriptOffset,
    },
  });

  // 历史消息：与 legacy 一致用 compressionBoundary 截尾
  const compressionBoundary = findCompressionBoundary(conversation.messages);
  const lastSystemContent = compressionBoundary.summary;
  const effectiveMessages = conversation.messages.slice(
    compressionBoundary.splitIndex + 1
  );
  const history: ConversationTurn[] = dropTrailingOrphanUser(
    effectiveMessages
      .filter((m): m is typeof m & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant'
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        transcriptOffsetMs: m.transcriptOffsetMs ?? 0,
      }))
  );

  // ── 是否要强制 L6 ── 估算 transcript+history+input 总 token，超 L1*80% 直接 force ──
  const rawEstimate = estimateRawContextTokens(
    combinedTranscript,
    history,
    parsed.question
  );
  const longContext = rawEstimate > budget.inputBudget * 0.8;
  const forceMinLevel: DegradationLevel | undefined = longContext ? 6 : undefined;
  if (longContext) {
    chatLogger.info(
      {
        conversationId: conversation.id,
        rawEstimate,
        inputBudget: budget.inputBudget,
      },
      'global chat 超 L1 80% 阈值，forceMinLevel=6（RAG + report system 消息）'
    );
  }

  // ── 长上下文时加载所有 session 的 report 文本 ──
  let combinedReportText: string | undefined;
  if (longContext && conversation.ownedSessions.length > 0) {
    const reports = await Promise.all(
      conversation.ownedSessions.map(async (s) => {
        try {
          const data = (await loadSessionReport(s)) as SessionReportData | null;
          return {
            recordingTitle: s.title,
            reportText: renderReportAsText(data),
          };
        } catch (err) {
          chatLogger.warn(
            { sessionId: s.id, err: serializeError(err) },
            'global chat 加载录音 report 失败，跳过该录音的报告注入'
          );
          return { recordingTitle: s.title, reportText: '' };
        }
      })
    );
    const concatenated = concatRecordingReports(reports);
    if (concatenated) combinedReportText = concatenated;
  }

  // ── 当前轮发给模型的图片：用户上传 + 附件中的 image 类型 ──
  const userImageInputs: ChatImageInput[] = parsed.images.map((img) => ({
    mediaType: img.mediaType,
    data: img.data,
  }));
  const attachmentImageInputs = extractAttachmentImages(attachmentBlocks);
  // 图片张数限制：用户上传图片已在 parseChatImages 校验过（≤ chatImageCount）；
  // 叠加附件图片后对合并总数 clamp，防止某些 provider 按图片数计费/超过单请求图片硬限。
  const MAX_TURN_IMAGES = LLM_LIMITS.chatImageCount * 2;
  const currentTurnImages = [...userImageInputs, ...attachmentImageInputs].slice(
    0,
    MAX_TURN_IMAGES
  );

  // ── 附件文本拼成 system 消息内容 ──
  const attachmentsSystemMessage = buildAttachmentsSystemMessage(attachmentBlocks);
  const attachmentsBlock = attachmentsSystemMessage
    ? `[Conversation attachments — referenced documents]:\n${attachmentsSystemMessage}`
    : undefined;

  // ── 没有任何 transcript 时，给一个最小可用的 system prompt ──
  // 等同于 buildChatPrompt('', '', depth) 但保留 lastSystemContent 拼接。
  const buildSystemPrompt = (
    transcriptContext: string,
    summaryText: string
  ) => {
    // 多录音模式下：每条 transcript 文本在 RAG 输出里就已经带 [recId] 前缀；
    // 单 chat prompt 不需要再额外标识。
    const chatSystemPrompt = buildChatPrompt(
      transcriptContext,
      summaryText,
      finalDepth
    );
    return lastSystemContent
      ? `[Earlier conversation summary]:\n${lastSystemContent}\n\n${chatSystemPrompt}`
      : chatSystemPrompt;
  };

  const routingOptions = buildLlmRoutingOptions(selection, 'CHAT');
  const modelLabel =
    selection.providerConfig?.displayName ||
    selection.providerName ||
    process.env.LLM_ACTIVE_PROVIDER ||
    'default';

  // ── 全局 summary：把所有 session 的 summary blocks 渲染成文本并按录音拼接 ──
  // （此前这里直接丢弃 bundle.summaries、只用恒为空的 parsed.summaryContext，
  //   导致全局对话的 <lecture_summary> 永远为空 —— 补上多录音 summary 注入。）
  const renderSummaryBlocks = (blocks: SummaryBlock[]): string =>
    (Array.isArray(blocks) ? blocks : [])
      .map((block) => {
        const prose =
          typeof block?.summary === 'string' ? block.summary.trim() : '';
        if (prose) return prose;
        const kp = Array.isArray(block?.keyPoints)
          ? block.keyPoints.filter(
              (k): k is string => typeof k === 'string' && k.trim().length > 0
            )
          : [];
        return kp.length > 0 ? kp.map((k) => `- ${k}`).join('\n') : '';
      })
      .filter((s) => s.length > 0)
      .join('\n');

  const perRecordingSummaries = sessionAssets
    .map((asset) => {
      const text = renderSummaryBlocks(asset.summaries);
      if (!text) return null;
      return `[Recording: ${asset.session.title || asset.session.id}]\n${text}`;
    })
    .filter((s): s is string => s !== null);

  const summary =
    perRecordingSummaries.length > 0
      ? perRecordingSummaries.join('\n\n---\n\n')
      : parsed.summaryContext;

  return streamChatResponse({
    conversationId: conversation.id,
    buildSystemPrompt,
    transcript: combinedTranscript,
    summary,
    totalTranscriptMs,
    language,
    history,
    question: parsed.question,
    initialLevel: Math.max(conversation.degradationLevel, 1) as DegradationLevel,
    conversationDegradationLevel: conversation.degradationLevel,
    inputBudget: budget.inputBudget,
    currentTurnImages,
    routingOptions,
    thinkingPreference: effectivePreference,
    modelLabel,
    finalDepth,
    userTranscriptOffset,
    ragRetriever,
    reportText: combinedReportText,
    forceMinLevel,
    attachmentsSystemMessage: attachmentsBlock,
  });
}

