import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../../../tests/utils/http';

const {
  taskFindUniqueMock,
  taskUpdateManyMock,
  jobFindUniqueMock,
  enforceRateLimitMock,
  callLLMWithHistoryStreamMock,
  resolveGroupBoundModelMock,
  claimLlmTokenBudgetMock,
  completeActiveJobMock,
  failActiveJobMock,
} = vi.hoisted(() => ({
  taskFindUniqueMock: vi.fn(),
  taskUpdateManyMock: vi.fn(),
  jobFindUniqueMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  callLLMWithHistoryStreamMock: vi.fn(),
  resolveGroupBoundModelMock: vi.fn(),
  claimLlmTokenBudgetMock: vi.fn(),
  completeActiveJobMock: vi.fn(),
  failActiveJobMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: { findUnique: taskFindUniqueMock },
    jobQueue: { findUnique: jobFindUniqueMock },
  },
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/payment/entitlementAdmission', () => ({
  isPaymentBenefitAvailable: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/llm/gateway', () => ({
  callLLMWithHistoryStream: callLLMWithHistoryStreamMock,
}));
vi.mock('@/lib/llm/summaryModel', () => ({
  resolveGroupBoundModel: resolveGroupBoundModelMock,
}));
vi.mock('@/lib/userRoles', () => ({ resolveUserTranslationModelId: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (error: unknown) => error,
}));
vi.mock('@/lib/jobQueue', () => {
  class ActiveJobConflictError extends Error {
    constructor(readonly activeKey: string) {
      super('conflict');
    }
  }
  class ActiveJobConcurrencyExceededError extends Error {
    readonly retryAfterSeconds = 1;
    constructor(readonly scope: string, readonly maxActiveJobs: number) {
      super('concurrency');
    }
  }
  class ActiveJobBudgetExceededError extends Error {
    readonly resetAt: Date | undefined;
    constructor(
      readonly scope: string,
      readonly dimension: string,
      readonly requestedUnits: number,
      readonly limit: number,
      resetAt?: Date
    ) {
      super('budget');
      this.resetAt = resetAt;
    }
  }
  return {
    ActiveJobConflictError,
    ActiveJobConcurrencyExceededError,
    ActiveJobBudgetExceededError,
    completeActiveJob: completeActiveJobMock,
    failActiveJob: failActiveJobMock,
    JOB_STATUS: {
      SUBMITTED: 'SUBMITTED',
      PENDING: 'PENDING',
      PROCESSING: 'PROCESSING',
      SUCCESS: 'SUCCESS',
      FAILED: 'FAILED',
    },
    JOB_TYPE: {
      DOC_TRANSLATE: 'doc_translate',
      TRANSLATION_LLM_PROXY: 'translation_llm_proxy',
    },
  };
});
vi.mock('@/lib/llm/resourceBudget', () => ({
  claimLlmTokenBudget: claimLlmTokenBudgetMock,
  conservativeLlmCallTokens: (
    system: string,
    user: string,
    maxOutputTokens: number
  ) =>
    new TextEncoder().encode(system).byteLength +
    new TextEncoder().encode(user).byteLength +
    64 +
    maxOutputTokens,
  trustedLlmUsageTokens: (
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    } | undefined,
    reservation: number
  ) => {
    const candidate = Number.isSafeInteger(usage?.totalTokens)
      ? usage!.totalTokens!
      : Number.isSafeInteger(usage?.inputTokens) &&
          Number.isSafeInteger(usage?.outputTokens)
        ? usage!.inputTokens! + usage!.outputTokens!
        : null;
    return candidate !== null && candidate > 0 && candidate <= reservation
      ? candidate
      : null;
  },
}));

import {
  ActiveJobBudgetExceededError,
  ActiveJobConcurrencyExceededError,
} from '@/lib/jobQueue';
import { POST } from '@/app/api/translate/llm-proxy/v1/chat/completions/route';
import { encodeTranslationProxyCache } from '@/lib/translate/llmProxyAdmission';

const TOKEN = 'a'.repeat(64);
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');

function makeReq(
  body: Record<string, unknown> = {
    messages: [{ role: 'user', content: 'hi' }],
  }
) {
  return createJsonRequest(
    'http://localhost:3000/api/translate/llm-proxy/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body,
    }
  );
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    userId: 'u1',
    status: 'TRANSLATING',
    modelId: 'm1',
    pageCount: 2,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    proxyTokenHash: TOKEN_HASH,
    proxyGeneration: 'generation-1',
    jobQueueId: 'schedule-1',
    user: { role: 'PRO', customGroupId: null },
    ...overrides,
  };
}

const tx = {
  translationTask: { updateMany: taskUpdateManyMock },
};

