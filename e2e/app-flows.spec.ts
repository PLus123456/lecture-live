import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginViaForm } from './helpers';

const quotaPayload = {
  quotas: {
    id: 'user-1',
    role: 'ADMIN',
    transcriptionMinutesUsed: 0,
    transcriptionMinutesLimit: 999999,
    remainingTranscriptionMinutes: 999999,
    remainingTranscriptionMs: 999999 * 60_000,
    storageHoursUsed: 0,
    storageHoursLimit: 999999,
    allowedModels: 'local,claude',
    quotaResetAt: null,
  },
};

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);
});

async function mockLoginAndHomeApis(page: Page) {
  let loginBody: Record<string, unknown> | null = null;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'End-to-end smoke tests',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }

    if (url.pathname === '/api/auth/login' && request.method() === 'POST') {
      loginBody = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      return fulfillJson(route, {
        user: {
          id: 'user-1',
          email: 'alice@example.com',
          displayName: 'Alice',
          role: 'ADMIN',
        },
        token: '__cookie_session__',
      });
    }

    if (url.pathname === '/api/sessions' && url.searchParams.get('limit') === '50') {
      return fulfillJson(route, {
        items: [],
        nextCursor: null,
      });
    }

    if (url.pathname === '/api/folders') {
      return fulfillJson(route, []);
    }

    if (url.pathname === '/api/users/quota') {
      return fulfillJson(route, quotaPayload);
    }

    return fulfillJson(
      route,
      { error: `Unhandled API mock for ${request.method()} ${url.pathname}` },
      500
    );
  });

  return {
    getLoginBody: () => loginBody,
  };
}

async function loginThroughUi(page: Page) {
  await loginViaForm(page, {
    email: 'alice@example.com',
    password: 'Abcd1234',
    prewarm: ['/session/prewarm'],
  });
}

// 与 loginThroughUi 相同，但用 locale 无关的选择器（button[type=submit]），
// 以便在强制中文 locale 时登录按钮文案变化后仍可点击。
async function loginLocaleAgnostic(page: Page) {
  // loginViaForm 走 button[type=submit]，本就与 locale 无关。
  await loginThroughUi(page);
}

test('登录流程会提交凭据并进入首页', async ({ page }) => {
  const mocks = await mockLoginAndHomeApis(page);

  await loginThroughUi(page);

  await expect(page.getByText('New Session')).toBeVisible();
  expect(mocks.getLoginBody()).toEqual({
    email: 'alice@example.com',
    password: 'Abcd1234',
  });
});

test('首页问候语：中文池按时段渲染，标题+副标题非空且作者为空时不出现空破折号', async ({
  page,
}) => {
  // 强制中文 locale，走中文问候语池（含 poem/fun 混排与 author 拼接逻辑）
  await page.addInitScript(() => {
    try {
      localStorage.setItem('lecture-live-locale', 'zh');
    } catch {}
  });
  await mockLoginAndHomeApis(page);
  await loginLocaleAgnostic(page);

  // 大字标题：唯一的 h1.text-3xl（侧边栏 app 名是 text-sm，不会误命中）
  const title = page.locator('h1.text-3xl');
  await expect(title).toBeVisible();
  await expect(title).not.toBeEmpty();

  // 小字副标题：紧随标题的 <p>
  const subtitle = title.locator('xpath=following-sibling::p[1]');
  await expect(subtitle).toBeVisible();
  const titleText = (await title.innerText()).trim();
  const text = (await subtitle.innerText()).trim();
  expect(text.length).toBeGreaterThan(0);

  // 确认确实走了中文池（每条中文条目均含 CJK；英文池不含），
  // 否则「无空破折号」在英文池下会平凡成立、失去意义
  const CJK = /[一-鿿]/;
  expect(CJK.test(titleText)).toBe(true);
  expect(CJK.test(text)).toBe(true);

  // 不出现「空破折号」：既不以 —— 开头也不以 —— 结尾
  expect(text.startsWith('——')).toBe(false);
  expect(text.endsWith('——')).toBe(false);
  // 若含作者分隔符，则其后必须有非空作者名
  if (text.includes('——')) {
    expect((text.split('——').pop() ?? '').trim().length).toBeGreaterThan(0);
  }
});

