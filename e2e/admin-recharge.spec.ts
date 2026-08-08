import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginAsAdmin } from './helpers';

/**
 * Admin 充值面板烟测 —— 全量 route mock、无真实 DB。
 *
 * 覆盖：
 *  1) 渠道设置：切总开关 + 保存 → PUT /settings body 正确。
 *  2) 档位管理：新建档位 → POST /tiers body 正确。
 *  3) 进账出账：手动调整余额 → POST /adjust body 正确。
 *  4) P3-15：币种是 ISO-4217 下拉、码与符号一起提交（旧版是自由文本，填「元」静默按 USD 收款）。
 *  5) P3-18：调整余额必须先过确认弹窗；取消即不发请求（这笔没有幂等键，点一次就是一笔真台账）。
 *  6) L17：支付宝商户 PID 有录入口（代码侧一直强制，此前只能手改 DB 行才能启用）。
 */

const adminUser = { id: 'admin-1', email: 'admin@lecturelive.com', displayName: 'Admin', role: 'ADMIN' };

const settings = {
  enabled: false, currency: 'CNY', currencySymbol: '¥',
  alipayEnabled: false, wechatEnabled: false, stripeEnabled: false, sandboxEnabled: false,
  alipayAppId: '', alipayPrivateKey: '', alipayPublicKey: '', alipaySellerId: '', alipayGateway: 'https://openapi.alipay.com/gateway.do',
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

test('进账出账：手动调整余额 → 确认弹窗后 POST /adjust body 正确', async ({ page }) => {
  await loginAdmin(page);

  await page.getByRole('button', { name: /Ledger|进账出账/ }).click();

  await page.getByLabel(/User Email|用户邮箱/).fill('stu@example.com');
  await page.getByLabel(/Balance Δ|余额增减/).fill('20');

  // P3-18：现在必须先过 confirm。弹窗里要能看清「给谁、加多少」——这正是它存在的理由。
  const dialogMessages: string[] = [];
  page.once('dialog', async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept();
  });
  await page.getByRole('button', { name: /Apply Adjustment|确认调整/ }).click();

  await expect.poll(() => capturedAdjust).not.toBeNull();
  expect(capturedAdjust).toMatchObject({ email: 'stu@example.com', amountCentsDelta: 2000 });
  expect(dialogMessages).toHaveLength(1);
  expect(dialogMessages[0]).toContain('stu@example.com');
});

test('P3-18 进账出账：确认弹窗点「取消」→ 一个请求都不发', async ({ page }) => {
  await loginAdmin(page);

  await page.getByRole('button', { name: /Ledger|进账出账/ }).click();
  await page.getByLabel(/User Email|用户邮箱/).fill('stu@example.com');
  await page.getByLabel(/Balance Δ|余额增减/).fill('20');

  let dialogSeen = false;
  page.once('dialog', async (dialog) => {
    dialogSeen = true;
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: /Apply Adjustment|确认调整/ }).click();

  await expect.poll(() => dialogSeen).toBe(true);
  // 调整没有幂等键，误触即一笔真台账 —— 取消之后必须是零请求，而不是「发了再回滚」。
  await page.waitForTimeout(500);
  expect(capturedAdjust).toBeNull();
});

test('P3-15 渠道设置：币种是 ISO 下拉，选 USD 后码与符号一起提交', async ({ page }) => {
  await loginAdmin(page);

  const currency = page.locator('#recharge-currency');
  // 旧实现是自由文本 currencySymbol，填「元」会静默落成 USD（约 7.1× 超收）。
  await expect(currency).toHaveJSProperty('tagName', 'SELECT');
  await expect(currency).toHaveValue('CNY');

  await currency.selectOption('USD');
  await page.getByRole('button', { name: /^Save$|^保存$/ }).click();

  await expect.poll(() => capturedSettings).not.toBeNull();
  // 关键在于两者一致：符号只是展示派生物，不能和结算币种各说各话。
  expect(capturedSettings).toMatchObject({ currency: 'USD', currencySymbol: '$' });
});

test('L17 渠道设置：支付宝商户 PID 可录入并随保存提交', async ({ page }) => {
  await loginAdmin(page);

  const sellerId = page.getByLabel(/Merchant PID|商户 PID/);
  await expect(sellerId).toBeVisible();
  await sellerId.fill('2088000000000001');
  await page.getByRole('button', { name: /^Save$|^保存$/ }).click();

  await expect.poll(() => capturedSettings).not.toBeNull();
  expect(capturedSettings).toMatchObject({ alipaySellerId: '2088000000000001' });
});
