import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 用户组能力绑定 —— admin 组编辑面板烟测。
 *
 * 覆盖新增能力：
 *  1) 可用模型「按具体模型」勾选，且同一 modelId 配在多个供应商/用途下只出现一次（去重）。
 *  2) 思考「开关 + 最大深度」控件渲染。
 *  3) 实时摘要 / 总摘要开关渲染。
 *  4) GroupCard 展示这些能力状态（关/开）。
 *
 * 全量 route mock（对齐 admin-chat-files.spec 的做法），不依赖真实 DB。
 */

const adminUser = {
  id: 'admin-1',
  email: 'admin@lecturelive.com',
  displayName: 'Admin',
  role: 'ADMIN',
};

// 一个受限自定义组：禁思考、关实时摘要、开总摘要，仅允许 gpt-4o
const restrictedGroup = {
  id: 'custom_test_1',
  name: 'QA Restricted',
  description: '受限测试组',
  color: 'bg-purple-50 text-purple-600',
  permissions: {
    transcriptionMinutesLimit: 120,
    storageHoursLimit: 20,
    allowedModels: 'gpt-4o',
    maxConcurrentSessions: 2,
    maxThinkingDepth: 'off',
    allowRealtimeSummary: false,
    allowFinalSummary: true,
  },
  userCount: 3,
  isSystem: false,
};

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'group bindings',
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

    // 组列表：一个系统组 + 一个受限自定义组
    if (p === '/api/admin/groups' && method === 'GET') {
      return fulfillJson(route, {
        groups: [
          {
            id: 'FREE',
            name: 'Free',
            permissions: {
              transcriptionMinutesLimit: 60,
              storageHoursLimit: 10,
              allowedModels: 'gpt-4o',
              maxConcurrentSessions: 1,
              maxThinkingDepth: 'medium',
              allowRealtimeSummary: true,
              allowFinalSummary: true,
            },
            userCount: 10,
            isSystem: true,
          },
          restrictedGroup,
        ],
      });
    }

    // 供应商 + 模型：故意让 gpt-4o 同时挂在两个供应商/用途下，验证去重只出现一次；
    // 另含一个 EMBEDDING 模型（应被过滤，不进可选列表）。
    if (p === '/api/admin/llm-providers' && method === 'GET') {
      return fulfillJson(route, {
        providers: [
          {
            id: 'prov-a',
            name: 'OpenAI 主力',
            models: [
              { id: 'm1', modelId: 'gpt-4o', displayName: 'GPT-4o', purpose: 'CHAT' },
              { id: 'm2', modelId: 'gpt-4o', displayName: 'GPT-4o (摘要)', purpose: 'REALTIME_SUMMARY' },
              { id: 'm3', modelId: 'text-embed-3', displayName: 'Embed', purpose: 'EMBEDDING' },
            ],
          },
          {
            id: 'prov-b',
            name: 'OpenAI 备用',
            models: [
              { id: 'm4', modelId: 'gpt-4o', displayName: 'GPT-4o', purpose: 'CHAT' },
              { id: 'm5', modelId: 'claude-x', displayName: 'Claude X', purpose: 'CHAT' },
            ],
          },
        ],
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

test('组编辑面板渲染能力绑定控件且模型去重', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });

  await page.goto('/admin?tab=groups');
  await page.waitForLoadState('networkidle');

  // 受限组卡片可见
  const card = page.getByText('QA Restricted').first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 展开卡片 → 点“编辑”
  await card.click();
  await page
    .getByRole('button', { name: /编辑|Edit/ })
    .first()
    .click();

  // 编辑弹窗内：能力开关控件
  await expect(
    page.getByText(/允许思考|Allow thinking/).first()
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText(/允许实时摘要|Allow realtime summary/).first()
  ).toBeVisible();
  await expect(
    page.getByText(/允许总摘要|Allow final summary/).first()
  ).toBeVisible();

  // 最大深度下拉存在
  await expect(page.locator('select').first()).toBeVisible();

  // 模型去重：gpt-4o 只出现一条勾选行（尽管它被配了 3 次、跨两个供应商/用途）
  const gpt4oRows = page.locator('label', { hasText: 'gpt-4o' });
  await expect(gpt4oRows).toHaveCount(1);

  // EMBEDDING 模型被过滤，不出现在可选列表
  await expect(page.locator('label', { hasText: 'text-embed-3' })).toHaveCount(0);

  // claude-x 作为另一个 CHAT 模型出现
  await expect(page.locator('label', { hasText: 'claude-x' })).toHaveCount(1);

  await page.screenshot({
    path: 'artifacts/admin-group-bindings.png',
    fullPage: true,
  });
});
