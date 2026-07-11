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
import { tryAcquireConversationTurn } from '@/lib/llm/conversationTurnLock';
import { clampDepthToCap, type ThinkingDepthCap } from '@/lib/userRoles';
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
  // 剥离**所有**尾部未配对的 user 轮，而不仅是最后一条：若 U1、U2 连续在首 token 前
  // 失败（各自落库 user 但没有 assistant），只删一条会把 U1 连同新的 U3 一起发给模型，
  // 导致旧问题复活或两个问题被混答。循环剥到最后一条非 user 为止。
  let end = history.length;
  while (end > 0 && history[end - 1]?.role === 'user') {
    end -= 1;
  }
  return end === history.length ? history : history.slice(0, end);
}

/**
 * 把解析出的 thinkingPreference 归一为「实际发给 gateway 的偏好」，并按所属组的思考深度
 * 上限 cap 收紧（cap 由用户组绑定，替代原来对 FREE 硬编码的 high→medium）。
 *
 *  - cap='off'：组禁止思考 → 强制 off（DEPTH/AUTO 模型不带思考参数；FORCED 模型模型自带
 *    思考无法关闭，需靠 allowedModels 不授权该模型来阻止）。
 *  - 显式 low/medium/high：用 access.ts 已按 cap clamp 过的 finalDepth。
 *  - forced/auto：透传让 gateway 取 provider.thinkingDepth；但当模型默认深度超过组上限时
 *    （如默认 high、组上限 medium）显式收紧到 cap，避免绕过上限按更高档消耗思考 token
 *    （原 v3 finding U52 的一般化）。
 */
