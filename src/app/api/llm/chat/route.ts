import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { callLLMWithHistory } from '@/lib/llm/gateway';
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
  normalizeChatHistory,
  readOptionalIdentifier,
  readOptionalText,
  readRequiredText,
} from '@/lib/llm/security';

const VALID_DEPTHS: ThinkingDepth[] = ['low', 'medium', 'high'];

export const POST = withRequestLogging('llm:chat', async (req: Request) => {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 已认证用户按 userId 限流，使用管理员配置的 rate_limit_api
  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'llm:chat',
    windowMs: 60_000,
    key: `user:${payload.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const body = await req.json();
    const question = readRequiredText(
      body.question,
      'question',
      LLM_LIMITS.question
    );
    const transcriptContext = readOptionalText(
      body.transcriptContext,
      'transcriptContext',
      LLM_LIMITS.transcriptContext
    );
    const summaryContext = readOptionalText(
      body.summaryContext,
      'summaryContext',
      LLM_LIMITS.summaryContext
    );
    const chatHistory = normalizeChatHistory(body.chatHistory);
    const requestedModel = readOptionalIdentifier(
      body.model,
      'model',
      LLM_LIMITS.requestedModel
    );
    const requestedDepth =
      typeof body.thinkingDepth === 'string'
        ? (body.thinkingDepth as ThinkingDepth)
        : undefined;

    // Validate thinking depth
    const depth: ThinkingDepth =
      requestedDepth && VALID_DEPTHS.includes(requestedDepth)
        ? requestedDepth
        : 'medium';

    const selection = await resolveAuthorizedLlmSelection(payload.id, requestedModel);
    const finalDepth = resolveEffectiveThinkingDepth(
      selection.user.role,
      depth,
      selection.providerConfig
    );

    // ── Build prompt ──
    const system = buildChatPrompt(
      transcriptContext,
      summaryContext,
      finalDepth
    );

    const messages = [...chatHistory, { role: 'user' as const, content: question }];

    const result = await callLLMWithHistory(system, messages, {
      ...(selection.modelId
        ? { modelId: selection.modelId }
        : selection.providerName
          ? { providerOverride: selection.providerName }
          : {}),
      thinkingDepth: finalDepth,
    });

    return NextResponse.json({
      reply: result,
      model:
        selection.providerConfig?.displayName ||
        selection.providerName ||
        process.env.LLM_ACTIVE_PROVIDER ||
        'default',
      thinkingDepth: finalDepth,
    });
  } catch (error) {
    if (error instanceof LLMValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof LLMAccessError) {
      const status = error.message === 'User not found' ? 404 : 403;
      return NextResponse.json({ error: error.message }, { status });
    }

    console.error('Chat error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
