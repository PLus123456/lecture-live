import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  llmModelFindFirstMock,
  claimLlmTokenBudgetMock,
  completeActiveJobMock,
  failActiveJobMock,
} = vi.hoisted(() => ({
  llmModelFindFirstMock: vi.fn(),
  claimLlmTokenBudgetMock: vi.fn(),
  completeActiveJobMock: vi.fn(),
  failActiveJobMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { llmModel: { findFirst: llmModelFindFirstMock } },
}));
vi.mock('@/lib/crypto', () => ({ decrypt: (value: string) => value }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (error: unknown) => error,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { EMBEDDING: 'embedding' },
  completeActiveJob: completeActiveJobMock,
  failActiveJob: failActiveJobMock,
}));
vi.mock('@/lib/llm/resourceBudget', () => ({
  claimLlmTokenBudget: claimLlmTokenBudgetMock,
  trustedLlmUsageTokens: (
    usage: { inputTokens?: number; totalTokens?: number } | undefined,
    reservation: number
  ) => {
    const value = Number.isSafeInteger(usage?.totalTokens)
      ? usage!.totalTokens!
      : Number.isSafeInteger(usage?.inputTokens)
        ? usage!.inputTokens!
        : null;
    return value !== null && value > 0 && value <= reservation ? value : null;
  },
}));
vi.mock('@/lib/llm/tokenizer', () => ({
  estimateTokens: (text: string) => text.length,
}));
// 该文件只测 durable budget；真实 exact-origin/DNS/redirect 边界由
// outboundPolicy/outboundSinks 专项覆盖，避免业务预算测试依赖部署 env/DNS。
vi.mock('@/lib/llm/outboundPolicy', () => ({
  fetchLlmOutbound: (url: string, init?: RequestInit) => fetch(url, init),
}));

import {
  callEmbedding,
  EMBEDDING_MAX_INPUTS,
  EMBEDDING_MAX_RESPONSE_UTF8_BYTES,
  EMBEDDING_MAX_TOTAL_UTF8_BYTES,
  EMBEDDING_MAX_VECTOR_DIMENSIONS,
  EmbeddingAdmissionError,
} from '@/lib/llm/gateway';

function providerModel() {
  return {
    id: 'embed-model-id',
    displayName: 'embed',
    modelId: 'text-embedding-test',
    thinkingDepth: 'medium',
    thinkingMode: 'NONE',
    supportsImage: false,
    maxTokens: 8192,
    contextWindow: 8192,
    temperature: 0,
    purpose: 'EMBEDDING',
    provider: {
      id: 'provider-1',
      name: 'mock',
      apiBase: 'https://llm.example/v1',
      apiKey: 'secret',
      isAnthropic: false,
    },
  };
}

