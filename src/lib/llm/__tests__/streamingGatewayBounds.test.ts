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

  it('纯 reasoning 流也受解码后 正文+思考 字节预算约束并 cancel', async () => {
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
  // 回归：wire 上限曾按「正文上限 × 8」推导，而 OpenAI 兼容流每个 token 一帧、每帧
  // ~200+ 字节包装 —— 40KiB 正文上限下 ~1.4K token（正文才 ~9KB）就被判超限。
  it('真实逐 token 帧包装的长响应（wire ≫ 正文×8）在正文预算内正常完成', async () => {
    const encoder = new TextEncoder();
    const tokens = 4000;
    let wire = '';
    for (let index = 0; index < tokens; index += 1) {
      wire += `data: ${JSON.stringify({
        id: 'chatcmpl-AbCdEfGhIjKlMnOpQrStUvWxYz012',
        object: 'chat.completion.chunk',
        created: 1729700000,
        model: 'gpt-4o-mini-2024-07-18',
        system_fingerprint: 'fp_0ba0d124f1',
        choices: [
          { index: 0, delta: { content: '你好' }, logprobs: null, finish_reason: null },
        ],
      })}\n\n`;
    }
    wire += `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: tokens, total_tokens: tokens + 10 },
    })}\n\ndata: [DONE]\n\n`;
    // 前提：wire 远超旧闸（40KiB × 8 + 64KiB = 384KiB），正文仍在 40KiB 内
    expect(encoder.encode(wire).byteLength).toBeGreaterThan(384 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(wire, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const result = await callLLMWithHistoryStream(
      'translate',
      [{ role: 'user', content: 'hello' }],
      {
        purpose: 'TRANSLATION',
        maxOutputTokens: 1000,
        maxResponseUtf8Bytes: 40 * 1024,
      },
      vi.fn()
    );
    expect(result.text).toBe('你好'.repeat(tokens));
    expect(result.usage?.outputTokens).toBe(tokens);
  });

  it('Anthropic 增量帧同样按解码后正文计：长响应在预算内完成', async () => {
    const anthropicModel = {
      id: 'translation-model',
      displayName: 'translate',
      modelId: 'claude-test',
      thinkingDepth: 'medium',
      thinkingMode: 'NONE',
      supportsImage: false,
      maxTokens: 8192,
      contextWindow: 200000,
      temperature: 0,
      purpose: 'TRANSLATION',
      provider: {
        id: 'provider-2',
        name: 'anthropic',
        apiBase: 'https://anthropic.example',
        apiKey: 'secret',
        isAnthropic: true,
      },
    };
    llmModelFindFirstMock.mockResolvedValue(anthropicModel);
    llmModelFindUniqueMock.mockResolvedValue(anthropicModel);
    const ev = (type: string, payload: unknown) =>
      `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    let wire = ev('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 1 } },
    });
    const deltas = 4000;
    for (let index = 0; index < deltas; index += 1) {
      wire += ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '你好' },
      });
    }
    wire += ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: deltas },
    });
    wire += ev('message_stop', { type: 'message_stop' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(wire, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const result = await callLLMWithHistoryStream(
      'translate',
      [{ role: 'user', content: 'hello' }],
      {
        purpose: 'TRANSLATION',
        maxOutputTokens: 8192,
        maxResponseUtf8Bytes: 40 * 1024,
      },
      vi.fn()
    );
    expect(result.text).toBe('你好'.repeat(deltas));
  });

  it('解码后正文累计越过预算即 cancel，且越界增量不下发给 onEvent', async () => {
    let canceled = false;
    const encoder = new TextEncoder();
    // 每帧 6 字节正文，7000 帧 = 42000 字节 > 40KiB；wire 远低于 16MiB 粗闸
    const frame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
    })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 7000; index += 1) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
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
    let emittedBytes = 0;
    const onEvent = vi.fn((event: { type: string; delta?: string }) => {
      if (event.type === 'text' && event.delta) {
        emittedBytes += encoder.encode(event.delta).byteLength;
      }
    });

    await expect(
      callLLMWithHistoryStream(
        'translate',
        [{ role: 'user', content: 'hello' }],
        {
          purpose: 'TRANSLATION',
          maxOutputTokens: 1000,
          maxResponseUtf8Bytes: 40 * 1024,
        },
        onEvent
      )
    ).rejects.toThrow('LLM streaming response exceeded byte limit');
    expect(canceled).toBe(true);
    expect(emittedBytes).toBeLessThanOrEqual(40 * 1024);
  });
});
