import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L58：export 的 64MB 硬上限此前只看声明长度
 * （`Number(req.headers.get('content-length') ?? '')` → chunked 请求得 0 而非 NaN，
 * 预检整段被跳过），随后 `req.json()` 把任意大的 body 缓冲进内存。
 * 现在改成流式累计字节，越线断流。
 */

const { verifyAuthMock, enforceRateLimitMock } = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));

import { POST } from '@/app/api/export/route';

/** 无 content-length 的流式请求；pulled() 用来验证"真的断流了"。 */
function makeChunkedJsonRequest(chunkCount: number, chunkSize: number) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled++;
      // 填成合法 JSON 字符也无所谓 —— 上限在解析之前就该拦住。
      controller.enqueue(new Uint8Array(chunkSize).fill(0x20));
    },
  });
  const req = new Request('http://localhost:3000/api/export', {
    method: 'POST',
    body: stream,
    headers: { 'content-type': 'application/json' },
    // @ts-expect-error duplex 是流式 body 的必填项，TS lib 尚未收录
    duplex: 'half',
  });
  return { req, pulled: () => pulled };
}

describe('POST /api/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    enforceRateLimitMock.mockResolvedValue(null);
  });

  it('正常导出 markdown', async () => {
    const req = new Request('http://localhost:3000/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'markdown',
        title: 'Lecture 1',
        date: '2026-08-22',
        sourceLang: 'en',
        targetLang: 'zh',
        segments: [],
        translations: {},
        summaries: [],
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/markdown');
  });

  it('段数超过 MAX_SEGMENTS → 400（既有校验不受影响）', async () => {
    const req = new Request('http://localhost:3000/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'json',
        title: 't',
        date: 'd',
        sourceLang: 'en',
        targetLang: 'zh',
        segments: new Array(50_001).fill(0),
        translations: {},
        summaries: [],
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });

  it('L58：无 content-length 的超大 body → 413，且不把全部分块读进内存', async () => {
    // 1200 × 64KB ≈ 75MB > 64MB 上限
    const { req, pulled } = makeChunkedJsonRequest(1200, 64 * 1024);
    expect(req.headers.get('content-length')).toBeNull();

    const response = await POST(req);

    expect(response.status).toBe(413);
    expect(pulled()).toBeLessThan(1200);
  });

  it('非法 JSON → 400（此前落进 catch 回含糊的 500）', async () => {
    const req = new Request('http://localhost:3000/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });

  it('未登录 → 401，且不消费 body', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const { req, pulled } = makeChunkedJsonRequest(10, 1024);
    const response = await POST(req);
    expect(response.status).toBe(401);
    // ReadableStream 构造时会预热一次 pull（平台行为，不是路由读了 body）；
    // 只要没有把 10 块全拉走就说明路由没消费 body。
    expect(pulled()).toBeLessThanOrEqual(1);
  });
});
