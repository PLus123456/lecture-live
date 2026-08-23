import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * 认证突变的同源闸（guardAuthMutationRequest）在**被反代**时必须放行。
 *
 * 为什么这条只能用 request 而不是 page 驱动：
 * playwright 的 baseURL 是 http://127.0.0.1:3100，恰好等于 dev server 的绑定地址，
 * 所以浏览器发出的 Origin 天然等于 `new URL(req.url).origin`。真实部署里两者永远不等
 * —— Next standalone 的 req.url 是拿 HOSTNAME/PORT 拼的，而浏览器发的是公网域名。
 * 那次回归（十条认证路由在真域名下全 403）之所以整套测试都看不见，正是因为
 * 单测的请求构造器不带 Origin 头、而 e2e 的 baseURL 与绑定地址重合。
 *
 * 这里用 APIRequestContext 显式伪造 nginx 的转发头，把「公网域名 → 回环」这个
 * 拓扑造出来，把那个盲区堵上。
 */

const PUBLIC_HOST = 'lecture.example.com';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

/** nginx 反代到回环时会带上的那组头。 */
function proxiedHeaders(origin: string): Record<string, string> {
  return {
    'X-Forwarded-Host': PUBLIC_HOST,
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': '203.0.113.9',
    'X-Real-IP': '203.0.113.9',
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

const CROSS_ORIGIN_MESSAGE = 'Cross-origin auth mutation rejected';

/**
 * dev server 在全量并行跑时会现场编译路由，首次打过去偶发 ECONNRESET
 * （本仓库 e2e 的老毛病，见 helpers.loginViaForm 的预热注释）。
 * 这里只对「连接被重置」这类传输层错误重试，HTTP 状态码一概原样返回 ——
 * 断言的是状态码，不能被重试掩盖。
 */
async function postWithRetry(
  request: APIRequestContext,
  path: string,
  options: Parameters<APIRequestContext['post']>[1]
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request.post(path, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * 全部走 guardAuthMutationRequest 的认证突变路由。
 * login/register/verify-email/forgot-password/reset-password/resend-verification
 * 是经由 readPublicAuthJson 间接吃到这道闸的，不是只有显式调用的那四个。
 */
const GUARDED_ROUTES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/change-password',
  '/api/auth/verify-email',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/resend-verification',
] as const;

test.describe('认证同源闸：反代拓扑', () => {
  // 这一组要现场编译九条认证路由，NAS 上比默认 30s 宽松些更稳。
  test.slow();

  test('公网 Origin 与转发 Host 一致时，所有认证路由都不被同源闸拦下', async ({
    request,
  }) => {
    // 先把这批路由编译出来，免得首次请求撞上现场编译被重置连接。
    for (const path of GUARDED_ROUTES) {
      await request.post(path, { data: {}, failOnStatusCode: false }).catch(() => undefined);
    }

    // 无库 harness 下这些路由会各自回 400/401/428/5xx —— 都无所谓，
    // 这里只断言**没有一条**是被同源闸拒的。
    for (const path of GUARDED_ROUTES) {
      const res = await postWithRetry(request, path, {
        headers: proxiedHeaders(PUBLIC_ORIGIN),
        data: {},
        failOnStatusCode: false,
      });
      const body = await res.text();
      expect(
        body,
        `${path} 被同源闸拒绝（status ${res.status()}）—— 反代后的真实部署会整站登录不了`
      ).not.toContain(CROSS_ORIGIN_MESSAGE);
    }
  });

  test('登录在反代下走到自己的参数校验，而不是停在 403', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      headers: proxiedHeaders(PUBLIC_ORIGIN),
      data: {},
      failOnStatusCode: false,
    });

    // 空 body → 路由自己的 400；能看到这个就说明闸已经放行。
    expect(res.status()).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('required'),
    });
  });

  test.describe('真正的跨站仍然必须拒绝', () => {
    const HOSTILE_ORIGINS = [
      ['另一个站点', 'https://evil.example.com'],
      ['后缀混淆域名', `https://${PUBLIC_HOST}.evil.net`],
      ['协议不符', `http://${PUBLIC_HOST}`],
    ] as const;

    for (const [label, origin] of HOSTILE_ORIGINS) {
      test(`${label} → 403`, async ({ request }) => {
        const res = await request.post('/api/auth/login', {
          headers: proxiedHeaders(origin),
          data: { email: 'a@b.c', password: 'x' },
          failOnStatusCode: false,
        });

        expect(res.status()).toBe(403);
        await expect(res.json()).resolves.toMatchObject({
          error: CROSS_ORIGIN_MESSAGE,
        });
      });
    }

    test('Sec-Fetch-Site: cross-site 即使 Origin 对得上也拒绝', async ({
      request,
    }) => {
      const res = await request.post('/api/auth/login', {
        headers: {
          ...proxiedHeaders(PUBLIC_ORIGIN),
          'Sec-Fetch-Site': 'cross-site',
        },
        data: { email: 'a@b.c', password: 'x' },
        failOnStatusCode: false,
      });

      expect(res.status()).toBe(403);
    });

    test('同站兄弟子域也拒绝（no-CORS 表单能拿到 Set-Cookie）', async ({
      request,
    }) => {
      const res = await request.post('/api/auth/login', {
        headers: {
          ...proxiedHeaders(PUBLIC_ORIGIN),
          'Sec-Fetch-Site': 'same-site',
        },
        data: { email: 'a@b.c', password: 'x' },
        failOnStatusCode: false,
      });

      expect(res.status()).toBe(403);
    });
  });

  test('浏览器直连（无反代头）照常可用，本地开发不被误伤', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      headers: {
        Origin: 'http://127.0.0.1:3100',
        'Content-Type': 'application/json',
      },
      data: {},
      failOnStatusCode: false,
    });

    const body = await res.text();
    expect(body).not.toContain(CROSS_ORIGIN_MESSAGE);
  });
});
