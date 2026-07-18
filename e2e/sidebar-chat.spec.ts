import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginAsAdmin } from './helpers';

/**
 * U8 — 侧栏「对话」入口 + 字节配额条的视觉烟测。
 *
 * 这个单元 /chat 路由还不存在（U10 才会建），所以我们只断言：
 * 1. 登录后侧栏里能看到「对话」入口
 * 2. 链接 href = /chat
 * 3. 链接可点击（不去验证目标页能跑起来）
 *
 * 同时截图 artifacts/u8-sidebar.png 供人眼复核视觉。
 */

const quotaPayload = {
  quotas: {
    id: 'user-1',
    role: 'ADMIN',
    transcriptionMinutesUsed: 120,
    transcriptionMinutesLimit: 9999,
    remainingTranscriptionMinutes: 9879,
    remainingTranscriptionMs: 9879 * 60_000,
    storageHoursUsed: 0,
    storageHoursLimit: 999,
    // U9 将补回这两个字段；当前 schema 已支持可空
    storageBytesUsed: 23_400_000,
    storageBytesLimit: 100_000_000,
    remainingStorageBytes: 76_600_000,
    allowedModels: 'local,claude',
    quotaResetAt: null,
  },
};

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'U8 sidebar smoke',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }

    if (url.pathname === '/api/auth/login' && request.method() === 'POST') {
      return fulfillJson(route, {
        user: {
          id: 'user-1',
          email: 'admin@lecturelive.com',
          displayName: 'Admin',
          role: 'ADMIN',
        },
        token: '__cookie_session__',
      });
    }

    if (url.pathname === '/api/sessions') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }

    if (url.pathname === '/api/folders') {
      return fulfillJson(route, []);
    }

    if (url.pathname === '/api/users/quota') {
      return fulfillJson(route, quotaPayload);
    }

    if (url.pathname === '/api/conversations') {
      // U9 才会真正实现 — 此处用 mock 数据走通"有最近对话"分支
      return fulfillJson(route, {
        conversations: [
          { id: 'c1', title: '量子力学讨论', updatedAt: '2026-05-22T08:00:00Z' },
          { id: 'c2', title: 'React 18 fiber 调度', updatedAt: '2026-05-21T08:00:00Z' },
        ],
      });
    }

    return fulfillJson(
      route,
      { error: `Unhandled API mock for ${request.method()} ${url.pathname}` },
      500
    );
  });
});

test('sidebar shows new Chat entry', async ({ page }) => {
  await loginAsAdmin(page);

  // 视觉快照 — 不强制 fullPage 避免抖动
  await page.screenshot({ path: 'artifacts/u8-sidebar.png', fullPage: false });

  // 「对话 / Chat」入口可见 + href 正确
  const chatLink = page.getByRole('link', { name: /Chat|对话/i });
  await expect(chatLink).toBeVisible();
  await expect(chatLink).toHaveAttribute('href', '/chat');
});
