import { describe, expect, it } from 'vitest';

/**
 * M29 / L58 / L59 的共同根因单测。
 *
 * 三个路由（chat-uploads POST、export POST、admin/upload-icon POST）此前都写
 *   `const n = Number(req.headers.get('content-length') ?? '');`
 *   `if (Number.isFinite(n) && n > MAX) return 413;`
 * 头部缺失（chunked transfer-encoding）时 `Number('')` 得 **0**（不是 NaN），
 * `Number.isFinite(0)` 为真而 `0 > MAX` 为假 —— 整段预检被跳过，随后
 * `req.formData()` / `req.json()` 把任意大的 body 缓冲进内存。
 *
 * 这里直接钉住两件事：
 *   1. 声明长度缺失/畸形时**绝不放行**（早退函数返回 false，由流式上限接管）；
 *   2. 无 content-length 的流式 body 超限时被真正拦下，且**不会把剩余字节读完**。
 */

import {
  declaredLengthExceeds,
  parseFormDataWithLimit,
  parseJsonWithLimit,
  readBodyWithLimit,
  isUploadedFile,
} from '@/lib/requestBodyLimit';

/** 构造一个没有 content-length 的流式请求（等价于 chunked transfer-encoding）。 */
function makeChunkedRequest(
  chunkCount: number,
  chunkSize: number,
  contentType = 'application/octet-stream'
): { req: Request; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  const req = new Request('http://localhost/api/x', {
    method: 'POST',
    body: stream,
    headers: { 'content-type': contentType },
    // @ts-expect-error duplex 是 Node/undici 流式 body 的必填项，TS lib 尚未收录
    duplex: 'half',
  });
  return { req, pulled: () => pulled };
}

describe('declaredLengthExceeds —— 声明长度只做早退，缺失绝不放行', () => {
  it('缺 content-length（chunked）→ false，不早退；旧写法在这里会算出 0 并放行', () => {
    const req = new Request('http://localhost/api/x', { method: 'POST' });
    expect(req.headers.get('content-length')).toBeNull();

    // 这一行就是旧代码的原样复刻，钉住"它为什么错"：
    expect(Number(req.headers.get('content-length') ?? '')).toBe(0);
    expect(Number.isFinite(0)).toBe(true);

    expect(declaredLengthExceeds(req, 100)).toBe(false);
  });

  it.each(['', '   ', 'abc', '-1', 'NaN'])(
    '畸形 content-length %j → false（交给流式上限，不当成 0 放行）',
    (raw) => {
      const req = new Request('http://localhost/api/x', {
        method: 'POST',
        headers: { 'content-length': raw },
      });
      expect(declaredLengthExceeds(req, 100)).toBe(false);
    }
  );

  it('声明长度超限 → true（廉价早退）', () => {
    const req = new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'content-length': '999' },
    });
    expect(declaredLengthExceeds(req, 100)).toBe(true);
  });
});

describe('readBodyWithLimit —— 流式累计字节才是真正的上限', () => {
  it('无 content-length 的超大 body 被拦下，且不会把剩余分块读完', async () => {
    // 100 块 × 1KB = 100KB，上限 8KB → 第 9 块就该越线断流。
    const { req, pulled } = makeChunkedRequest(100, 1024);

    const result = await readBodyWithLimit(req, 8 * 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-large');
    // 关键：真的断流了，而不是读完 100 块才判超限（那就还是 OOM 面）。
    expect(pulled()).toBeLessThan(20);
  });

  it('未超限的流式 body 原样读回', async () => {
    const { req } = makeChunkedRequest(4, 1024);
    const result = await readBodyWithLimit(req, 8 * 1024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBe(4096);
  });

  it('恰好等于上限 → 放行（边界不误杀）', async () => {
    const { req } = makeChunkedRequest(8, 1024);
    const result = await readBodyWithLimit(req, 8 * 1024);
    expect(result.ok).toBe(true);
  });
});

describe('parseFormDataWithLimit / parseJsonWithLimit', () => {
  it('multipart 正常解析，file 是真 File', async () => {
    const fd = new FormData();
    fd.set('conversationId', 'conv-1');
    fd.set('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    const req = new Request('http://localhost/api/x', { method: 'POST', body: fd });

    const parsed = await parseFormDataWithLimit(req, 1024 * 1024);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.get('conversationId')).toBe('conv-1');
    expect(isUploadedFile(parsed.value.get('file'))).toBe(true);
  });

  it('无 content-length 的超大 multipart → too-large（不是 invalid，也不是放行）', async () => {
    const { req } = makeChunkedRequest(
      100,
      1024,
      'multipart/form-data; boundary=----x'
    );
    const parsed = await parseFormDataWithLimit(req, 4 * 1024);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('too-large');
  });

  it('JSON 正常解析 / 超限 / 非法各归各位', async () => {
    const good = new Request('http://localhost/api/x', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    const parsedGood = await parseJsonWithLimit<{ a: number }>(good, 1024);
    expect(parsedGood.ok && parsedGood.value.a).toBe(1);

    const { req: big } = makeChunkedRequest(100, 1024, 'application/json');
    const parsedBig = await parseJsonWithLimit(big, 4 * 1024);
    expect(parsedBig.ok).toBe(false);
    if (!parsedBig.ok) expect(parsedBig.reason).toBe('too-large');

    const bad = new Request('http://localhost/api/x', {
      method: 'POST',
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    });
    const parsedBad = await parseJsonWithLimit(bad, 1024);
    expect(parsedBad.ok).toBe(false);
    if (!parsedBad.ok) expect(parsedBad.reason).toBe('invalid');
  });
});

describe('isUploadedFile —— L60：字符串字段不是文件', () => {
  it('普通字符串字段被拒（旧的 `as File` 断言会让它一路走到 arrayBuffer()）', () => {
    expect(isUploadedFile('not-a-file')).toBe(false);
    expect(isUploadedFile(null)).toBe(false);
  });

  it('真 File 通过', () => {
    expect(isUploadedFile(new File(['x'], 'x.txt', { type: 'text/plain' }))).toBe(true);
  });

  it('钉住 L60 的具体绕过算式：字符串的 .size 是 undefined，两道检查都判不出来', () => {
    const value = 'not-a-file' as unknown as File;
    expect(value.size).toBeUndefined();
    // 旧代码的两道闸：`file.size <= 0` 与 `file.size > maxBytes`
    expect(value.size <= 0).toBe(false);
    expect(value.size > 1024).toBe(false);
  });
});
