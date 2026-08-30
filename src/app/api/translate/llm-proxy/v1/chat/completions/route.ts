import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isPaymentBenefitAvailable } from '@/lib/payment/entitlementAdmission';
import { callLLMWithHistoryStream, type LLMStreamEvent } from '@/lib/llm/gateway';
import { resolveGroupBoundModel } from '@/lib/llm/summaryModel';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logger, serializeError } from '@/lib/logger';
import {
  ActiveJobBudgetExceededError,
  ActiveJobConcurrencyExceededError,
  ActiveJobConflictError,
  completeActiveJob,
  failActiveJob,
  JOB_STATUS,
  JOB_TYPE,
} from '@/lib/jobQueue';
import {
  claimLlmTokenBudget,
  trustedLlmUsageTokens,
} from '@/lib/llm/resourceBudget';
import {
  decodeTranslationProxyCache,
  encodeTranslationProxyCache,
  parseTranslationProxyRequest,
  planTranslationProxyRequest,
  readTranslationProxyJson,
  translationProxyTaskBudget,
  TRANSLATION_PROXY_MAX_OUTPUT_TOKENS,
  TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES,
  TranslationProxyRequestError,
  type TranslationProxyCachedResult,
} from '@/lib/translate/llmProxyAdmission';

const proxyLogger = logger.child({ component: 'translate-llm-proxy' });
const PROXY_UPSTREAM_TOTAL_TIMEOUT_MS = 5 * 60_000;

function openAiError(
  message: string,
  status: number,
  type = 'server_error',
  headers?: HeadersInit
): Response {
  return NextResponse.json(
    { error: { message, type } },
    { status, headers }
  );
}

