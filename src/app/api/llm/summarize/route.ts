import { NextResponse } from 'next/server';
import type { LlmPurpose } from '@/types/llm';
import { verifyAuth } from '@/lib/auth';
import { callLLM } from '@/lib/llm/gateway';
import { buildIncrementalSummaryPrompt } from '@/lib/llm/prompts';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import {
  LLMAccessError,
  resolveAuthorizedLlmSelection,
} from '@/lib/llm/access';
import { buildLlmRoutingOptions } from '@/lib/llm/llmRoutingOptions';
import { resolveUserSummaryModels } from '@/lib/userRoles';
import { resolveSummaryModel } from '@/lib/llm/summaryModel';
import {
  LLM_LIMITS,
  LLMResponseError,
  LLMValidationError,
  parseIncrementalSummaryResult,
  readOptionalIdentifier,
  readOptionalText,
  readRequiredText,
} from '@/lib/llm/security';

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

    const { system, user: userMsg } = buildIncrementalSummaryPrompt(
      newTranscript,
      runningContext,
      courseContext || 'University lecture',
      language
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
    if (realtimeSummaryModelId) {
      routing = (await resolveSummaryModel(realtimeSummaryModelId, 'REALTIME_SUMMARY')).routing;
    } else if (providerOverride) {
      const overrideSelection = await resolveAuthorizedLlmSelection(user.id, providerOverride);
      routing = buildLlmRoutingOptions(overrideSelection, 'REALTIME_SUMMARY');
    } else {
      routing = { purpose: 'REALTIME_SUMMARY' };
    }

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