function embeddingResponse(
  inputs: number,
  usage?: { prompt_tokens?: number; total_tokens?: number }
): Response {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: inputs }, (_, index) => ({
        index,
        embedding: [index + 0.1, 1],
      })),
      usage,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('embedding gateway durable budget boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('LLM_EMBEDDING_BATCH_SIZE', '2');
    llmModelFindFirstMock.mockResolvedValue(providerModel());
    claimLlmTokenBudgetMock.mockResolvedValue('embed-job-1');
    completeActiveJobMock.mockResolvedValue(undefined);
    failActiveJobMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('输入数/总字节/批数越界都在 provider 解析和费用调用前拒绝', async () => {
    await expect(
      callEmbedding(Array(EMBEDDING_MAX_INPUTS + 1).fill('x'), {
        userId: 'u1',
      })
    ).rejects.toBeInstanceOf(EmbeddingAdmissionError);
    await expect(
      callEmbedding(['x'.repeat(EMBEDDING_MAX_TOTAL_UTF8_BYTES + 1)], {
        userId: 'u1',
      })
    ).rejects.toBeInstanceOf(EmbeddingAdmissionError);

    vi.stubEnv('LLM_EMBEDDING_BATCH_SIZE', '1');
    await expect(
      callEmbedding(Array(17).fill('x'), { userId: 'u1' })
    ).rejects.toThrow('Embedding batch count exceeded');

    expect(llmModelFindFirstMock).not.toHaveBeenCalled();
    expect(claimLlmTokenBudgetMock).not.toHaveBeenCalled();
    expect(completeActiveJobMock).not.toHaveBeenCalled();
  });

  it('整批上界先持久预留，再串行调用每个 provider batch', async () => {
    const order: string[] = [];
    claimLlmTokenBudgetMock.mockImplementation(async () => {
      order.push('claim');
      return 'embed-job-1';
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      order.push('fetch');
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return embeddingResponse(body.input.length, {
        prompt_tokens: body.input.length,
        total_tokens: body.input.length,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const vectors = await callEmbedding(['one', 'two', 'three'], {
      userId: 'u1',
      sessionId: 's1',
    });

    expect(vectors).toHaveLength(3);
    expect(order).toEqual(['claim', 'fetch', 'fetch']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(claimLlmTokenBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'embedding',
        userId: 'u1',
        sessionId: 's1',
        units: expect.any(Number),
      })
    );
    expect(completeActiveJobMock.mock.calls[0][2]).toBe(3);
  });

  it('预留失败时 provider 零调用', async () => {
    claimLlmTokenBudgetMock.mockRejectedValue(new Error('budget full'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callEmbedding(['one'], { userId: 'u1' })
    ).rejects.toThrow('budget full');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上游不返 usage 时成功结果按所有 batch 保守上界结算', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { input: string[] };
        return embeddingResponse(body.input.length);
      })
    );

    await callEmbedding(['one', 'two', 'three'], { userId: 'u1' });

    const reservation = claimLlmTokenBudgetMock.mock.calls[0][0].units;
    expect(completeActiveJobMock.mock.calls[0][2]).toBe(reservation);
  });

  it('embedding 只返 prompt_tokens 时按实际值结算', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        embeddingResponse(1, { prompt_tokens: 7 })
      )
    );

    await callEmbedding(['one'], { userId: 'u1' });

    expect(completeActiveJobMock.mock.calls[0][2]).toBe(7);
  });

  it('出现夸大 total_tokens 时不用较小 prompt_tokens 降低结算', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        embeddingResponse(1, {
          prompt_tokens: 1,
          total_tokens: 9_000_000,
        })
      )
    );

    await callEmbedding(['one'], { userId: 'u1' });

    const reservation = claimLlmTokenBudgetMock.mock.calls[0][0].units;
    expect(completeActiveJobMock.mock.calls[0][2]).toBe(reservation);
  });

  it('第二批断流时，已调批用可信 usage，未知批按上界结算', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        embeddingResponse(2, { prompt_tokens: 2, total_tokens: 2 })
      )
      .mockRejectedValueOnce(new Error('socket reset'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callEmbedding(['a', 'b', 'ccc'], { userId: 'u1' })
    ).rejects.toThrow('socket reset');

    // 第二批 reservation = 3 bytes + 1*8 input overhead + 64 batch overhead。
    expect(failActiveJobMock.mock.calls[0][3]).toBe(2 + 3 + 8 + 64);
  });

  it('不同 batch 各自合法但维度不一致时拒绝，并把异常批按上界结算', async () => {
    const response = (dimensions: number, inputs: number) =>
      new Response(
        JSON.stringify({
          data: Array.from({ length: inputs }, (_, index) => ({
            index,
            embedding: Array(dimensions).fill(index + 0.25),
          })),
          usage: { prompt_tokens: inputs, total_tokens: inputs },
        }),
        { status: 200 }
      );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(2, 2))
        .mockResolvedValueOnce(response(3, 1))
    );

    await expect(
      callEmbedding(['a', 'b', 'ccc'], { userId: 'u1' })
    ).rejects.toThrow('inconsistent dimensions across batches');

    // 首批可信实际=2；第二批已经发出但结构异常，按 3 bytes+8+64 保守结算。
    expect(failActiveJobMock.mock.calls[0][3]).toBe(2 + 3 + 8 + 64);
    expect(completeActiveJobMock).not.toHaveBeenCalled();
  });

  it('上游响应字节声明或向量维度越界时有界失败并保守结算', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: {
            'content-length': String(EMBEDDING_MAX_RESPONSE_UTF8_BYTES + 1),
          },
        })
      )
    );
    await expect(
      callEmbedding(['one'], { userId: 'u1' })
    ).rejects.toThrow('Embedding API response exceeded byte limit');
    const firstReservation = claimLlmTokenBudgetMock.mock.calls[0][0].units;
    expect(failActiveJobMock.mock.calls[0][3]).toBe(firstReservation);

    vi.clearAllMocks();
    llmModelFindFirstMock.mockResolvedValue(providerModel());
    claimLlmTokenBudgetMock.mockResolvedValue('embed-job-2');
    failActiveJobMock.mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                index: 0,
                embedding: Array(EMBEDDING_MAX_VECTOR_DIMENSIONS + 1).fill(1),
              },
            ],
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      callEmbedding(['one'], { userId: 'u1' })
    ).rejects.toThrow('Embedding API response missing embedding array');
    const secondReservation = claimLlmTokenBudgetMock.mock.calls[0][0].units;
    expect(failActiveJobMock.mock.calls[0][3]).toBe(secondReservation);
  });

  it('成功结算响应不可确认时不反向 fail 释放 lease', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(embeddingResponse(1, {
      prompt_tokens: 1,
      total_tokens: 1,
    })));
    completeActiveJobMock.mockRejectedValue(new Error('commit response lost'));

    await expect(
      callEmbedding(['a'], { userId: 'u1' })
    ).rejects.toThrow('commit response lost');
    expect(failActiveJobMock).not.toHaveBeenCalled();
  });
});