function resolveEffectivePreference(
  parsedPreference: ThinkingPreference,
  finalDepth: ThinkingDepth,
  cap: ThinkingDepthCap,
  providerConfig?: { thinkingMode?: string; thinkingDepth?: ThinkingDepth }
): ThinkingPreference {
  if (cap === 'off') {
    return 'off';
  }
  if (
    parsedPreference === 'low' ||
    parsedPreference === 'medium' ||
    parsedPreference === 'high'
  ) {
    return finalDepth;
  }
  // forced / auto：模型默认深度超过组上限时收紧到 cap，否则保持原语义透传
  if (
    (parsedPreference === 'forced' || parsedPreference === 'auto') &&
    providerConfig?.thinkingMode === 'DEPTH' &&
    providerConfig?.thinkingDepth
  ) {
    const capped = clampDepthToCap(
      providerConfig.thinkingDepth as ThinkingDepthCap,
      cap
    );
    if (capped !== providerConfig.thinkingDepth) {
      return capped;
    }
  }
  return parsedPreference;
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
  let totalChars = 0;
  for (const raw of value as TranscriptSegmentInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    const startMs = typeof raw.startMs === 'number' ? raw.startMs : 0;
    if (!text) continue;
    out.push({ text, startMs });
    totalChars += text.length;
    // 安全：对客户端提交的 transcript 体量封顶，防超大数组在降级循环里反复 tokenizer
    // 编码造成 CPU 放大。上限远超真实多小时讲座，超限即截断（保留较早段，时间锚点不乱）。
    if (
      out.length >= LLM_LIMITS.transcriptSegments ||
      totalChars >= LLM_LIMITS.transcriptTotalChars
    ) {
      break;
    }
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
  /** 释放「每对话单飞行中回复」锁；流结束/失败/取消时调用（幂等） */
  releaseTurn?: () => void;
}

/**
 * 把已组装好的 chat 上下文用 SSE 流出去，并落库 assistant 消息 +
 * 更新 conversation.degradationLevel。两条路径共用这块「流式 + 持久化」的尾段。
 */
function streamChatResponse(
  args: StreamChatArgs
): Response {
  const encoder = new TextEncoder();

  // 上游取消信号：客户端断开（点「停止」/关页面）时，ReadableStream 的 cancel() 会触发，
  // abort 掉正在进行的 provider fetch —— 停止继续拉流 / 继续计费 / 长时间占用连接。
  const upstreamAbort = new AbortController();

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
      // 事务提交成功后置 true：done 帧因客户端断开 enqueue 抛错跳入 catch 时，
      // 用它守卫避免二次插入同一条 assistant 消息（否则历史出现重复回答）。
      let persisted = false;

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
                signal: upstreamAbort.signal,
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

        // 空内容守卫：上游可能返回 200 但无正文（开启 thinking 后仅产出 thinking 块 /
        // 在思考预算内撞 max_tokens / 空白响应）。若无条件落库空 content，下一轮该消息
        // 会毒化 Anthropic 路径（空 content → 400）——gateway 侧已过滤空历史兜底，这里
        // 再于源头拒绝落库空消息，当作生成失败回错误帧，避免污染对话。
        if (!accumulatedText.trim()) {
          chatLogger.warn(
            {
              conversationId: args.conversationId,
              level: effectiveLevel,
            },
            'chat 上游返回空正文，跳过落库并回错误帧（避免空 content 毒化对话）'
          );
          send('error', {
            error: 'Chat generation failed',
            contextFull: false,
          });
          controller.close();
          return;
        }

        await prisma.$transaction([
          persistAssistantMessage(),
          // 只在 DB 里现存值更低时才抬高 degradationLevel（DB 侧条件更新 = 原子读改写）。
          // 此前用 Math.max(内存快照, effectiveLevel) 落库：并发两轮各读到同一旧快照，后写的
          // 较低档会覆盖先写的较高档（lost update）。改成 updateMany + where degradationLevel<X
          // 让行锁在写时重新比较当前值，只升不降，杜绝丢更新。
          prisma.conversation.updateMany({
            where: {
              id: args.conversationId,
              degradationLevel: { lt: effectiveLevel },
            },
            data: { degradationLevel: effectiveLevel },
          }),
        ]);
        persisted = true;

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
        // 只在「流已成功跑完但落库/收尾阶段才抛错」时兜底插入（succeeded=true 的安全网，
        // 如 done 帧因客户端断开、或 $transaction 因偶发 DB 错误失败）。
        // 若失败发生在流成功之前（上游 mid-stream error / 截断 EOF / abort），succeeded 仍为
        // false —— 此时 accumulatedText 是半截正文，绝不能当正常 assistant 消息落库
        // （否则用户看到半句话却无失败提示，刷新后还会作为历史参与下一轮）。
        if (!persisted && succeeded && accumulatedText.trim()) {
          await persistAssistantMessage().catch(() => {});
        }
        // 客户端断开触发的 abort：对端已不在，controller 已被 cancel，再 enqueue/close 会抛错。
        // 此时只需静默收尾（succeeded=false，上面也不会落库半截正文）。
        if (upstreamAbort.signal.aborted) return;
        // 安全：原始错误（可能含上游 provider 错误措辞/内部模型名）只进日志，
        // 客户端只回固定文案。
        try {
          send('error', {
            error: 'Chat generation failed',
            contextFull: false,
          });
          controller.close();
        } catch {
          // 对端已断开，忽略。
        }
      } finally {
        // 无论成功/失败/中途 return，本轮结束都释放对话锁，放行后续轮次（幂等）。
        args.releaseTurn?.();
      }
    },
    cancel() {
      // 客户端断开（点「停止」/关闭页面/切走）→ 取消上游 provider 请求，并释放对话锁。
      upstreamAbort.abort();
      args.releaseTurn?.();
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

  // 每对话回复锁：正常路径在流结束时由 streamChatResponse 释放；若在流开始前抛错，
  // 由下方 catch 兜底释放（幂等）。
  let releaseTurn: (() => void) | null = null;

  try {
    const parsed = await parseRequest(req);

    // 一次性把 conversation + messages + 关联 session/recordings 取出，避免后面分支再多次查询。
    // 归属用 conversation.userId（include 会带回所有标量字段），不再查 attachments 来反推归属；
    // 附件实际下载仍在 chatAttachments.ts 里按 conversationId 做。
    const conversation = await prisma.conversation.findUnique({
      where: { id: parsed.conversationId },
      include: {
        // legacy 来源录音的字段集与 sessions.session 对齐：从全局对话区打开这类对话时
        // 会走 global 路径，把来源录音并入 ownedSessions（文件态 transcript 上下文）。
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

    // 每对话「单飞行中回复」锁：同一对话已有进行中回复时 fail-fast 回 409，避免并发轮次
    // 交错落库成问答错配（U1→U2→A2→A1）。放行的这一轮持锁直到流结束/取消才释放。
    releaseTurn = tryAcquireConversationTurn(conversation.id);
    if (!releaseTurn) {
      return NextResponse.json(
        { error: '该对话正在生成回复，请稍候再发送。' },
        { status: 409 }
      );
    }

    const isLegacy = conversation.session !== null;

    // legacy 会话分两条路：
    //  · ChatTab 实时路径 —— 请求自带 live transcript/时间轴/摘要，行为完全不变；
    //  · 全局对话区打开 —— 三者皆空（GlobalChat 发 transcript:[] / totalTranscriptMs:0 /
    //    summaryContext:''），改走下方 global 路径，把来源录音并入 ownedSessions，
    //    从落盘的 transcript 文件构建上下文（“打开即自动挂载好录音”）。
    //    ChatTab 在零转录/零偏移/零摘要的退化场景下两条路径上下文等价（都为空）。
    const isLiveSessionRequest =
      isLegacy &&
      (parsed.transcript.length > 0 ||
        parsed.totalTranscriptMs > 0 ||
        parsed.summaryContext.trim().length > 0);

    if (isLiveSessionRequest) {
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
        releaseTurn,
      });
    }

    // ── 全局 chat 路径（无 session 绑定，或 legacy 会话从全局对话区发起）──
    // 归属已由 conversation.userId 校验通过。挂载录音在 attach 时已限定属于本人，
    // 这里仍按 userId 过滤一遍做纵深防御（防历史脏数据混入他人 session）。
    const junctionOwned = conversation.sessions
      .map((cs) => cs.session)
      .filter((s) => s.userId === payload.id);
    // 来源录音排最前（language 取第一个录音的 targetLang，与 ChatTab 行为一致），
    // 并按 id 去重防联表混入同一录音。
    const legacySession =
      isLegacy && conversation.session!.userId === payload.id
        ? conversation.session!
        : null;
    const ownedSessions = legacySession
      ? [
          legacySession,
          ...junctionOwned.filter((s) => s.id !== legacySession.id),
        ]
      : junctionOwned;

    return await handleGlobalChat({
      parsed,
      conversation: {
        id: conversation.id,
        degradationLevel: conversation.degradationLevel,
        messages: conversation.messages,
        ownedSessions,
      },
      userId: payload.id,
      releaseTurn,
    });
  } catch (error) {
    // 流开始前抛错 → 释放已获取的对话锁（正常路径由 streamChatResponse 的 finally 释放）。
    releaseTurn?.();

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
  /** 每对话回复锁的释放函数（由 POST 获取后透传），流结束时释放 */
  releaseTurn: () => void;
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
  const thinkingCap = selection.featureFlags.maxThinkingDepth;
  const finalDepth = resolveEffectiveThinkingDepth(
    thinkingCap,
    parsed.depth,
    selection.providerConfig
  );

  const effectivePreference = resolveEffectivePreference(
    parsed.thinkingPreference,
    finalDepth,
    thinkingCap,
    selection.providerConfig
  );

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
    releaseTurn: args.releaseTurn,
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
  /** 每对话回复锁的释放函数（由 POST 获取后透传），流结束时释放 */
  releaseTurn: () => void;
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
  const thinkingCap = selection.featureFlags.maxThinkingDepth;
  const finalDepth = resolveEffectiveThinkingDepth(
    thinkingCap,
    parsed.depth,
    selection.providerConfig
  );
  const effectivePreference = resolveEffectivePreference(
    parsed.thinkingPreference,
    finalDepth,
    thinkingCap,
    selection.providerConfig
  );

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
  // 各录音喂给 RAG 的 segments 用「已平移到全局轴」的 startMs（= 本录音全局偏移 +
  // 本地 startMs），使 RAG 检索片段打的 [HH:MM:SS] 标签与 totalTranscriptMs / 时间锚点
  // 系统消息同轴。此前这里存的是未平移的 per-recording 本地轴 segments，两套坐标冲突，
  // 模型给出的时间引用与播放器/锚点对不上（v3 finding U54）。
  const segmentsByRecording = new Map<string, TranscriptSegment[]>();
  for (const asset of sessionAssets) {
    const recordingOffsetMs = cumulativeMs;
    const shiftedSegments = asset.segments.map((seg) => ({
      text: seg.text,
      startMs: recordingOffsetMs + seg.startMs,
    }));
    segmentsByRecording.set(asset.session.id, shiftedSegments);
    combinedTranscript.push(...shiftedSegments);
    // 用最后一段的 endMs 作为该 session 的总长度近似（segments 已按时间序）
    const last = asset.segments[asset.segments.length - 1];
    if (last) {
      cumulativeMs += last.startMs + 1000; // 加 1s buffer 防止两段时间锚重叠
    }
  }
  const totalTranscriptMs = cumulativeMs;

  const recordingIds = conversation.ownedSessions.map((s) => s.id);
  // 内容签名 = 段数与全文字符总长的组合。此前仅用 segment 总数，段数守恒但某段被
  // 重转写/纠正（文本变、段数不变）时签名不变 → 多录音 RAG 命中旧快照、检索到纠正前
  // 文本（v3 finding U76）。这里叠加全文 char 长度，令同段数文本改写也触发增量重建
  // （与单录音路径的 lastContentLength 判据一致）。
  const ragTotalChars = combinedTranscript.reduce(
    (acc, seg) => acc + seg.text.length,
    0
  );
  const ragContentSignature = combinedTranscript.length * 1_000_003 + ragTotalChars;
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
    releaseTurn: args.releaseTurn,
  });
}

