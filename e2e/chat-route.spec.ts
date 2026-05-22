import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * U10 — /chat 路由 + GlobalChat 界面烟测。
 *
 * 验证：
 *   1. 登录后 /chat 进入"对话"首页
 *   2. 看到「新建对话」按钮
 *   3. 截图 artifacts/u10-chat.png 供人眼复核视觉
 *
 * U9 (conversations API) 是并行单元，可能未上线 —— 用 route mock 模拟
 * 「最近对话」端点。这样测试不会因为后端 schema 变化而抖动。
 */

const quotaPayload = {
  quotas: {
    id: 'user-1',
    role: 'ADMIN',
    transcriptionMinutesUsed: 0,
    transcriptionMinutesLimit: 9999,
    remainingTranscriptionMinutes: 9999,
    remainingTranscriptionMs: 9999 * 60_000,
    storageHoursUsed: 0,
    storageHoursLimit: 999,
    storageBytesUsed: 0,
    storageBytesLimit: 1_000_000_000,
    remainingStorageBytes: 1_000_000_000,
    allowedModels: 'local,claude',
    quotaResetAt: null,
  },
};

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'U10 chat smoke',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }

    if (url.pathname === '/api/auth/login' && request.method() === 'POST') {
      return fulfillJson(route, {
        user: {
          id: 'user-1',
          email: 'admin@lecturelive.com',
          displayName: 'Admin',
          role: 'ADMIN',
        },
        token: '__cookie_session__',
      });
    }

    if (url.pathname === '/api/sessions') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }

    if (url.pathname === '/api/folders') {
      return fulfillJson(route, []);
    }

    if (url.pathname === '/api/users/quota') {
      return fulfillJson(route, quotaPayload);
    }

    if (url.pathname === '/api/conversations') {
      return fulfillJson(route, {
        conversations: [
          {
            id: 'c1',
            title: '量子力学讨论',
            startedAt: '2026-05-22T08:00:00Z',
            messageCount: 12,
          },
          {
            id: 'c2',
            title: 'React 18 fiber 调度',
            startedAt: '2026-05-21T08:00:00Z',
            messageCount: 5,
          },
        ],
      });
    }

    if (url.pathname === '/api/llm/models') {
      return fulfillJson(route, {
        models: [
          {
            name: 'mock-gpt-4',
            displayName: 'Mock GPT-4',
            supportsThinking: false,
            thinkingMode: 'NONE',
            supportsThinkingDepth: false,
            allowedDepths: [],
            supportsImage: false,
            contextWindow: 128_000,
          },
        ],
        defaultModel: 'mock-gpt-4',
      });
    }

    return fulfillJson(
      route,
      { error: `Unhandled API mock for ${request.method()} ${url.pathname}` },
      500
    );
  });
});

test('chat route renders new conversation entry', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/home$/);

  await page.goto('/chat');
  await page.waitForLoadState('networkidle');

  // 截图供人眼复核
  await page.screenshot({ path: 'artifacts/u10-chat.png', fullPage: true });

  // 关键断言：「新建对话」按钮可见
  await expect(
    page.getByRole('button', { name: /新建对话|New conversation/i })
  ).toBeVisible();

  // 最近对话卡片可见
  await expect(page.getByText('量子力学讨论')).toBeVisible();
});
