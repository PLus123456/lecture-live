import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { callLLM } from '@/lib/llm/gateway';
import { buildIncrementalSummaryPrompt } from '@/lib/llm/prompts';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import {
  LLMAccessError,
  resolveAuthorizedLlmSelection,
} from '@/lib/llm/access';
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

    const selection = await resolveAuthorizedLlmSelection(user.id, providerOverride);

    const result = await callLLM(system, userMsg, {
      ...(selection.modelId
        ? { modelId: selection.modelId }
        : selection.providerName
          ? { providerOverride: selection.providerName }
          : { purpose: 'REALTIME_SUMMARY' as const }),
    });

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
