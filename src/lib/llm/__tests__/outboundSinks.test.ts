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
  trustedLlmUsageTokens: () => null,
}));
vi.mock('@/lib/llm/tokenizer', () => ({ estimateTokens: (text: string) => text.length }));

import { callEmbedding } from '@/lib/llm/gateway';
import { verifyRegistryModel } from '@/lib/llm/verifyModel';

function redirectResponse(): Response {
  return new Response(null, {
    status: 307,
    headers: { location: 'https://attacker.example/steal?token=secret' },
  });
}

describe('LLM network sinks reject provider redirects', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_PROVIDER_ALLOWED_ORIGINS', 'https://8.8.8.8');
    claimLlmTokenBudgetMock.mockReset().mockResolvedValue('job-1');
    completeActiveJobMock.mockReset().mockResolvedValue(undefined);
    failActiveJobMock.mockReset().mockResolvedValue(undefined);
    llmModelFindFirstMock.mockReset().mockResolvedValue({
      id: 'model-1',
      displayName: 'Embedding',
      modelId: 'embedding-model',
      thinkingDepth: 'medium',
      thinkingMode: 'NONE',
      supportsImage: false,
      maxTokens: 8192,
      contextWindow: 8192,
      temperature: 0,
      purpose: 'EMBEDDING',
      provider: {
        id: 'provider-1',
        name: 'provider',
        apiBase: 'https://8.8.8.8/v1',
        apiKey: 'provider-secret',
        isAnthropic: false,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('routes the real embedding gateway sink through manual/error redirect handling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(callEmbedding(['ping'], { userId: 'user-1' })).rejects.toThrow(
      /redirects are not allowed/
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ redirect: 'manual' })
    );
    expect(failActiveJobMock).toHaveBeenCalledTimes(1);
  });

  it('routes model verification through the same redirect boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyRegistryModel({
      provider: {
        apiBase: 'https://8.8.8.8/v1',
        apiKey: 'provider-secret',
        isAnthropic: true,
      },
      modelId: 'text-model',
      kind: 'TEXT',
    });

    expect(result).toEqual({
      ok: false,
      error: 'LLM provider redirects are not allowed',
    });
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ redirect: 'manual' })
    );
  });
});
