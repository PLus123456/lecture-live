import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { llmModelFindFirstMock, llmModelFindUniqueMock } = vi.hoisted(() => ({
  llmModelFindFirstMock: vi.fn(),
  llmModelFindUniqueMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    llmModel: {
      findFirst: llmModelFindFirstMock,
      findUnique: llmModelFindUniqueMock,
    },
  },
}));
vi.mock('@/lib/crypto', () => ({ decrypt: (value: string) => value }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (error: unknown) => error,
}));
vi.mock('@/lib/llm/outboundPolicy', () => ({
  fetchLlmOutbound: (url: string, init?: RequestInit) => fetch(url, init),
}));

import { callLLMWithHistoryStream } from '@/lib/llm/gateway';

describe('LLM streaming wire boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const translationModel = {
      id: 'translation-model',
      displayName: 'translate',
      modelId: 'translate-test',
      thinkingDepth: 'medium',
      thinkingMode: 'NONE',
      supportsImage: false,
      maxTokens: 1000,
      contextWindow: 8192,
      temperature: 0,
      purpose: 'TRANSLATION',
      provider: {
        id: 'provider-1',
        name: 'mock',
        apiBase: 'https://llm.example/v1',
        apiKey: 'secret',
        isAnthropic: false,
      },
    };
    llmModelFindFirstMock.mockResolvedValue(translationModel);
    llmModelFindUniqueMock.mockResolvedValue(translationModel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('单条无换行超大 SSE 在字符串拼接/JSON.parse 前 cancel', async () => {
    let canceled = false;
    const wire = new TextEncoder().encode(`data: ${'x'.repeat(500 * 1024)}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wire);
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    await expect(
      callLLMWithHistoryStream(
        'translate',
        [{ role: 'user', content: 'hello' }],
        {
          purpose: 'TRANSLATION',
          maxOutputTokens: 1000,
          maxResponseUtf8Bytes: 40 * 1024,
        },
        vi.fn()
      )
    ).rejects.toThrow('LLM streaming response exceeded byte limit');
    expect(canceled).toBe(true);
  });

  it('声明超大 Content-Length 时在读取 SSE body 前拒绝', async () => {
    let pulled = false;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-length': String(20 * 1024 * 1024) },
        })
      )
    );

    await expect(
      callLLMWithHistoryStream(
        'translate',
        [{ role: 'user', content: 'hello' }],
        {
          purpose: 'TRANSLATION',
          maxOutputTokens: 1000,
          maxResponseUtf8Bytes: 40 * 1024,
        },
        vi.fn()
      )
    ).rejects.toThrow('LLM streaming response exceeded byte limit');
    expect(canceled).toBe(true);
    expect(pulled).toBe(false);
  });

  it('纯 reasoning 流也受总 wire 上限约束并 cancel', async () => {
    let canceled = false;
    const frame = `data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: 'r'.repeat(8 * 1024) } }],
    })}\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 60; index += 1) {
          controller.enqueue(encoder.encode(frame));
        }
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    await expect(
      callLLMWithHistoryStream(
        'translate',
        [{ role: 'user', content: 'hello' }],
        {
          purpose: 'TRANSLATION',
          maxOutputTokens: 1000,
          maxResponseUtf8Bytes: 40 * 1024,
        },
        vi.fn()
      )
    ).rejects.toThrow('LLM streaming response exceeded byte limit');
    expect(canceled).toBe(true);
  });

  it('非 2xx 巨大错误正文也在 sanitize 前按字节 cancel', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(stream, { status: 500 }))
    );

    await expect(
      callLLMWithHistoryStream(
        'translate',
        [{ role: 'user', content: 'hello' }],
        {
          purpose: 'TRANSLATION',
          maxOutputTokens: 1000,
          maxResponseUtf8Bytes: 40 * 1024,
        },
        vi.fn()
      )
    ).rejects.toThrow('OpenAI-compatible API response exceeded byte limit');
    expect(canceled).toBe(true);
  });

  it('实际 fetch 前模型用途已变化时按持久快照关闭失败', async () => {
    llmModelFindUniqueMock.mockResolvedValue({
      id: 'translation-model',
      displayName: 'translate',
      modelId: 'translate-test',
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
        isAnthropic: false,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callLLMWithHistoryStream(
        'translate',
        [{ role: 'user', content: 'hello' }],
        {
          modelId: 'translation-model',
          expectedModel: {
            dbModelId: 'translation-model',
            purpose: 'TRANSLATION',
          },
          maxOutputTokens: 1000,
          maxResponseUtf8Bytes: 40 * 1024,
        },
        vi.fn()
      )
    ).rejects.toThrow('LLM model snapshot mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