describe('POST translation LLM proxy durable admission and settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceRateLimitMock.mockResolvedValue(null);
    taskFindUniqueMock.mockResolvedValue(task());
    jobFindUniqueMock.mockImplementation(
      async (args: { where: { activeKey?: string; id?: string } }) =>
        args.where.activeKey
          ? null
          : { status: 'PROCESSING', type: 'doc_translate' }
    );
    resolveGroupBoundModelMock.mockResolvedValue({
      routing: { purpose: 'TRANSLATION' },
      provider: {
        dbModelId: 'm1',
        purpose: 'TRANSLATION',
        name: 'mock',
        model: 'mock-translate',
        maxTokens: 1000,
      },
    });
    claimLlmTokenBudgetMock.mockResolvedValue('proxy-job-1');
    taskUpdateManyMock.mockResolvedValue({ count: 1 });
    completeActiveJobMock.mockImplementation(
      async (
        _jobId: string,
        _result: unknown,
        _actual: number,
        settlement?: { mutation?: (client: typeof tx) => Promise<void> }
      ) => settlement?.mutation?.(tx)
    );
    failActiveJobMock.mockImplementation(
      async (
        _jobId: string,
        _error: unknown,
        _result: unknown,
        _actual: number,
        settlement?: { mutation?: (client: typeof tx) => Promise<void> }
      ) => settlement?.mutation?.(tx)
    );
    callLLMWithHistoryStreamMock.mockResolvedValue({
      text: '译文',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    });
  });

  it('在任何 provider 调用前预留整次上界，成功后与任务计量同事务结算', async () => {
    const order: string[] = [];
    claimLlmTokenBudgetMock.mockImplementation(async () => {
      order.push('claim');
      return 'proxy-job-1';
    });
    callLLMWithHistoryStreamMock.mockImplementation(async () => {
      order.push('provider');
      return {
        text: '译文',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    });

    const response = await POST(makeReq());

    expect(response.status).toBe(200);
    expect(order).toEqual(['claim', 'provider']);
    const admission = claimLlmTokenBudgetMock.mock.calls[0][0];
    expect(admission.owner).toEqual({
      limit: 180_000,
      settledUnitsFloor: 0,
      maxActiveJobs: 1,
    });
    expect(admission.units).toBeGreaterThan(1000);
    expect(callLLMWithHistoryStreamMock.mock.calls[0][2]).toMatchObject({
      modelId: 'm1',
      expectedModel: { dbModelId: 'm1', purpose: 'TRANSLATION' },
      maxOutputTokens: 1000,
    });
    expect(completeActiveJobMock).toHaveBeenCalledWith(
      'proxy-job-1',
      expect.any(Object),
      20,
      expect.objectContaining({ retainActiveKeyOnSuccess: true })
    );
    expect(taskUpdateManyMock).toHaveBeenCalledWith({
      where: {
        id: 't1',
        status: 'TRANSLATING',
        proxyTokenHash: TOKEN_HASH,
        proxyGeneration: 'generation-1',
        modelId: 'm1',
        jobQueueId: 'schedule-1',
      },
      data: {
        llmInputTokens: { increment: 10 },
        llmOutputTokens: { increment: 10 },
      },
    });
  });

  it.each([
    { dbModelId: 'fallback-model', purpose: 'TRANSLATION' },
    { dbModelId: 'm1', purpose: 'CHAT' },
  ])('模型快照失效/改用途时在 claim 前关闭失败: %j', async (identity) => {
    resolveGroupBoundModelMock.mockResolvedValue({
      routing: { purpose: 'TRANSLATION' },
      provider: {
        ...identity,
        name: 'mock',
        model: 'fallback',
        maxTokens: 1000,
      },
    });

    const response = await POST(makeReq());

    expect(response.status).toBe(503);
    expect(claimLlmTokenBudgetMock).not.toHaveBeenCalled();
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
  });

  it('缺少持久模型快照时不再使用组/全局 fallback', async () => {
    taskFindUniqueMock.mockResolvedValue(task({ modelId: null }));

    const response = await POST(makeReq());

    expect(response.status).toBe(503);
    expect(resolveGroupBoundModelMock).not.toHaveBeenCalled();
    expect(claimLlmTokenBudgetMock).not.toHaveBeenCalled();
  });

  it('共享 owner 预算拒绝时返回429且 provider 零调用', async () => {
    claimLlmTokenBudgetMock.mockRejectedValue(
      new ActiveJobBudgetExceededError('llm_tokens', 'owner', 1000, 180_000)
    );
    const response = await POST(makeReq());
    expect(response.status).toBe(429);
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
    expect(completeActiveJobMock).not.toHaveBeenCalled();
  });

  it('同一任务已有付费请求在途时并发门禁拒绝，provider 零调用', async () => {
    claimLlmTokenBudgetMock.mockRejectedValue(
      new ActiveJobConcurrencyExceededError('llm_tokens', 1)
    );
    const response = await POST(makeReq());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
  });

  it('已成功的同请求从持久缓存重放，不再 claim/不再计费', async () => {
    const translationProxyCache = encodeTranslationProxyCache({
      text: 'cached',
      inputTokens: 7,
      outputTokens: 3,
      actualTokens: 10,
    });
    jobFindUniqueMock.mockResolvedValueOnce({
      status: 'SUCCESS',
      result: JSON.stringify({ translationProxyCache }),
    });
    const response = await POST(makeReq());
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe('cached');
    expect(claimLlmTokenBudgetMock).not.toHaveBeenCalled();
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
  });

  it('claim 后任务代次变更：以0 usage 撤销，provider 零调用', async () => {
    taskFindUniqueMock
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ jobQueueId: 'schedule-2' }));
    const response = await POST(makeReq());
    expect(response.status).toBe(401);
    expect(failActiveJobMock).toHaveBeenCalledTimes(1);
    expect(failActiveJobMock).toHaveBeenCalledWith(
      'proxy-job-1',
      expect.anything(),
      expect.any(Object),
      0
    );
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
  });

  it('同一 JobQueue id 回炉换 proxyGeneration 后旧 worker 不得触发 provider', async () => {
    taskFindUniqueMock
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ proxyGeneration: 'generation-2' }));

    const response = await POST(makeReq());

    expect(response.status).toBe(401);
    expect(failActiveJobMock).toHaveBeenCalledWith(
      'proxy-job-1',
      expect.anything(),
      expect.any(Object),
      0
    );
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
  });

  it('claim 后读库失败只做一次0-usage结算，不重复改写终态', async () => {
    taskFindUniqueMock
      .mockResolvedValueOnce(task())
      .mockRejectedValueOnce(new Error('db unavailable'));
    const response = await POST(makeReq());
    expect(response.status).toBe(401);
    expect(failActiveJobMock).toHaveBeenCalledTimes(1);
    expect(failActiveJobMock.mock.calls[0][3]).toBe(0);
    expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { inputTokens: 5 },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    { inputTokens: 1, outputTokens: 1, totalTokens: 9_000_000 },
  ])('缺失/部分/零/夸大 usage=%j 均按整笔预留结算', async (usage) => {
    callLLMWithHistoryStreamMock.mockResolvedValue({ text: '译文', usage });
    const response = await POST(makeReq());
    expect(response.status).toBe(200);
    const reservation = claimLlmTokenBudgetMock.mock.calls[0][0].units;
    expect(completeActiveJobMock.mock.calls[0][2]).toBe(reservation);
    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          llmInputTokens: { increment: reservation },
          llmOutputTokens: { increment: 0 },
        },
      })
    );
  });

  it('provider 断流/结果未知时按整笔预留计入任务，再返502', async () => {
    callLLMWithHistoryStreamMock.mockRejectedValue(new Error('socket reset'));
    const response = await POST(makeReq());
    expect(response.status).toBe(502);
    const reservation = claimLlmTokenBudgetMock.mock.calls[0][0].units;
    expect(failActiveJobMock.mock.calls[0][3]).toBe(reservation);
    expect(taskUpdateManyMock).toHaveBeenCalled();
  });

  it('上游流式响应超出字节上限时中止并按整笔预留结算', async () => {
    callLLMWithHistoryStreamMock.mockImplementation(
      async (
        _system: string,
        _messages: unknown[],
        _options: unknown,
        onEvent: (event: { type: string; delta?: string }) => void
      ) => {
        onEvent({ type: 'text', delta: 'x'.repeat(40 * 1024 + 1) });
        return { text: '', usage: { totalTokens: 1 } };
      }
    );

    const response = await POST(makeReq());

    expect(response.status).toBe(502);
    const reservation = claimLlmTokenBudgetMock.mock.calls[0][0].units;
    expect(failActiveJobMock.mock.calls[0][3]).toBe(reservation);
    expect(taskUpdateManyMock).toHaveBeenCalled();
  });

  it('成功结算提交不可确认时关闭失败，不再 fail 释放 lease', async () => {
    completeActiveJobMock.mockRejectedValue(new Error('commit response lost'));
    const response = await POST(makeReq());
    expect(response.status).toBe(502);
    expect(failActiveJobMock).not.toHaveBeenCalled();
  });

  it('任务计量 mutation 失败与 JobQueue 终态一起回滚，不向 worker 返成功', async () => {
    taskUpdateManyMock.mockRejectedValue(new Error('counter write failed'));
    const response = await POST(makeReq());
    expect(response.status).toBe(502);
    expect(failActiveJobMock).not.toHaveBeenCalled();
  });
});
