import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { LlmPurpose } from '@/types/llm';
import { prisma } from '@/lib/prisma';
import { callLLMWithHistoryStream, type LLMStreamEvent } from '@/lib/llm/gateway';
import { resolveGroupBoundModel } from '@/lib/llm/summaryModel';
import { resolveUserTranslationModelId } from '@/lib/userRoles';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logger, serializeError } from '@/lib/logger';

const proxyLogger = logger.child({ component: 'translate-llm-proxy' });

/** 单次请求的 messages 总字符硬上限（pdf2zh 单批很小；防滥用者拿代理当免费 LLM） */
const MAX_PROMPT_CHARS = 120_000;

/**
 * POST /api/translate/llm-proxy/v1/chat/completions — 文档翻译 worker 的 LLM 回流代理。
 *
 * pdf2zh 的 OpenAICompatible 后端把 base_url 指到这里，所有翻译 LLM 流量回流主应用网关：
 *  - 真实 token 计量（累计到 TranslationTask.llm*Tokens，成本可视）
 *  - 模型强制路由（忽略请求里的 model，按 任务快照 > 组绑定 > 全局 TRANSLATION 默认 解析）
 *  - 厂商 key 永不出主应用（worker 只持有任务级一次性凭据）
 *
 * 鉴权：Bearer = 派发时下发的任务级随机凭据，库里只存 sha256（唯一索引查回任务），
 * 任务必须处于 TRANSLATING（终态即吊销）。middleware 对本路径放行 JWT 校验。
 * 响应：非流式 OpenAI chat.completion JSON；请求 stream=true 时包装成两帧 SSE 兼容。
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!rawToken || rawToken.length < 32) {
    return NextResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
  }
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const task = await prisma.translationTask.findUnique({
    where: { proxyTokenHash: tokenHash },
    select: {
      id: true,
      status: true,
      modelId: true,
      user: { select: { role: true, customGroupId: true } },
    },
  });
  if (!task || task.status !== 'TRANSLATING') {
    return NextResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
  }

  // 防滥用限速（宽松固定 900/min：pdf2zh 侧已有 --qps 限速，这里只挡异常流量）
  const rateLimited = await enforceRateLimit(req, {
    scope: 'translate:llm-proxy',
    windowMs: 60_000,
    limit: 900,
    key: `task:${task.id}`,
  });
  if (rateLimited) return rateLimited;

  try {
    const body = await req.json();
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    let system = '';
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let totalChars = 0;
    for (const m of rawMessages) {
      if (!m || typeof m !== 'object') continue;
      const role = (m as { role?: unknown }).role;
      const content = (m as { content?: unknown }).content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .map((part) =>
                  part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                    ? (part as { text: string }).text
                    : ''
                )
                .join('')
            : '';
      totalChars += text.length;
      if (role === 'system') {
        system = system ? `${system}\n${text}` : text;
      } else if (role === 'user' || role === 'assistant') {
        messages.push({ role, content: text });
      }
    }
    if (messages.length === 0) {
      return NextResponse.json(
        { error: { message: 'messages 为空' } },
        { status: 400 }
      );
    }
    if (totalChars > MAX_PROMPT_CHARS) {
      return NextResponse.json(
        { error: { message: 'prompt 超出代理上限' } },
        { status: 400 }
      );
    }

    // 模型强制路由：任务创建时的模型快照 > 组绑定 > 全局 TRANSLATION 默认；
    // 请求里的 model/temperature 忽略（温度由 TRANSLATION 路由行统一配置）
    const boundId =
      task.modelId || (await resolveUserTranslationModelId(task.user).catch(() => null));
    const routing: { modelId: string } | { purpose: LlmPurpose } = (
      await resolveGroupBoundModel(boundId, 'TRANSLATION')
    ).routing;

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const result = await callLLMWithHistoryStream(
      system,
      messages,
      routing,
      (ev: LLMStreamEvent) => {
        if (ev.type === 'text' && ev.delta) text += ev.delta;
        else if (ev.type === 'usage') {
          if (typeof ev.inputTokens === 'number') inputTokens = ev.inputTokens;
          if (typeof ev.outputTokens === 'number') outputTokens = ev.outputTokens;
        }
      }
    );
    text = result.text || text;
    if (typeof result.usage?.inputTokens === 'number') inputTokens = result.usage.inputTokens;
    if (typeof result.usage?.outputTokens === 'number') outputTokens = result.usage.outputTokens;
    // provider 不回 usage 时按字符粗估（仅成本可视，不参与定价）
    if (!inputTokens) inputTokens = Math.ceil((system.length + totalChars) / 4);
    if (!outputTokens) outputTokens = Math.ceil(text.length / 4);

    await prisma.translationTask
      .update({
        where: { id: task.id },
        data: {
          llmInputTokens: { increment: inputTokens },
          llmOutputTokens: { increment: outputTokens },
        },
      })
      .catch(() => undefined);

    const completion = {
      id: `chatcmpl-${task.id.slice(0, 8)}${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'lecture-live-gateway',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };

    if (body?.stream === true) {
      // 兼容流式客户端：单块 chunk + [DONE]
      const chunk = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [
          { index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
        ],
      };
      const final = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: completion.usage,
      };
      const payload =
        `data: ${JSON.stringify(chunk)}\n\n` +
        `data: ${JSON.stringify(final)}\n\n` +
        'data: [DONE]\n\n';
      return new Response(payload, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
        },
      });
    }

    return NextResponse.json(completion);
  } catch (error) {
    proxyLogger.warn({ taskId: task.id, err: serializeError(error) }, '翻译代理调用失败');
    // OpenAI 风格错误体 + 5xx：pdf2zh 侧会按可重试处理
    return NextResponse.json(
      { error: { message: 'upstream LLM call failed', type: 'server_error' } },
      { status: 502 }
    );
  }
}
