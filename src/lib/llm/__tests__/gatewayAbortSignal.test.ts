import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CallOptions.signal 文档写着「透传到出站 provider fetch」，但非流式 callLLM /
 * callLLMWithHistory 此前只挂 AbortSignal.timeout(120s)，外部 signal 被静默丢弃：
 * 客户端断开后上游请求仍跑满、照常计费。
 */

const { llmModelFindFirstMock } = vi.hoisted(() => ({
  llmModelFindFirstMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { llmModel: { findFirst: llmModelFindFirstMock, findUnique: vi.fn() } },
}));
vi.mock('@/lib/crypto', () => ({ decrypt: (value: string) => value }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (error: unknown) => error,
}));
vi.mock('@/lib/llm/outboundPolicy', () => ({
  fetchLlmOutbound: (url: string, init?: RequestInit) => fetch(url, init),
}));

import { callLLM, callLLMWithHistory } from '@/lib/llm/gateway';

function chatModel(isAnthropic: boolean) {
  return {
    id: 'chat-model',
    displayName: 'chat',
    modelId: 'chat-test',
    thinkingDepth: 'medium',
    thinkingMode: 'NONE',
    supportsImage: false,
    maxTokens: 1000,
    contextWindow: 8192,
    temperature: 0,
    purpose: 'CHAT',
    provider: {
      id: 'provider-1',
      name: 'mock',
      apiBase: 'https://llm.example/v1',
      apiKey: 'secret',
      isAnthropic,
    },
  };
}

/** fetch 桩：signal abort 时拒绝；否则 200ms 后返回成功体（证明请求没被中断）。 */
function stubAbortAwareFetch(isAnthropic: boolean) {
  const seen: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify(
                isAnthropic
                  ? { content: [{ type: 'text', text: 'late' }] }
                  : { choices: [{ message: { content: 'late' } }] }
              ),
              { status: 200 }
            )
          );
        }, 200);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    })
  );
  return seen;
}

describe('gateway 非流式调用透传外部 signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])('callLLM（isAnthropic=%s）：外部 abort 中断在途请求', async (isAnthropic) => {
    llmModelFindFirstMock.mockResolvedValue(chatModel(isAnthropic));
    const seen = stubAbortAwareFetch(isAnthropic);
    const controller = new AbortController();

    const pending = callLLM('sys', 'user', {
      purpose: 'CHAT',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(seen[0].aborted).toBe(true);
  });

  it('callLLMWithHistory：外部 abort 中断在途请求', async () => {
    llmModelFindFirstMock.mockResolvedValue(chatModel(false));
    const seen = stubAbortAwareFetch(false);
    const controller = new AbortController();

    const pending = callLLMWithHistory(
      'sys',
      [{ role: 'user', content: 'hi' }],
      { purpose: 'CHAT', signal: controller.signal }
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('不传 signal 时仍只受总超时约束，正常返回', async () => {
    llmModelFindFirstMock.mockResolvedValue(chatModel(false));
    stubAbortAwareFetch(false);

    await expect(callLLM('sys', 'user', { purpose: 'CHAT' })).resolves.toBe('late');
  });
});