function completionResponse(
  taskId: string,
  stream: boolean,
  value: TranslationProxyCachedResult
): Response {
  const completion = {
    id: `chatcmpl-${taskId.slice(0, 8)}${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'lecture-live-gateway',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: value.text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: value.inputTokens,
      completion_tokens: value.outputTokens,
      total_tokens: value.actualTokens,
    },
  };
  if (!stream) return NextResponse.json(completion);

  const chunk = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: value.text },
        finish_reason: null,
      },
    ],
  };
  const final = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: completion.usage,
  };
  return new Response(
    `data: ${JSON.stringify(chunk)}\n\n` +
      `data: ${JSON.stringify(final)}\n\n` +
      'data: [DONE]\n\n',
    {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    }
  );
}

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
  const rawToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (!rawToken || rawToken.length < 32) {
    return openAiError('Unauthorized', 401);
  }
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const task = await prisma.translationTask.findUnique({
    where: { proxyTokenHash: tokenHash },
    select: {
      id: true,
      userId: true,
      status: true,
      modelId: true,
      pageCount: true,
      llmInputTokens: true,
      llmOutputTokens: true,
      proxyTokenHash: true,
      proxyGeneration: true,
      jobQueueId: true,
      user: { select: { role: true, customGroupId: true } },
    },
  });
  if (!task || task.status !== 'TRANSLATING') {
    return openAiError('Unauthorized', 401);
  }
  if (!(await isPaymentBenefitAvailable(task.userId))) {
    return openAiError('payment account frozen', 403, 'account_frozen');
  }

  // 防滥用限速（宽松固定 900/min：pdf2zh 侧已有 --qps 限速，这里只挡异常流量）
  const rateLimited = await enforceRateLimit(req, {
    scope: 'translate:llm-proxy',
    windowMs: 60_000,
    limit: 900,
    key: `task:${task.id}`,
  });
  if (rateLimited) return rateLimited;

  let parsed: ReturnType<typeof parseTranslationProxyRequest>;
  try {
    const body = await readTranslationProxyJson(req);
    parsed = parseTranslationProxyRequest(body);
  } catch (error) {
    const message =
      error instanceof TranslationProxyRequestError
        ? error.message
        : 'invalid request body';
    return openAiError(
      message,
      error instanceof TranslationProxyRequestError ? error.status : 400,
      'invalid_request_error'
    );
  }

  // 派发器在签发 worker token 前已持久化 modelId。代理只能使用这一精确 DB
  // TRANSLATION 模型；缺失/删除/改用途/查询失败均关闭失败，绝不静默 fallback。
  const boundId = task.modelId;
  if (!boundId) {
    return openAiError('translation model snapshot unavailable', 503);
  }
  const resolved = await resolveGroupBoundModel(
    boundId,
    'TRANSLATION'
  ).catch(() => null);
  if (
    !resolved?.provider ||
    resolved.provider.dbModelId !== boundId ||
    resolved.provider.purpose !== 'TRANSLATION' ||
    !Number.isSafeInteger(resolved.provider.maxTokens) ||
    resolved.provider.maxTokens <= 0
  ) {
    return openAiError('translation model unavailable', 503);
  }
  const maxOutputTokens = Math.min(
    resolved.provider.maxTokens,
    TRANSLATION_PROXY_MAX_OUTPUT_TOKENS
  );
  const routing = { modelId: boundId };
  const modelKey = boundId;
  const { requestHash, reservedTokens } = planTranslationProxyRequest({
    taskId: task.id,
    modelKey,
    system: parsed.system,
    messages: parsed.messages,
    maxOutputTokens,
  });
  const activeKey = `translation_llm:${task.id}:${requestHash}`;

  const readReplay = async (): Promise<
    | { kind: 'none' }
    | { kind: 'pending' }
    | { kind: 'success'; value: TranslationProxyCachedResult }
    | { kind: 'corrupt' }
  > => {
    const existing = await prisma.jobQueue.findUnique({
      where: { activeKey },
      select: { status: true, result: true },
    });
    if (!existing) return { kind: 'none' };
    if (existing.status === JOB_STATUS.SUCCESS) {
      const value = decodeTranslationProxyCache(existing.result);
      return value ? { kind: 'success', value } : { kind: 'corrupt' };
    }
    if (
      existing.status === JOB_STATUS.SUBMITTED ||
      existing.status === JOB_STATUS.PENDING ||
      existing.status === JOB_STATUS.PROCESSING
    ) {
      return { kind: 'pending' };
    }
    return { kind: 'none' };
  };

  const replay = await readReplay();
  if (replay.kind === 'success') {
    return completionResponse(task.id, parsed.stream, replay.value);
  }
  if (replay.kind === 'pending') {
    return openAiError('translation request already in progress', 429, 'rate_limit_error', {
      'Retry-After': '1',
    });
  }
  if (replay.kind === 'corrupt') {
    return openAiError('translation replay cache unavailable', 503);
  }

  const spentTokens = task.llmInputTokens + task.llmOutputTokens;
  const tokenBudget = translationProxyTaskBudget(task.pageCount);
  let jobId: string;
  try {
    jobId = await claimLlmTokenBudget({
      type: JOB_TYPE.TRANSLATION_LLM_PROXY,
      sessionId: task.id,
      userId: task.userId,
      triggeredBy: 'translation-worker',
      activeKey,
      units: reservedTokens,
      owner: {
        limit: tokenBudget,
        settledUnitsFloor: spentTokens,
        // pdf2zh 的 qps 仍可排队；同一任务只有一个付费请求在途，彻底关闭并发穿透。
        maxActiveJobs: 1,
      },
      params: {
        requestHash,
        modelKey,
        reservedTokens,
        maxOutputTokens,
        schedulingJobId: task.jobQueueId,
      },
    });
  } catch (error) {
    if (error instanceof ActiveJobConflictError) {
      const winner = await readReplay();
      if (winner.kind === 'success') {
        return completionResponse(task.id, parsed.stream, winner.value);
      }
      return openAiError('translation request already in progress', 429, 'rate_limit_error', {
        'Retry-After': '1',
      });
    }
    if (error instanceof ActiveJobConcurrencyExceededError) {
      return openAiError('translation task concurrency exceeded', 429, 'rate_limit_error', {
        'Retry-After': String(error.retryAfterSeconds),
      });
    }
    if (error instanceof ActiveJobBudgetExceededError) {
      const headers = error.resetAt
        ? {
            'Retry-After': String(
              Math.max(1, Math.ceil((error.resetAt.getTime() - Date.now()) / 1000))
            ),
          }
        : undefined;
      return openAiError(
        'translation token budget exceeded',
        429,
        'insufficient_quota',
        headers
      );
    }
    proxyLogger.error(
      { taskId: task.id, err: serializeError(error) },
      '翻译代理预算预留失败'
    );
    return openAiError('translation budget admission failed', 503);
  }

  // claim 后重新校验任务代次、凭据和调度行。旧 worker 在任务回炉/取消后即使仍持
  // token，也只能把 0-usage claim 结算掉，绝不能触达 provider。
  let freshTask: {
    status: string;
    proxyTokenHash: string | null;
    proxyGeneration: string | null;
    modelId: string | null;
    jobQueueId: string | null;
    llmInputTokens: number;
    llmOutputTokens: number;
  } | null = null;
  let schedulingJob: { status: string; type: string } | null = null;
  let postClaimReadError: unknown;
  try {
    [freshTask, schedulingJob] = await Promise.all([
      prisma.translationTask.findUnique({
        where: { id: task.id },
        select: {
          status: true,
          proxyTokenHash: true,
          proxyGeneration: true,
          modelId: true,
          jobQueueId: true,
          llmInputTokens: true,
          llmOutputTokens: true,
        },
      }),
      task.jobQueueId
        ? prisma.jobQueue.findUnique({
            where: { id: task.jobQueueId },
            select: { status: true, type: true },
          })
        : Promise.resolve(null),
    ]);
  } catch (error) {
    postClaimReadError = error;
  }
  const stillAuthorized =
    freshTask?.status === 'TRANSLATING' &&
    freshTask.proxyTokenHash === tokenHash &&
    freshTask.proxyGeneration === task.proxyGeneration &&
    freshTask.modelId === task.modelId &&
    freshTask.jobQueueId === task.jobQueueId &&
    schedulingJob?.status === JOB_STATUS.PROCESSING &&
    schedulingJob.type === JOB_TYPE.DOC_TRANSLATE &&
    freshTask.llmInputTokens + freshTask.llmOutputTokens + reservedTokens <=
      tokenBudget;
  if (!stillAuthorized) {
    try {
      await failActiveJob(
        jobId,
        postClaimReadError ??
          new Error('translation proxy task generation is no longer active'),
        { requestHash, reservedTokens },
        0
      );
    } catch (error) {
      proxyLogger.error(
        { taskId: task.id, jobId, err: serializeError(error) },
        '翻译代理 claim 撤销结算失败'
      );
      return openAiError('translation claim settlement failed', 503);
    }
    return openAiError('Unauthorized', 401);
  }

  let actualTokens = reservedTokens;
  let settledInputTokens = reservedTokens;
  let settledOutputTokens = 0;
  let successSettlementStarted = false;
  try {
    if (req.signal.aborted) {
      actualTokens = 0;
      settledInputTokens = 0;
      throw new Error('translation proxy request was canceled before dispatch');
    }
    let text = '';
    let responseUtf8Bytes = 0;
    const responseEncoder = new TextEncoder();
    let eventInputTokens: number | undefined;
    let eventOutputTokens: number | undefined;
    const signal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(PROXY_UPSTREAM_TOTAL_TIMEOUT_MS),
    ]);
    const result = await callLLMWithHistoryStream(
      parsed.system,
      parsed.messages,
      {
        ...routing,
        // gateway 在它自己的 provider 解析后、实际 fetch 前再次核对；这样即使
        // 模型在本路由预检后被删除/改用途，也不会 fallback 到错误模型。
        expectedModel: { dbModelId: boundId, purpose: 'TRANSLATION' },
        maxOutputTokens,
        maxResponseUtf8Bytes: TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES,
        signal,
      },
      (event: LLMStreamEvent) => {
        if (event.type === 'text' && event.delta) {
          responseUtf8Bytes += responseEncoder.encode(event.delta).byteLength;
          if (responseUtf8Bytes > TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES) {
            throw new TranslationProxyRequestError(
              'upstream response is too large'
            );
          }
          text += event.delta;
        }
        else if (event.type === 'usage') {
          if (typeof event.inputTokens === 'number') {
            eventInputTokens = event.inputTokens;
          }
          if (typeof event.outputTokens === 'number') {
            eventOutputTokens = event.outputTokens;
          }
        }
      }
    );
    text = result.text || text;
    if (
      responseEncoder.encode(text).byteLength >
      TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES
    ) {
      throw new TranslationProxyRequestError('upstream response is too large');
    }
    const usage = {
      inputTokens: result.usage?.inputTokens ?? eventInputTokens,
      outputTokens: result.usage?.outputTokens ?? eventOutputTokens,
      totalTokens: result.usage?.totalTokens,
    };
    const measured = trustedLlmUsageTokens(usage, reservedTokens);
    actualTokens = measured ?? reservedTokens;
    const splitIsTrusted =
      Number.isSafeInteger(usage.inputTokens) &&
      (usage.inputTokens ?? -1) >= 0 &&
      Number.isSafeInteger(usage.outputTokens) &&
      (usage.outputTokens ?? -1) >= 0 &&
      (usage.inputTokens as number) + (usage.outputTokens as number) ===
        actualTokens;
    settledInputTokens = splitIsTrusted
      ? (usage.inputTokens as number)
      : actualTokens;
    settledOutputTokens = splitIsTrusted
      ? (usage.outputTokens as number)
      : 0;

    const cachedValue: TranslationProxyCachedResult = {
      text,
      inputTokens: settledInputTokens,
      outputTokens: settledOutputTokens,
      actualTokens,
    };
    const translationProxyCache = encodeTranslationProxyCache(cachedValue);
    successSettlementStarted = true;
    await completeActiveJob(
      jobId,
      {
        translationProxyCache,
        requestHash,
        reservedTokens,
        actualTokens,
      },
      actualTokens,
      {
        retainActiveKeyOnSuccess: true,
        mutation: async (tx) => {
          const updated = await tx.translationTask.updateMany({
            where: {
              id: task.id,
              status: 'TRANSLATING',
              proxyTokenHash: tokenHash,
              proxyGeneration: task.proxyGeneration,
              modelId: task.modelId,
              jobQueueId: task.jobQueueId,
            },
            data: {
              llmInputTokens: { increment: settledInputTokens },
              llmOutputTokens: { increment: settledOutputTokens },
            },
          });
          if (updated.count !== 1) {
            throw new Error('Translation task usage settlement target is missing');
          }
        },
      }
    );
    return completionResponse(task.id, parsed.stream, cachedValue);
  } catch (error) {
    if (!successSettlementStarted) {
      try {
        await failActiveJob(
          jobId,
          error,
          { requestHash, reservedTokens, actualTokens },
          actualTokens,
          actualTokens > 0
            ? {
                mutation: async (tx) => {
                  const updated = await tx.translationTask.updateMany({
                    where: {
                      id: task.id,
                      status: 'TRANSLATING',
                      proxyTokenHash: tokenHash,
                      proxyGeneration: task.proxyGeneration,
                      modelId: task.modelId,
                      jobQueueId: task.jobQueueId,
                    },
                    data: {
                      llmInputTokens: { increment: settledInputTokens },
                      llmOutputTokens: { increment: settledOutputTokens },
                    },
                  });
                  if (updated.count !== 1) {
                    throw new Error(
                      'Translation task failure usage settlement target is missing'
                    );
                  }
                },
              }
            : undefined
        );
      } catch (settlementError) {
        proxyLogger.error(
          {
            taskId: task.id,
            jobId,
            err: serializeError(settlementError),
          },
          '翻译代理失败计量结果未知，保留资源 lease'
        );
      }
    }
    proxyLogger.warn(
      { taskId: task.id, err: serializeError(error) },
      '翻译代理调用失败'
    );
    return openAiError('upstream LLM call failed', 502);
  }
}
