import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * U10 — /chat 路由 + Claude 式起聊首页烟测（对齐 PR#169/#170 重构）。
 *
 * 重构后 `/chat` 不再是「新建对话按钮 + 卡片列表」的旧首页，而是 ChatHomeClient：
 * 居中问候 + composer（textarea）+ 最近对话列表；「新建对话」按钮搬进了常驻的
 * ChatSidebar（进入 /chat 区域滑入）。本测试只做界面烟测：
 *   1. 登录 → 整页导航到 /chat（token 不持久化，靠 /api/auth/refresh 从 cookie 恢复会话）
 *   2. composer 可见 + ChatSidebar 的「新建对话」按钮可见
 *   3. 最近对话卡片可见
 *   4. 截图 artifacts/u10-chat.png 供人眼复核
 *
 * conversations API 用 route mock 模拟，避免因后端 schema/死 DB 抖动。
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

const adminUser = {
  id: 'user-1',
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
        site_description: 'U10 chat smoke',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }

    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }

    // 整页导航到 /chat 后 token 不在内存，靠 refresh 从 HttpOnly cookie 恢复会话。
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }

    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }

    // conversationListStore.refresh → GET /api/conversations?recent=50
    if (p === '/api/conversations' && method === 'GET') {
      return fulfillJson(route, {
        conversations: [
          {
            id: 'c1',
            title: '量子力学讨论',
            startedAt: '2026-05-22T08:00:00Z',
            endedAt: null,
            degradationLevel: 0,
            archived: false,
            messageCount: 12,
            sessionIds: [],
            sessionBound: false,
          },
          {
            id: 'c2',
            title: 'React 18 fiber 调度',
            startedAt: '2026-05-21T08:00:00Z',
            endedAt: null,
            degradationLevel: 0,
            archived: false,
            messageCount: 5,
            sessionIds: [],
            sessionBound: false,
          },
        ],
      });
    }

    // ComposerModelControls → GET /api/llm/models
    if (p === '/api/llm/models') {
      return fulfillJson(route, {
        models: [
          {
            name: 'mock-gpt-4',
            id: 'mock-gpt-4',
            modelId: 'mock-gpt-4',
            displayName: 'Mock GPT-4',
            supportsThinking: false,
            thinkingMode: 'NONE',
            supportsThinkingDepth: false,
            allowedDepths: [],
            supportsImage: false,
            contextWindow: 128_000,
            purpose: 'CHAT',
          },
        ],
        defaultModel: 'mock-gpt-4',
      });
    }

    // 其余端点：返回良性空对象（本烟测不依赖它们），避免误报 500 打断页面。
    return fulfillJson(route, {});
  });
});

test('chat route renders composer, new-conversation entry, and recent chats', async ({
  page,
}) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.getByRole('button', { name: /Sign In|登录/i }).click();
  await expect(page).toHaveURL(/\/home$/);

  await page.goto('/chat');
  await page.waitForLoadState('networkidle');

  // 截图供人眼复核视觉
  await page.screenshot({ path: 'artifacts/u10-chat.png', fullPage: true });

  // Claude 式首页 composer（唯一 textarea）
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });

  // ChatSidebar 的「新建对话」按钮（重构后从首页搬到常驻侧栏，进入 /chat 区域滑入）
  await expect(
    page.getByRole('button', { name: /新建对话|New conversation/i }).first()
  ).toBeVisible({ timeout: 15_000 });

  // 最近对话卡片可见（首页列表与侧栏列表共享同一 store，会命中多处 → first）
  await expect(page.getByText('量子力学讨论').first()).toBeVisible({
    timeout: 15_000,
  });
});
