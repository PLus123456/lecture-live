import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * U13 — admin「Chat 文件」面板烟测（对齐重构后的 admin tab 结构）。
 *
 * 旧版硬编码 http://localhost:3000（baseURL 实际是 127.0.0.1:3100）且无任何
 * route mock，命中死 DB 报「Internal server error」。这里改成相对路径 +
 * 全量 route mock：ChatFilesPanel 挂载时拉 /api/admin/settings 与
 * /api/admin/chat-files，标题走 i18n key adminChatFiles.title（Chat Files / Chat 文件）。
 */

const adminUser = {
  id: 'admin-1',
  email: 'admin@lecturelive.com',
  displayName: 'Admin',
  role: 'ADMIN',
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
        site_description: 'U13 admin chat files',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    // 整页导航到 /admin 后 token 不在内存，靠 cookie 恢复；否则 AuthGuard 跳回 /login。
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }

    // ChatFilesPanel 挂载：设置（扁平 6 键）
    if (p === '/api/admin/settings' && method === 'GET') {
      return fulfillJson(route, {
        chat_files_retention_days: 30,
        chat_files_soft_cap_percent: 80,
        chat_files_max_upload_mb: 50,
        chat_files_quota_free_mb: 100,
        chat_files_quota_pro_mb: 1024,
        chat_files_quota_admin_mb: 10240,
      });
    }
    // ChatFilesPanel 挂载：文件列表
    if (p === '/api/admin/chat-files' && method === 'GET') {
      return fulfillJson(route, { items: [], nextCursor: null, hasMore: false });
    }

    // dashboard 外壳杂项
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
          allowedModels: 'local,claude',
          quotaResetAt: null,
        },
      });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }

    // 其余端点：良性空对象，避免 500 打断页面。
    return fulfillJson(route, {});
  });
});

test('admin chat files panel renders', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });

  await page.goto('/admin?tab=chatFiles');
  await page.waitForLoadState('networkidle');
  await page.screenshot({
    path: 'artifacts/u13-admin-chat-files.png',
    fullPage: true,
  });

  // 面板标题 h2（adminChatFiles.title）—— 用 heading 精确匹配，避开同名的侧栏 tab。
  await expect(
    page.getByRole('heading', { name: /Chat 文件|Chat Files/i })
  ).toBeVisible({ timeout: 15_000 });
});