test('录音流程可以从首页创建新会话并跳转到会话页', async ({ page }) => {
  // Next dev 按需编译 + NAS 慢 I/O：/session/[id] 路由首编 >5s。点击开始录音后的
  // 客户端导航要等编译完成 URL 才变，冷 server 下默认 5s 断言窗必超时（表现为一直
  // 停在 /home）。用 page.request 并行预热编译（不经 page.route mock、不动页面
  // 状态）；断言上限同步放宽。
  test.setTimeout(60_000);
  const sessionPageWarmup = page.request
    .get('/session/session-e2e')
    .catch(() => undefined);

  let createSessionBody: Record<string, unknown> | null = null;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'End-to-end smoke tests',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }

    if (url.pathname === '/api/auth/login' && request.method() === 'POST') {
      return fulfillJson(route, {
        user: {
          id: 'user-1',
          email: 'alice@example.com',
          displayName: 'Alice',
          role: 'ADMIN',
        },
        token: '__cookie_session__',
      });
    }

    if (url.pathname === '/api/sessions' && url.searchParams.get('limit') === '50') {
      return fulfillJson(route, {
        items: [],
        nextCursor: null,
      });
    }

    if (url.pathname === '/api/sessions' && request.method() === 'POST') {
      createSessionBody = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      return fulfillJson(route, {
        id: 'session-e2e',
        title: 'E2E Session',
        status: 'CREATED',
      }, 201);
    }

    if (url.pathname === '/api/sessions/session-e2e') {
      return fulfillJson(route, {
        id: 'session-e2e',
        title: 'E2E Session',
        status: 'CREATED',
      });
    }

    if (url.pathname === '/api/folders') {
      return fulfillJson(route, []);
    }

    if (url.pathname === '/api/users/quota') {
      return fulfillJson(route, quotaPayload);
    }

    if (url.pathname === '/api/sessions/active-async') {
      return fulfillJson(route, { jobs: [] });
    }

    if (url.pathname === '/api/user/background-tasks') {
      return fulfillJson(route, { jobs: [], finalizingSessions: [] });
    }

    if (url.pathname === '/api/soniox/ping') {
      return fulfillJson(route, { ok: true });
    }

    if (url.pathname === '/api/soniox/temporary-key') {
      return fulfillJson(route, { error: 'Soniox disabled in E2E' }, 503);
    }

    if (url.pathname === '/api/sessions/session-e2e/transcript/draft') {
      return fulfillJson(route, { exists: false });
    }

    if (url.pathname === '/api/sessions/session-e2e/finalize') {
      return fulfillJson(route, { success: true });
    }

    return fulfillJson(
      route,
      { error: `Unhandled API mock for ${request.method()} ${url.pathname}` },
      500
    );
  });

  await loginThroughUi(page);
  await page.getByRole('button', { name: /New Session/i }).click();
  const startRecordingButton = page.getByRole('button', {
    name: 'Start Recording',
    exact: true,
  });
  await expect(startRecordingButton).toBeVisible();
  await sessionPageWarmup;
  await startRecordingButton.click();

  await expect(page).toHaveURL(/\/session\/session-e2e$/, { timeout: 15_000 });
  expect(createSessionBody).toMatchObject({
    audioSource: 'microphone',
    sourceLang: 'en',
    targetLang: 'zh',
  });
});

test('分享流程可以打开公开页面并查看已完成转录内容', async ({ page }) => {
  // view 页对 COMPLETED 会话会整页跳转到 /session/{id}/playback?token=...；
  // NAS 冷 server 下 playback 路由首编 >5s，默认断言窗必超时。预热 + 放宽上限
  // （与 recording-resilience.spec 的既有手法一致）。
  test.setTimeout(60_000);
  const playbackWarmup = page.request
    .get('/session/session-share/playback?token=share-token')
    .catch(() => undefined);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'End-to-end smoke tests',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }

    if (url.pathname === '/api/share/view/share-token') {
      return fulfillJson(route, {
        sessionId: 'session-share',
        session: {
          id: 'session-share',
          title: 'Shared Biology Lecture',
          status: 'COMPLETED',
          sourceLang: 'en',
          targetLang: 'zh',
          createdAt: '2026-03-27T10:00:00.000Z',
          durationMs: 60_000,
        },
      });
    }

    if (url.pathname === '/api/share/view/share-token/transcript') {
      return fulfillJson(route, {
        segments: [
          {
            id: 'seg-1',
            timestamp: '00:00',
            text: "Welcome to today's lecture.",
            language: 'en',
          },
        ],
        translations: {
          'seg-1': '欢迎来到今天的课程。',
        },
        summaries: [],
      });
    }

    // playback 页（分享模式）的非关键资源：无报告、无音频
    if (url.pathname === '/api/share/view/share-token/report') {
      return fulfillJson(route, { report: null });
    }

    if (url.pathname === '/api/share/view/share-token/audio') {
      return fulfillJson(route, { error: 'No audio available' }, 404);
    }

    return fulfillJson(
      route,
      { error: `Unhandled API mock for ${request.method()} ${url.pathname}` },
      500
    );
  });

  await page.goto('/session/session-share/view?token=share-token');
  await playbackWarmup;

  await expect(page.getByText('Shared Biology Lecture')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Welcome to today's lecture.").first()).toBeVisible();
  await expect(page.getByText('欢迎来到今天的课程。').first()).toBeVisible();
});
