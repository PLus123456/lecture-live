import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginAsAdmin } from './helpers';

/**
 * Admin 充值面板烟测 —— 全量 route mock、无真实 DB。
 *
 * 覆盖：
 *  1) 渠道设置：切总开关 + 保存 → PUT /settings body 正确。
 *  2) 档位管理：新建档位 → POST /tiers body 正确。
 *  3) 进账出账：手动调整余额 → POST /adjust body 正确。
 */

const adminUser = { id: 'admin-1', email: 'admin@lecturelive.com', displayName: 'Admin', role: 'ADMIN' };

const settings = {
  enabled: false, currencySymbol: '¥',
  alipayEnabled: false, wechatEnabled: false, stripeEnabled: false, sandboxEnabled: false,
  alipayAppId: '', alipayPrivateKey: '', alipayPublicKey: '', alipayGateway: 'https://openapi.alipay.com/gateway.do',
  wechatAppId: '', wechatMchId: '', wechatApiV3Key: '', wechatSerialNo: '', wechatPrivateKey: '', wechatPlatformCert: '',
  stripeSecretKey: '', stripeWebhookSecret: '', stripePublishableKey: '',
};

let capturedSettings: Record<string, unknown> | null = null;
let capturedTier: Record<string, unknown> | null = null;
let capturedAdjust: Record<string, unknown> | null = null;

test.beforeEach(async ({ page }) => {
  capturedSettings = null;
  capturedTier = null;
  capturedAdjust = null;
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();

    if (p === '/api/site-config') return fulfillJson(route, { site_name: 'QA', allow_registration: true });
    if (p === '/api/auth/login' && method === 'POST') return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    if (p === '/api/auth/refresh' && method === 'GET') return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    if (p === '/api/users/quota') {
      return fulfillJson(route, {
        quotas: { id: 'admin-1', role: 'ADMIN', transcriptionMinutesUsed: 0, transcriptionMinutesLimit: 999999, remainingTranscriptionMinutes: 999999, remainingTranscriptionMs: 0, storageHoursUsed: 0, storageHoursLimit: 999999, storageBytesUsed: 0, storageBytesLimit: 1000000000, remainingStorageBytes: 1000000000, allowedModels: '*', quotaResetAt: null },
      });
    }

    if (p === '/api/admin/recharge/settings' && method === 'GET') return fulfillJson(route, { settings });
    if (p === '/api/admin/recharge/settings' && method === 'PUT') {
      capturedSettings = request.postDataJSON();
      return fulfillJson(route, { settings: { ...settings, ...(capturedSettings as object) } });
    }
    if (p === '/api/admin/recharge/tiers' && method === 'GET') return fulfillJson(route, { tiers: [] });
    if (p === '/api/admin/recharge/tiers' && method === 'POST') {
      capturedTier = request.postDataJSON();
      return fulfillJson(route, { tier: { id: 'new', ...(capturedTier as object) } });
    }
    if (p === '/api/admin/recharge/orders') return fulfillJson(route, { orders: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } });
    if (p === '/api/admin/recharge/ledger') return fulfillJson(route, { transactions: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } });
    if (p === '/api/admin/recharge/adjust' && method === 'POST') {
      capturedAdjust = request.postDataJSON();
      return fulfillJson(route, { ok: true, summary: { walletBalanceCents: 1000, purchasedMinutesBalance: 0, role: 'FREE', roleExpiresAt: null } });
    }

    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') return fulfillJson(route, { items: [], nextCursor: null });
    return fulfillJson(route, {});
  });
});

async function loginAdmin(page: import('@playwright/test').Page) {
  await loginAsAdmin(page, { prewarm: ['/admin?tab=recharge'] });
  await page.goto('/admin?tab=recharge');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/Recharge System|充值系统/).first()).toBeVisible();
}

test('渠道设置：切总开关并保存 → PUT body enabled=true', async ({ page }) => {
  await loginAdmin(page);

  // 默认在「渠道设置」子 tab；勾选总开关
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /^Save$|^保存$/ }).click();

  await expect.poll(() => capturedSettings).not.toBeNull();
  expect(capturedSettings).toMatchObject({ enabled: true });
});

test('档位管理：新建档位 → POST body 正确', async ({ page }) => {
  await loginAdmin(page);

  await page.getByRole('button', { name: /Tiers|档位管理/ }).click();
  await page.getByRole('button', { name: /New Tier|新建档位/ }).first().click();

  // 默认 kind=topup；填名称与价格（元）
  await page.getByLabel(/Name|名称/).fill('QA Topup');
  await page.getByLabel(/^Price$|^价格$/).fill('50');

  await page.getByRole('button', { name: /^Save$|^保存$/ }).click();

  await expect.poll(() => capturedTier).not.toBeNull();
  expect(capturedTier).toMatchObject({ kind: 'topup', name: 'QA Topup', priceCents: 5000 });
});

test('进账出账：手动调整余额 → POST /adjust body 正确', async ({ page }) => {
  await loginAdmin(page);

  await page.getByRole('button', { name: /Ledger|进账出账/ }).click();

  await page.getByLabel(/User Email|用户邮箱/).fill('stu@example.com');
  await page.getByLabel(/Balance Δ|余额增减/).fill('20');
  await page.getByRole('button', { name: /Apply Adjustment|确认调整/ }).click();

  await expect.poll(() => capturedAdjust).not.toBeNull();
  expect(capturedAdjust).toMatchObject({ email: 'stu@example.com', amountCentsDelta: 2000 });
});
