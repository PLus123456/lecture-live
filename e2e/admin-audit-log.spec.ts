import { test, expect } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * admin「日志」（审计日志）面板烟测。
 *
 * 覆盖本次改动：
 *  1. 补全缺失的 action → icon/label 映射：admin.llm.model.* 与 admin.chat_files.*
 *     之前落到 FALLBACK，界面直接显示原始 action 串（如 "admin.llm.model.create"）。
 *  2. 筛选下拉新增「Chat 文件」项（admin.chat_files 前缀，服务端 startsWith 过滤）。
 *  3. 行可展开：查看完整详情（JSON 美化）、操作代码，并支持按用户/IP 快速筛选。
 *
 * 全量 route mock：AuditLogPanel 挂载时只拉 /api/admin/logs；此处按 action(startsWith)
 * 与 keyword(子串) 过滤，模拟服务端行为，便于断言筛选真实生效。
 */

const adminUser = {
  id: 'admin-1',
  email: 'admin@lecturelive.com',
  displayName: 'Admin',
  role: 'ADMIN',
};

const CREATED_AT = '2026-07-11T09:30:00.000Z';

const ALL_LOGS = [
  {
    id: 'log-model',
    action: 'admin.llm.model.create',
    detail: 'LLM model created: claude-sonnet-5 (chat, default)',
    userId: 'admin-1',
    userName: 'admin@lecturelive.com',
    ip: '10.0.0.1',
    createdAt: CREATED_AT,
  },
  {
    id: 'log-chatfile',
    action: 'admin.chat_files.delete',
    detail: JSON.stringify({ fileId: 'f1', fileName: 'notes.pdf', ownerEmail: 'stu@example.com' }),
    userId: 'admin-1',
    userName: 'admin@lecturelive.com',
    ip: '10.0.0.2',
    createdAt: CREATED_AT,
  },
  {
    id: 'log-login',
    action: 'user.login',
    detail: null,
    userId: 'u2',
    userName: 'stu@example.com',
    ip: '10.0.0.3',
    createdAt: CREATED_AT,
  },
];

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
        site_description: 'audit log smoke',
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

    // AuditLogPanel 挂载：审计日志（按 action / keyword 过滤，模拟服务端）
    if (p === '/api/admin/logs' && method === 'GET') {
      const action = url.searchParams.get('action') || '';
      const keyword = url.searchParams.get('keyword') || '';
      const filtered = ALL_LOGS.filter((log) => {
        if (action && !log.action.startsWith(action)) return false;
        if (keyword) {
          const hay = `${log.userName ?? ''} ${log.ip ?? ''} ${log.detail ?? ''}`;
          if (!hay.includes(keyword)) return false;
        }
        return true;
      });
      return fulfillJson(route, {
        logs: filtered,
        pagination: { page: 1, pageSize: 50, total: filtered.length, totalPages: 1 },
      });
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

async function loginAndOpenLogs(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });

  await page.goto('/admin?tab=logs');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: /日志|Logs/i })).toBeVisible({
    timeout: 15_000,
  });
}

test('补全后的 action 显示本地化标签而非原始串', async ({ page }) => {
  await loginAndOpenLogs(page);
  await page.screenshot({ path: 'artifacts/admin-audit-log.png', fullPage: true });

  // 之前缺映射时，界面会直接渲染原始 action 串；补全后不应再出现在（未展开的）列表里。
  await expect(page.getByText('admin.llm.model.create', { exact: true })).toHaveCount(0);
  await expect(page.getByText('admin.chat_files.delete', { exact: true })).toHaveCount(0);

  // 本地化标签应出现（中/英任一）。
  await expect(
    page.getByRole('button', { name: /新增 LLM 模型|Create LLM Model/ })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /删除 Chat 文件|Delete Chat File/ })
  ).toBeVisible();
});

test('筛选下拉包含「Chat 文件」项且能过滤', async ({ page }) => {
  await loginAndOpenLogs(page);

  const select = page.locator('select').first();
  // 选项存在（本次新增）。
  await expect(
    select.locator('option', { hasText: /Chat 文件管理|Chat File Management/ })
  ).toHaveCount(1);

  // 选中后仅剩 chat_files 行；LLM 模型行与登录行应被过滤掉。
  await select.selectOption('admin.chat_files');
  await expect(
    page.getByRole('button', { name: /删除 Chat 文件|Delete Chat File/ })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /新增 LLM 模型|Create LLM Model/ })
  ).toHaveCount(0);
});

test('展开行显示 JSON 详情/操作代码，按用户筛选联动搜索框', async ({ page }) => {
  await loginAndOpenLogs(page);

  // 展开 chat_files 删除行（其操作者为 admin，详情为 JSON）。
  await page.getByRole('button', { name: /删除 Chat 文件|Delete Chat File/ }).click();

  // 操作代码（展开面板独有）与美化后的 JSON 详情（<pre>）可见。
  await expect(page.getByText('admin.chat_files.delete', { exact: true })).toBeVisible();
  await expect(page.locator('pre')).toContainText('"fileName"');
  await expect(page.locator('pre')).toContainText('notes.pdf');

  // 点击展开面板里的「按此用户筛选」→ 同步搜索框并触发按 keyword 过滤。
  await page.getByTitle(/按此用户筛选|Filter by this user/).click();
  await expect(page.locator('input[type="text"]').first()).toHaveValue('admin@lecturelive.com');

  // keyword=admin@lecturelive.com 后，两条 admin 操作行保留，学生的登录行被过滤。
  await expect(
    page.getByRole('button', { name: /新增 LLM 模型|Create LLM Model/ })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /用户登录|User Login/ })
  ).toHaveCount(0);
});
