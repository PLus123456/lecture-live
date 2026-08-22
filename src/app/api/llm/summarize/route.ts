import { NextResponse } from 'next/server';
import type { LlmPurpose } from '@/types/llm';
import { verifyAuth } from '@/lib/auth';
import { callLLM, type LLMProviderConfig } from '@/lib/llm/gateway';
import { buildIncrementalSummaryPrompt } from '@/lib/llm/prompts';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import {
  LLMAccessError,
  resolveAuthorizedLlmSelection,
} from '@/lib/llm/access';
import { buildLlmRoutingOptions } from '@/lib/llm/llmRoutingOptions';
import { resolveUserSummaryModels } from '@/lib/userRoles';
import { resolveSummaryModel } from '@/lib/llm/summaryModel';
import { computeContextBudget } from '@/lib/llm/tokenBudget';
import { estimateTokens, truncateToTokensFromEnd } from '@/lib/llm/tokenizer';
import { logger } from '@/lib/logger';
import {
  LLM_LIMITS,
  LLMResponseError,
  LLMValidationError,
  parseIncrementalSummaryResult,
  readOptionalIdentifier,
  readOptionalText,
  readRequiredText,
} from '@/lib/llm/security';

const summarizeLogger = logger.child({ component: 'llm-summarize' });

/** prompt 模板本身 + 输出预留的粗略 token 开销（不含 courseContext） */
const SUMMARY_PROMPT_OVERHEAD_TOKENS = 800;

/**
 * L41：按目标模型的 contextWindow 把「新转录 + 累计上下文」压进输入预算。
 *
 * 分配策略：累计上下文（runningContext）最多占可用预算的一半 —— 它是滚动状态，
 * 丢了会让后续摘要失忆；新转录拿剩下的。两者都从**尾部**保留（最近的内容更重要）。
 * provider 解析不出来时不截断（保持旧行为，交给上游报错）。
 */
