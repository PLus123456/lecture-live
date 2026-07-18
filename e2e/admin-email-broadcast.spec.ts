import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 管理员群发邮件面板（审计 #14）。
 *
 * 背景：sendGenericNotificationEmail 此前零调用 —— 用户侧「产品更新 / 优惠促销」两个开关
 * 与站点「营销邮件」总开关全是摆设，admin 关掉营销实际什么也没关。本面板是它唯一的入口。
 *
 * 群发不可撤回，所以这里主要盯流程闸门：先统计人数 → 再二次确认 → 才允许发出 mode=send。
 * 全量 route mock，不依赖真实 DB / SMTP。
 */

const adminUser = {
  id: 'admin-1',
  email: 'admin@lecturelive.com',
  displayName: 'Admin',
  role: 'ADMIN',
};

// 记录每次打到群发端点的请求体，供断言"到底发了什么模式"
let broadcastCalls: Array<Record<string, unknown>> = [];
// 由各测试改写：预览时返回的人数与营销总开关状态
let previewRecipients = 42;
let marketingEnabled = true;

test.beforeEach(async ({ page }) => {
  broadcastCalls = [];
  previewRecipients = 42;
  marketingEnabled = true;
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        allow_registration: true,
      });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }

    if (p === '/api/admin/settings' && method === 'GET') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        smtp_host: 'smtp.example.com',
        smtp_port: '587',
        marketing_emails_enabled: marketingEnabled,
      });
    }

    if (p === '/api/admin/email/broadcast' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      broadcastCalls.push(body);
      if (body.mode === 'send') {
        return fulfillJson(route, { ok: true, mode: 'send', dispatched: previewRecipients });
      }
      if (body.mode === 'test') {
        return fulfillJson(route, { ok: true, sentTo: adminUser.email });
      }
      return fulfillJson(route, {
        ok: true,
        mode: 'preview',
        recipientCount: previewRecipients,
        truncated: false,
        marketingEnabled,
      });
    }

    if (p === '/api/users/quota') {
      return fulfillJson(route, {
        quotas: {
          id: 'admin-1',
          role: 'ADMIN',
          transcriptionMinutesUsed: 0,
          transcriptionMinutesLimit: 999999,
          remainingTranscriptionMinutes: 999999,
          remainingTranscriptionMs: 999999 * 60_000,
          storageHoursUsed: 0,
          storageHoursLimit: 999999,
          storageBytesUsed: 0,
          storageBytesLimit: 1_000_000_000,
          remainingStorageBytes: 1_000_000_000,
          allowedModels: '*',
          quotaResetAt: null,
        },
      });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') return fulfillJson(route, { items: [], nextCursor: null });

    return fulfillJson(route, {});
  });
});

/** 登录成 admin 并停在设置页的邮件标签。 */
async function gotoEmailSettings(page: import('@playwright/test').Page) {
  // 先用 page.request 预热这几条路由：dev server 首次编译某个路由可能比断言窗口还慢，
  // 而「点击后等导航」这种写法一旦撞上编译就直接超时（本仓库多个 admin spec 共有的偶发红，
  // 全量跑里每次砸中的 spec 都不一样）。预热是编译，不产生浏览器导航，不影响被测行为。
  for (const path of ['/login', '/home', '/admin?tab=settings']) {
    await page.request.get(path).catch(() => undefined);
  }

  await page.goto('/login');
  await page.locator('input[type="email"]').fill(adminUser.email);
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 60_000 });

  await page.goto('/admin?tab=settings');
  await page.waitForLoadState('networkidle');

  // 切到「邮件」设置分组
  const emailTab = page.getByRole('button', { name: /^(Email|邮件)$/ }).first();
  await expect(emailTab).toBeVisible({ timeout: 15_000 });
  await emailTab.click();
}

/** 填好群发内容（标题 / 正文标题 / 正文）。 */
async function fillBroadcast(page: import('@playwright/test').Page) {
  await page.getByPlaceholder(/Subject line|邮件标题/i).fill('本月产品更新');
  await page.getByPlaceholder(/Body heading|正文大标题/i).fill('新功能上线');
  await page.getByPlaceholder(/Body text|正文内容/i).fill('我们上线了若干新功能。');
}

test('群发面板：统计人数 → 二次确认 → 才发出 mode=send', async ({ page }) => {
  await gotoEmailSettings(page);

  const countBtn = page.getByRole('button', { name: /Count recipients|统计收件人/i });
  await expect(countBtn).toBeVisible({ timeout: 15_000 });
  // 内容没填齐时不可点（防误触发）
  await expect(countBtn).toBeDisabled();

  await fillBroadcast(page);
  await expect(countBtn).toBeEnabled();
  await countBtn.click();

  await expect(page.getByText(/Eligible recipients: 42|符合条件的收件人：42/i)).toBeVisible({
    timeout: 15_000,
  });
  expect(broadcastCalls.at(-1)?.mode).toBe('preview');

  // 点「开始群发」只进入确认态，绝不能直接发出去
  await page.getByRole('button', { name: /Start broadcast|开始群发/i }).click();
  await expect(
    page.getByText(/Send to 42 recipients|确认向 42 人发送/i)
  ).toBeVisible();
  expect(broadcastCalls.some((c) => c.mode === 'send')).toBe(false);

  // 二次确认后才真发
  await page.getByRole('button', { name: /Confirm send|确认发送/i }).click();
  await expect(
    page.getByText(/Dispatch started for 42|已开始发送，共 42 封/i)
  ).toBeVisible({ timeout: 15_000 });

  const sent = broadcastCalls.filter((c) => c.mode === 'send');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ category: 'product_updates', audience: 'all' });
});

test('群发面板：可先给自己发测试信（不触碰收件人列表）', async ({ page }) => {
  await gotoEmailSettings(page);
  await fillBroadcast(page);

  await page.getByRole('button', { name: /Send test to myself|发测试信给自己/i }).click();
  await expect(
    page.getByText(new RegExp(`${adminUser.email}`, 'i'))
  ).toBeVisible({ timeout: 15_000 });

  expect(broadcastCalls.at(-1)?.mode).toBe('test');
  expect(broadcastCalls.some((c) => c.mode === 'send')).toBe(false);
});

// 这正是本 bug 的原始症状：以前关掉营销总开关什么也没关，现在必须当场看出来。
test('群发面板：营销总开关关闭时人数为 0 并给出警告，且不给群发按钮', async ({ page }) => {
  previewRecipients = 0;
  marketingEnabled = false;

  await gotoEmailSettings(page);
  await fillBroadcast(page);
  await page.getByRole('button', { name: /Count recipients|统计收件人/i }).click();

  await expect(
    page.getByText(/marketing email switch is off|营销邮件总开关已关闭/i)
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Start broadcast|开始群发/i })).toHaveCount(0);
});
