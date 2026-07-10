import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

// 回归护栏：账号设置弹窗（侧边栏左下角设置按钮打开的 UserSettingsModal）曾经绝大多数
// 文案是硬编码英文、且“段落切分说明”一段是硬编码中文——切到任一语言都“中不中英不英”。
// 这个用例锁定：弹窗随界面语言整体切换，英文时说明是英文、中文时区块标题是中文。

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

async function mockAppApis(page: Page) {
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
      return fulfillJson(route, { items: [], nextCursor: null });
    }

    if (url.pathname === '/api/folders') {
      return fulfillJson(route, []);
    }

    if (url.pathname === '/api/users/quota') {
      return fulfillJson(route, quotaPayload);
    }

    // 设置弹窗打开时会拉取可用的 LLM 服务商
    if (url.pathname === '/api/llm/models') {
      return fulfillJson(route, { models: [] });
    }

    return fulfillJson(
      route,
      { error: `Unhandled API mock for ${request.method()} ${url.pathname}` },
      500
    );
  });
}

async function loginThroughUi(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('alice@example.com');
  await page.locator('input[type="password"]').fill('Abcd1234');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test('账号设置弹窗随界面语言整体切换（不再中英混杂）', async ({ page }) => {
  await mockAppApis(page);
  await loginThroughUi(page);

  // 打开侧边栏左下角的设置按钮 → UserSettingsModal
  await page.getByRole('button', { name: 'Settings' }).click();

  const dialog = page.getByRole('heading', { name: 'Settings' });
  await expect(dialog).toBeVisible();

  // 英文态：区块标题与说明都应是英文，尤其是曾经硬编码中文的“段落切分说明”
  await expect(page.getByText('Change Password', { exact: true })).toBeVisible();
  await expect(page.getByText('ASR Defaults', { exact: true })).toBeVisible();
  await expect(page.getByText('Transcript Segment', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/automatically split into a new segment/i)
  ).toBeVisible();

  // 切换界面语言到中文（界面语言下拉是唯一含 value="zh" 选项的原生 select）
  await page.locator('select:has(option[value="zh"])').selectOption('zh');

  // 中文态：同样这些区块应变成中文，且之前硬编码的英文标题不再出现
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByText('修改密码', { exact: true })).toBeVisible();
  await expect(page.getByText('ASR 默认设置', { exact: true })).toBeVisible();
  await expect(page.getByText('转录段落', { exact: true })).toBeVisible();
  await expect(page.getByText(/自动切分为新段落/)).toBeVisible();

  // 关键回归点：切到中文后，硬编码英文标题应彻底消失
  await expect(page.getByText('Change Password', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Transcript Segment', { exact: true })).toHaveCount(0);
});
