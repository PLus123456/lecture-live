import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../../../tests/utils/http';

/**
 * L25：翻译 LLM 代理凭据的累计花费上限。
 * 凭据在任务 TRANSLATING 期间一直有效，此前只有 900/min 限速、没有任何总量约束 ——
 * 一台被攻陷的 worker 能拿它当免费 LLM 无限刷，账单记在站点头上。
 */

const {
  taskFindUniqueMock,
  taskUpdateMock,
  enforceRateLimitMock,
  callLLMWithHistoryStreamMock,
  resolveGroupBoundModelMock,
} = vi.hoisted(() => ({
  taskFindUniqueMock: vi.fn(),
  taskUpdateMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  callLLMWithHistoryStreamMock: vi.fn(),
  resolveGroupBoundModelMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: { findUnique: taskFindUniqueMock, update: taskUpdateMock },
  },
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/llm/gateway', () => ({
  callLLMWithHistoryStream: callLLMWithHistoryStreamMock,
}));
vi.mock('@/lib/llm/summaryModel', () => ({
  resolveGroupBoundModel: resolveGroupBoundModelMock,
}));
vi.mock('@/lib/userRoles', () => ({ resolveUserTranslationModelId: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (e: unknown) => e,
}));

import { POST } from '@/app/api/translate/llm-proxy/v1/chat/completions/route';

const TOKEN = 'a'.repeat(64);

function makeReq() {
  return createJsonRequest(
    'http://localhost:3000/api/translate/llm-proxy/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: { messages: [{ role: 'user', content: 'hi' }] },
    }
  );
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    status: 'TRANSLATING',
    modelId: 'm1',
    pageCount: 2,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    user: { role: 'PRO', customGroupId: null },
    ...overrides,
  };
}

describe('翻译 LLM 代理累计预算 (L25)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceRateLimitMock.mockResolvedValue(null);
    resolveGroupBoundModelMock.mockResolvedValue({
      routing: { purpose: 'TRANSLATION' },
      provider: null,
    });
    taskUpdateMock.mockResolvedValue({});
    callLLMWithHistoryStreamMock.mockResolvedValue({
      text: '译文',
      usage: { inputTokens: 10, outputTokens: 10 },
    });
  });

  it('预算内 → 正常代理', async () => {
    taskFindUniqueMock.mockResolvedValue(task());
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(callLLMWithHistoryStreamMock).toHaveBeenCalled();
  });

  it('累计已超「100k + 40k/页」预算 → 429，且绝不再打上游', async () => {
    // 2 页 → 预算 180k
    taskFindUniqueMock.mockResolvedValue(
      task({ llmInputTokens: 150_000, llmOutputTokens: 40_000 })
    );

    const res = await POST(makeReq());

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe('insufficient_quota');
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
  });

  it('页数越多预算越高：同样的累计量在 20 页任务上仍放行', async () => {
    taskFindUniqueMock.mockResolvedValue(
      task({ pageCount: 20, llmInputTokens: 150_000, llmOutputTokens: 40_000 })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });
});
