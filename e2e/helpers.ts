import { test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * 认证突变响应里的会话绑定（PR#234 的 token family 引入）。
 *
 * 真实的 /api/auth/login 与 /api/auth/refresh 现在都会回一个 sessionBinding，
 * 而 useAuth 拿不到它就判定会话未建立、直接停在登录页并显示
 * 「Login session binding missing」。所以任何 mock 掉这两个端点的 e2e 都必须一起给出来，
 * 否则整条登录链路在 e2e 里是断的 —— 值本身对客户端不透明（服务端是一段 HMAC capability），
 * 这里给个固定串即可。
 */
export const E2E_SESSION_BINDING = '__e2e_session_binding__';

/**
 * 表单登录并等浏览器落到 /home。
 *
 * NAS 上 dev server 首次编译一条路由可能超过全局 30s test timeout（并行 worker
 * 争用时更久），登录后的 /home 导航踩中现场编译窗口就表现为 waitForURL 随机超时：
 * 每次砸中的 spec 都不一样、单跑一律通过。处方（在 admin-email-broadcast 上连跑
 * 三轮全量验证过）：
 *  1. 先用 page.request 逐条预热编译目标路由 —— 不产生浏览器导航，也不走
 *     page.route 的 mock（APIRequestContext 直连 dev server，逼它先把路由编译完）；
 *  2. 把本测试超时抬高到能覆盖「预热 + 登录导航」，否则放宽 waitForURL 到 60s
 *     也会先被 30s 的测试级超时杀掉；
 *  3. 登录导航本身放宽到 60s。
 * 预热保持串行：NAS I/O 是瓶颈，并发预热只会加剧争用。
 */
export async function loginViaForm(
  page: Page,
  opts: { email: string; password: string; prewarm?: string[] }
) {
  const { email, password, prewarm = [] } = opts;

  test.setTimeout(test.info().timeout + 120_000);
  for (const path of ['/login', '/home', ...prewarm]) {
    await page.request.get(path).catch(() => undefined);
  }

  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 60_000 });
}

/** 管理员表单登录（本地 dev 固定账号），可带额外预热路由。 */
export async function loginAsAdmin(
  page: Page,
  opts: { prewarm?: string[] } = {}
) {
  await loginViaForm(page, {
    email: 'admin@lecturelive.com',
    password: 'admin123',
    prewarm: opts.prewarm,
  });
}

export async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200
) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * 把一串 {event,data} 编码成后端 `POST /api/llm/chat` 用的 SSE 帧格式：
 *   event: <name>\ndata: <json>\n\n
 * 与 src/app/api/llm/chat/route.ts 的 `sseFrame` 完全一致（GlobalChat 的
 * consumeSse 靠空行 `\n\n` 切帧、`event:`/`data:` 前缀解析、data 走 JSON.parse）。
 */
export function encodeSse(
  events: Array<{ event: string; data: unknown }>
): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

/**
 * 用 SSE 流回应一次 chat 请求。关键：Content-Type 必须含 `text/event-stream`，
 * 否则 GlobalChat 会把响应当成 JSON 错误处理（见 GlobalChat.tsx 的 content-type gate）。
 */
export async function fulfillSse(
  route: Route,
  events: Array<{ event: string; data: unknown }>
) {
  await route.fulfill({
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
    body: encodeSse(events),
  });
}

export async function installBrowserStubs(page: Page) {
  await page.addInitScript(() => {
    class FakeAnalyserNode {
      fftSize = 2048;
      frequencyBinCount = 1024;

      connect() {}

      disconnect() {}

      getByteFrequencyData(array: Uint8Array) {
        array.fill(0);
      }

      getByteTimeDomainData(array: Uint8Array) {
        array.fill(128);
      }
    }

    class FakeMediaStreamSource {
      connect() {}

      disconnect() {}
    }

    class FakeAudioContext {
      state = 'running';

      createAnalyser() {
        return new FakeAnalyserNode();
      }

      createMediaStreamSource() {
        return new FakeMediaStreamSource();
      }

      close() {
        return Promise.resolve();
      }
    }

    const mediaDevices = {
      enumerateDevices: async () => [
        {
          kind: 'audioinput',
          deviceId: 'mic-1',
          label: 'Built-in Mic',
          groupId: 'group-1',
        },
      ],
      getUserMedia: async () => new MediaStream(),
      getDisplayMedia: async () => new MediaStream(),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };

    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    });

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });

    Object.defineProperty(window, 'webkitAudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
  });
}
