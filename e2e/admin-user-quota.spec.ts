import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 用户「使用时长」管理 —— admin 用户详情弹窗烟测。
 *
 * 覆盖本次新增/修复：
 *  1) 存储用量进度条显示后端实时聚合值（storageHoursUsed 不再是恒 0 的死列）。
 *  2) 单用户配额上限覆盖（转录分钟 / 存储小时）+ 一键重置本月已用 → 进入 PATCH body。
 *  3) 到期回退前置校验：设了到期时间但未选原始用户组时 Save 禁用；补选后放行。
 *  4) 到期时间快捷设置（+30天）写入 roleExpiresAt。
 *
 * 全量 route mock（对齐 admin-group-bindings.spec 的做法），不依赖真实 DB。
 */

const adminUser = {
  id: 'admin-1',
  email: 'admin@lecturelive.com',
  displayName: 'Admin',
  role: 'ADMIN',
};

// 被管理的 FREE 用户：已用 30/60 min，存储真实占用 12.5h（后端聚合而来），无到期/原始组。
const managedUser = {
  id: 'user-42',
  email: 'stu@example.com',
  displayName: 'Student One',
  role: 'FREE',
  status: 1,
  points: 0,
  originalRole: null,
  roleExpiresAt: null,
  avatarPath: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  transcriptionMinutesUsed: 30,
  transcriptionMinutesLimit: 60,
  storageHoursUsed: 12.5,
  storageHoursLimit: 100,
  allowedModels: 'local',
  customGroupId: null,
};

// 捕获 PATCH /api/admin/users 的请求体，供保存后断言
let capturedPatch: Record<string, unknown> | null = null;

test.beforeEach(async ({ page }) => {
  capturedPatch = null;
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'user quota',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }

    // 无自定义组
    if (p === '/api/admin/groups' && method === 'GET') {
      return fulfillJson(route, { groups: [] });
    }

    if (p === '/api/admin/users' && method === 'GET') {
      return fulfillJson(route, { users: [managedUser] });
    }
    if (p === '/api/admin/users' && method === 'PATCH') {
      capturedPatch = request.postDataJSON();
      return fulfillJson(route, {
        user: { ...managedUser, transcriptionMinutesUsed: 0 },
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
    if (p === '/api/sessions') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }

    return fulfillJson(route, {});
  });
});

test('用户详情弹窗：真实存储用量 + 单用户配额覆盖 + 重置 + 到期校验', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });

  await page.goto('/admin?tab=users');
  await page.waitForLoadState('networkidle');

  // 双击用户行打开详情弹窗
  const row = page.locator('tr', { hasText: 'Student One' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.dblclick();

  // 1) 存储用量进度条显示后端实时聚合值 12.5 / 100 h（此前恒显示 0）
  await expect(page.getByText('12.5 / 100 h')).toBeVisible({ timeout: 10_000 });

  // 2) 单用户配额上限覆盖
  const minInput = page.locator(
    'xpath=//label[contains(., "转录时长上限")]/following-sibling::input'
  );
  const storageInput = page.locator(
    'xpath=//label[contains(., "存储时长上限")]/following-sibling::input'
  );
  await minInput.fill('500');
  await storageInput.fill('50');

  // 一键重置本月已用 → 按钮进入激活态
  const resetBtn = page.getByRole('button', { name: /重置本月已用/ });
  await resetBtn.click();
  await expect(page.getByRole('button', { name: /保存后重置本月已用/ })).toBeVisible();

  // 3) 到期快捷设置 +30天，但未选原始用户组 → Save 禁用 + 警示
  await page.getByRole('button', { name: '+30天' }).click();
  const saveBtn = page.getByRole('button', { name: /^保存$|^Save$/ });
  await expect(saveBtn).toBeDisabled();
  await expect(page.getByText(/未指定「原始用户组」/)).toBeVisible();

  // 补选原始用户组 → 放行
  const originalRoleSelect = page.locator(
    'select:has(option:has-text("未设置"))'
  );
  await originalRoleSelect.selectOption('FREE');
  await expect(saveBtn).toBeEnabled();

  // 保存并断言 PATCH body
  await saveBtn.click();
  await expect.poll(() => capturedPatch, { timeout: 10_000 }).not.toBeNull();

  expect(capturedPatch).toMatchObject({
    userId: 'user-42',
    transcriptionMinutesLimit: 500,
    storageHoursLimit: 50,
    resetTranscriptionUsage: true,
    originalRole: 'FREE',
  });
  // roleExpiresAt 为非空 ISO 串（+30天）
  expect(typeof capturedPatch!.roleExpiresAt).toBe('string');
  expect((capturedPatch!.roleExpiresAt as string).length).toBeGreaterThan(0);
});
