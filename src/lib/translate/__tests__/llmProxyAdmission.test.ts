import { describe, expect, it } from 'vitest';
import {
  decodeTranslationProxyCache,
  encodeTranslationProxyCache,
  parseTranslationProxyRequest,
  planTranslationProxyRequest,
  readTranslationProxyJson,
  translationProxyTaskBudget,
  TRANSLATION_PROXY_MAX_MESSAGES,
  TRANSLATION_PROXY_MAX_PROMPT_CHARS,
  TRANSLATION_PROXY_MAX_REQUEST_UTF8_BYTES,
  TranslationProxyRequestError,
} from '@/lib/translate/llmProxyAdmission';

describe('translation proxy request admission', () => {
  it('正常 system/user/assistant 和文本 parts 按原顺序规范化', () => {
    expect(
      parseTranslationProxyRequest({
        stream: true,
        messages: [
          { role: 'system', content: 'translate' },
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello ' }, { text: 'world' }],
          },
          { role: 'assistant', content: 'ok' },
        ],
      })
    ).toEqual({
      system: 'translate',
      messages: [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'ok' },
      ],
      stream: true,
    });
  });

  it('消息数和整体 prompt 越界明确拒绝', () => {
    expect(() =>
      parseTranslationProxyRequest({
        messages: Array.from(
          { length: TRANSLATION_PROXY_MAX_MESSAGES + 1 },
          () => ({ role: 'user', content: 'x' })
        ),
      })
    ).toThrow(TranslationProxyRequestError);
    expect(() =>
      parseTranslationProxyRequest({
        messages: [
          {
            role: 'user',
            content: 'x'.repeat(TRANSLATION_PROXY_MAX_PROMPT_CHARS + 1),
          },
        ],
      })
    ).toThrow('prompt exceeds proxy limit');
    expect(() =>
      parseTranslationProxyRequest({
        messages: [
          {
            role: 'user',
            content: [
              { text: 'x'.repeat(TRANSLATION_PROXY_MAX_PROMPT_CHARS) },
              { text: 'y' },
            ],
          },
        ],
      })
    ).toThrow('prompt exceeds proxy limit');
  });

  it('在 JSON.parse 前按实际流字节拒绝无 Content-Length 的超大 body', async () => {
    const request = new Request('http://localhost/proxy', {
      method: 'POST',
      body: 'x'.repeat(TRANSLATION_PROXY_MAX_REQUEST_UTF8_BYTES + 1),
    });

    await expect(readTranslationProxyJson(request)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('Content-Length 超限在读 body 前拒绝', async () => {
    const request = new Request('http://localhost/proxy', {
      method: 'POST',
      headers: {
        'content-length': String(
          TRANSLATION_PROXY_MAX_REQUEST_UTF8_BYTES + 1
        ),
      },
      body: '{}',
    });

    await expect(readTranslationProxyJson(request)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('预留量包含序列化消息、协议开销和快照 output 上限', () => {
    const first = planTranslationProxyRequest({
      taskId: 't1',
      modelKey: 'm1',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 1000,
    });
    const changedBoundary = planTranslationProxyRequest({
      taskId: 't1',
      modelKey: 'm1',
      system: 'sy',
      messages: [{ role: 'user', content: 'shello' }],
      maxOutputTokens: 1000,
    });

    expect(first.reservedTokens).toBeGreaterThan(1000);
    expect(first.requestHash).not.toBe(changedBoundary.requestHash);
    expect(translationProxyTaskBudget(2)).toBe(180_000);
  });

  it('成功结果可安全压缩重放，损坏/超大结果关闭失败', () => {
    const encoded = encodeTranslationProxyCache({
      text: '译文',
      inputTokens: 7,
      outputTokens: 3,
      actualTokens: 10,
    });
    expect(
      decodeTranslationProxyCache(
        JSON.stringify({ translationProxyCache: encoded })
      )
    ).toEqual({
      text: '译文',
      inputTokens: 7,
      outputTokens: 3,
      actualTokens: 10,
    });
    expect(
      decodeTranslationProxyCache(
        JSON.stringify({ translationProxyCache: 'not-gzip' })
      )
    ).toBeNull();
    expect(() =>
      encodeTranslationProxyCache({
        text: 'x'.repeat(41 * 1024),
        inputTokens: 1,
        outputTokens: 1,
        actualTokens: 2,
      })
    ).toThrow('upstream response is too large');
  });

  it.each([
    ['引号和反斜杠', '"\\'.repeat(20 * 1024)],
    ['JSON 控制字符', '\u0000'.repeat(40 * 1024)],
  ])('合法 40KiB %s 结果首次编码后仍可完整重放', (_label, text) => {
    const value = {
      text,
      inputTokens: 11,
      outputTokens: 7,
      actualTokens: 18,
    };
    const encoded = encodeTranslationProxyCache(value);

    expect(
      decodeTranslationProxyCache(
        JSON.stringify({ translationProxyCache: encoded })
      )
    ).toEqual(value);
  });
});
