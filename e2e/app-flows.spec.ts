import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

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
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('alice@example.com');
  await page.locator('input[type="password"]').fill('Abcd1234');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/home$/);
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

test('录音流程可以从首页创建新会话并跳转到会话页', async ({ page }) => {
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
  await startRecordingButton.click();

  await expect(page).toHaveURL(/\/session\/session-e2e$/);
  expect(createSessionBody).toMatchObject({
    audioSource: 'microphone',
    sourceLang: 'en',
    targetLang: 'zh',
  });
});

test('分享流程可以打开公开页面并查看已完成转录内容', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

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

    return fulfillJson(
      route,
      { error: `Unhandled API mock for ${request.method()} ${url.pathname}` },
      500
    );
  });

  await page.goto('/session/session-share/view?token=share-token');

  await expect(page.getByText('Shared Biology Lecture')).toBeVisible();
  await expect(page.getByText("Welcome to today's lecture.").first()).toBeVisible();
  await expect(page.getByText('欢迎来到今天的课程。').first()).toBeVisible();
});