function fitSummaryInputsToBudget(
  newTranscript: string,
  runningContext: string,
  courseContext: string,
  provider: LLMProviderConfig | null
): { transcript: string; context: string } {
  if (!provider || !provider.contextWindow) {
    return { transcript: newTranscript, context: runningContext };
  }
  const { inputBudget } = computeContextBudget(provider, provider.contextWindow);
  const overhead =
    SUMMARY_PROMPT_OVERHEAD_TOKENS + estimateTokens(courseContext);
  const available = inputBudget - overhead;
  if (available <= 0) {
    // 窗口小到连模板都塞不下 —— 尽力给一小段，交给上游决定成败。
    return {
      transcript: truncateToTokensFromEnd(newTranscript, 200),
      context: '',
    };
  }

  let context = runningContext;
  const contextBudget = Math.floor(available * 0.5);
  if (estimateTokens(context) > contextBudget) {
    context = truncateToTokensFromEnd(context, contextBudget);
  }
  let transcript = newTranscript;
  const transcriptBudget = Math.max(200, available - estimateTokens(context));
  if (estimateTokens(transcript) > transcriptBudget) {
    transcript = truncateToTokensFromEnd(transcript, transcriptBudget);
  }

  if (transcript !== newTranscript || context !== runningContext) {
    summarizeLogger.warn(
      {
        contextWindow: provider.contextWindow,
        inputBudget,
        transcriptChars: newTranscript.length,
        boundedTranscriptChars: transcript.length,
        contextChars: runningContext.length,
        boundedContextChars: context.length,
      },
      '实时摘要输入超出该模型上下文预算，已按预算截断（避免必然失败的循环重试）'
    );
  }
  return { transcript, context };
}

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 已认证用户按 userId 限流，使用管理员配置的 rate_limit_api
  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'llm:summarize',
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const body = await req.json();
    const newTranscript = readRequiredText(
      body.newTranscript,
      'newTranscript',
      LLM_LIMITS.newTranscript
    );
    const runningContext = readOptionalText(
      body.runningContext,
      'runningContext',
      LLM_LIMITS.runningContext
    );
    const courseContext = readOptionalText(
      body.courseContext,
      'courseContext',
      LLM_LIMITS.courseContext
    );
    const language =
      readOptionalText(body.language, 'language', LLM_LIMITS.language) || 'zh';
    const providerOverride = readOptionalIdentifier(
      body.providerOverride,
      'providerOverride',
      LLM_LIMITS.providerOverride
    );

    // 先只解析用户组能力 + 用户信息（identifier 传 undefined）：摘要模型由用户组/全局默认决定，
    // 与用户可选的聊天模型无关。此处不带 providerOverride，避免一个失效/越权的 override 在解析
    // 组摘要模型之前就把摘要 403 掉（组绑定模型本该按优先级胜出）；enforceDefaultModelAccess:false
    // 也避免用「CHAT 默认模型是否被允许」误判摘要（判错了用途）。
    const selection = await resolveAuthorizedLlmSelection(user.id, undefined, {
      enforceDefaultModelAccess: false,
    });

    // 用户组门禁：未开通实时摘要则拒绝（组配置为唯一真源，随 selection 一并解析）
    if (!selection.featureFlags.allowRealtimeSummary) {
      return NextResponse.json(
        { error: '当前用户组未开通实时摘要功能' },
        { status: 403 }
      );
    }

    // 模型优先级：用户组绑定的实时摘要模型 > 用户 providerOverride（需在 allowedModels 内）> 全局用途默认。
    //  - 组配了具体模型即用之（resolveSummaryModel 会校验存在性、失效时回落全局默认），providerOverride 被忽略；
    //  - 未配组模型且用户显式选了 chat provider → 才校验该 override 并沿用（越权 override 在此才 403，符合旧语义）；
    //  - 都没有 → 全局 REALTIME_SUMMARY 用途默认。
    const { realtimeSummaryModelId } = await resolveUserSummaryModels(selection.user);
    let routing:
      | { modelId: string }
      | { providerOverride: string }
      | { purpose: LlmPurpose };
    // L41：同时把解析到的 provider 配置留下来 —— 实时摘要此前只有「字符数」上限
    // （newTranscript 50K / runningContext 50K），完全不看模型的 contextWindow。
    // 8K 窗口的模型遇上 50K 字符必然 400，而客户端失败后会把原文 unshift 回 buffer
    // 原样重发 → 每个触发周期循环失败一次。这里按真实窗口预算截断，把"必然失败"
    // 变成"内容略有截断但成功"。
    let providerForBudget: LLMProviderConfig | null = null;
    if (realtimeSummaryModelId) {
      const resolved = await resolveSummaryModel(
        realtimeSummaryModelId,
        'REALTIME_SUMMARY'
      );
      routing = resolved.routing;
      providerForBudget = resolved.provider;
    } else if (providerOverride) {
      const overrideSelection = await resolveAuthorizedLlmSelection(user.id, providerOverride);
      routing = buildLlmRoutingOptions(overrideSelection, 'REALTIME_SUMMARY');
      providerForBudget = overrideSelection.providerConfig ?? null;
    } else {
      // resolveSummaryModel(null, …) 等价于 { purpose: 'REALTIME_SUMMARY' }，
      // 顺带把全局默认模型的 contextWindow 一并解析出来。
      const resolved = await resolveSummaryModel(null, 'REALTIME_SUMMARY');
      routing = resolved.routing;
      providerForBudget = resolved.provider;
    }

    const { transcript: boundedTranscript, context: boundedContext } =
      fitSummaryInputsToBudget(
        newTranscript,
        runningContext,
        courseContext,
        providerForBudget
      );

    const { system, user: userMsg } = buildIncrementalSummaryPrompt(
      boundedTranscript,
      boundedContext,
      courseContext || 'University lecture',
      language
    );

    const result = await callLLM(system, userMsg, routing);

    const parsed = parseIncrementalSummaryResult(result);
    return NextResponse.json(parsed);
  } catch (error) {
    if (error instanceof LLMValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof LLMResponseError) {
      return NextResponse.json(
        { error: 'Invalid LLM response format' },
        { status: 502 }
      );
    }

    if (error instanceof LLMAccessError) {
      const status = error.message === 'User not found' ? 404 : 403;
      return NextResponse.json({ error: error.message }, { status });
    }

    console.error('Summarize error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
