import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';

/**
 * L9：全站此前只有 cookie 的 `SameSite=Lax` 一层 CSRF 防线，没有任何 Origin/Referer 校验。
 * Lax 是**浏览器**行为，老浏览器（Chrome<80 / Safari<12）下跨站表单可以带着受害者 cookie
 * 打任意写接口。这里补的是第二道门：带 Origin 的跨站写请求直接 403。
 */

function post(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(new Request(url, { method: 'POST', headers }));
}

function get(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request(url, { method: 'GET', headers }));
}

describe('L9 middleware CSRF —— 跨站写请求', () => {
  it('跨站 Origin 的 POST 被 403 拦下', async () => {
    const res = await middleware(
      post('http://app.example.com/api/sessions', {
        origin: 'https://evil.example',
        host: 'app.example.com',
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Cross-site request blocked',
    });
  });

  it('同源 Origin 的 POST 放行到鉴权层（不是 403）', async () => {
    const res = await middleware(
      post('http://app.example.com/api/sessions', {
        origin: 'http://app.example.com',
        host: 'app.example.com',
      })
    );
    // 无凭据 → 401（说明已经越过 CSRF 这道门）
    expect(res.status).toBe(401);
  });

  it('scheme 不同但 host 相同时放行（反代漏配 x-forwarded-proto 不该打死全站写操作）', async () => {
    const res = await middleware(
      post('http://app.example.com/api/sessions', {
        origin: 'https://app.example.com',
        host: 'app.example.com',
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('经反代时以 x-forwarded-host 为准', async () => {
    const res = await middleware(
      post('http://127.0.0.1:3000/api/sessions', {
        origin: 'https://app.example.com',
        'x-forwarded-host': 'app.example.com',
        host: '127.0.0.1:3000',
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('Origin: null 按不同源处理', async () => {
    const res = await middleware(
      post('http://app.example.com/api/sessions', {
        origin: 'null',
        host: 'app.example.com',
      })
    );
    expect(res.status).toBe(403);
  });

  it('不带 Origin 的调用方（curl / 服务端对服务端）不受影响', async () => {
    const res = await middleware(
      post('http://app.example.com/api/sessions', { host: 'app.example.com' })
    );
    expect(res.status).not.toBe(403);
  });

  it('GET 不受 CSRF 判定影响', async () => {
    const res = await middleware(
      get('http://app.example.com/api/share/view/abc', {
        origin: 'https://evil.example',
        host: 'app.example.com',
      })
    );
    expect(res.status).not.toBe(403);
  });

  it('支付回调 / 翻译 worker 等机器入口显式豁免（误伤代价是丢钱）', async () => {
    for (const path of [
      '/api/wallet/callback/alipay',
      '/api/wallet/sandbox/confirm',
      '/api/translate/llm-proxy/chat',
    ]) {
      const res = await middleware(
        post(`http://app.example.com${path}`, {
          origin: 'https://gateway.example',
          host: 'app.example.com',
        })
      );
      expect(res.status, path).not.toBe(403);
    }
  });

  it('非 /api 路径不受影响', async () => {
    const res = await middleware(
      post('http://app.example.com/session/abc/view', {
        origin: 'https://evil.example',
        host: 'app.example.com',
      })
    );
    expect(res.status).not.toBe(403);
  });
});
