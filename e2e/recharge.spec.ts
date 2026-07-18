import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginViaForm } from './helpers';

/**
 * 充值中心（用户端）烟测 —— 全量 route mock、无真实 DB。
 *
 * 覆盖：
 *  1) 点侧栏账号块打开充值弹窗，显示余额 / 时长池 / 会员。
 *  2) 「时间」档位用余额购买 → checkout(mode=balance) body 正确 → 到账后时长池刷新。
 *  3) 「会员」档位用余额购买 → checkout body 正确。
 *  4) 「充值」档位在线支付 → 选沙箱渠道 → checkout(mode=pay, provider=sandbox) body 正确。
 */

const freeUser = {
  id: 'user-1',
  email: 'stu@example.com',
  displayName: 'Student',
  role: 'FREE',
};

const tiers = [
  { id: 't-top', kind: 'topup', name: 'Top up 100', priceCents: 10000, grantRole: null, durationDays: null, grantMinutes: null, creditCents: 12000 },
  { id: 't-pro', kind: 'membership', name: 'PRO Monthly', priceCents: 3000, grantRole: 'PRO', durationDays: 30, grantMinutes: null, creditCents: null },
  { id: 't-min', kind: 'minutes', name: '600 Minute Pack', priceCents: 5000, grantRole: null, durationDays: null, grantMinutes: 600, creditCents: null },
];

let capturedCheckout: Record<string, unknown> | null = null;
let pool = 0;
let balanceCents = 10000;

test.beforeEach(async ({ page }) => {
  capturedCheckout = null;
  pool = 0;
  balanceCents = 10000;
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, { site_name: 'LectureLive QA', allow_registration: true });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: freeUser, token: '__cookie_session__' });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user: freeUser, token: '__cookie_session__' });
    }
    if (p === '/api/users/quota') {
      return fulfillJson(route, {
        quotas: {
          id: 'user-1', role: 'FREE',
          transcriptionMinutesUsed: 60, transcriptionMinutesLimit: 60,
          purchasedMinutesBalance: pool,
          remainingTranscriptionMinutes: pool, remainingTranscriptionMs: pool * 60_000,
          storageHoursUsed: 0, storageHoursLimit: 10,
          storageBytesUsed: 0, storageBytesLimit: 104857600, remainingStorageBytes: 104857600,
          allowedModels: 'local', quotaResetAt: null,
        },
      });
    }

    if (p === '/api/wallet/me') {
      return fulfillJson(route, {
        wallet: {
          walletBalanceCents: balanceCents,
          purchasedMinutesBalance: pool,
          role: 'FREE',
          roleExpiresAt: null,
        },
        config: { enabled: true, currencySymbol: '¥', providers: ['sandbox', 'alipay', 'stripe'] },
      });
    }
    if (p === '/api/wallet/tiers') {
      return fulfillJson(route, { tiers });
    }
    if (p === '/api/wallet/transactions') {
      return fulfillJson(route, { transactions: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } });
    }
    if (p === '/api/wallet/checkout' && method === 'POST') {
      capturedCheckout = request.postDataJSON();
      const body = capturedCheckout as { tierId?: string; mode?: string };
      if (body.mode === 'balance') {
        // 模拟到账：买 600 分钟包 → 池子 +600，扣余额。
        if (body.tierId === 't-min') {
          pool += 600;
          balanceCents -= 5000;
        }
        return fulfillJson(route, { ok: true, mode: 'balance' });
      }
      return fulfillJson(route, { ok: true, mode: 'pay', provider: 'sandbox', outTradeNo: 'LLTEST', payUrl: '/api/wallet/sandbox/pay?out_trade_no=LLTEST' });
    }

    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') return fulfillJson(route, { items: [], nextCursor: null });
    return fulfillJson(route, {});
  });
});

async function login(page: import('@playwright/test').Page) {
  await loginViaForm(page, { email: 'stu@example.com', password: 'whatever' });
}

async function openRechargeModal(page: import('@playwright/test').Page) {
  // 侧栏账号块（title=充值中心/Recharge Center）
  await page.getByTitle(/Recharge Center|充值中心/).click();
  await expect(page.getByText(/Recharge Center|充值中心/).first()).toBeVisible();
}

test('打开充值弹窗：显示余额与时长池', async ({ page }) => {
  await login(page);
  await openRechargeModal(page);

  await expect(page.getByText(/Balance|余额/).first()).toBeVisible();
  await expect(page.getByText(/Time Pool|时长池/).first()).toBeVisible();
  // 余额 ¥100.00
  await expect(page.getByText('¥100.00').first()).toBeVisible();
});

test('时间档位用余额购买 → checkout body 正确 + 时长池刷新到 600', async ({ page }) => {
  await login(page);
  await openRechargeModal(page);

  // 切到「时间」tab
  await page.getByRole('button', { name: /^Time$|^时间$/ }).click();
  await expect(page.getByText('600 Minute Pack')).toBeVisible();

  // 点「用余额购买」
  await page.getByRole('button', { name: /Pay with Balance|用余额购买/ }).click();

  await expect.poll(() => capturedCheckout).not.toBeNull();
  expect(capturedCheckout).toMatchObject({ tierId: 't-min', mode: 'balance' });

  // 到账后弹窗重新拉 /api/wallet/me，时长池概览卡（.text-2xl 数值）显示 600
  await expect(
    page.locator('div.text-2xl').filter({ hasText: '600' })
  ).toBeVisible({ timeout: 10_000 });
});

test('会员档位用余额购买 → checkout body 正确', async ({ page }) => {
  await login(page);
  await openRechargeModal(page);

  await page.getByRole('button', { name: /^Membership$|^会员$/ }).click();
  await expect(page.getByText('PRO Monthly')).toBeVisible();

  await page.getByRole('button', { name: /Pay with Balance|用余额购买/ }).click();
  await expect.poll(() => capturedCheckout).not.toBeNull();
  expect(capturedCheckout).toMatchObject({ tierId: 't-pro', mode: 'balance' });
});

test('充值档位在线支付 → 选沙箱 → checkout(mode=pay, provider=sandbox)', async ({ page }) => {
  await login(page);
  await openRechargeModal(page);

  // 默认在「充值」tab；点在线支付展开渠道
  await expect(page.getByText('Top up 100')).toBeVisible();
  await page.getByRole('button', { name: /Pay Online|在线支付/ }).click();

  // 选择沙箱渠道
  await page.getByRole('button', { name: /Sandbox|沙箱/ }).click();

  await expect.poll(() => capturedCheckout).not.toBeNull();
  expect(capturedCheckout).toMatchObject({ tierId: 't-top', mode: 'pay', provider: 'sandbox' });
});
