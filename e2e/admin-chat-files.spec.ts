import { test, expect } from '@playwright/test';

/**
 * U13 Chat Files admin panel smoke test.
 *
 * 这个测试期待 U1 的 ChatAttachment 表已经迁移到本地 DB，否则 GET
 * `/api/admin/chat-files` 会 500。如果本地还没有 U1 的 schema 迁移，先跑：
 *   npm run db:migrate -- --name chat_storage_bytes_and_attachments
 */
test('admin chat files panel renders', async ({ page }) => {
  await page.goto('http://localhost:3000/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/home', { timeout: 30_000 });

  await page.goto('http://localhost:3000/admin?tab=chatFiles');
  await page.screenshot({ path: 'artifacts/u13-admin-chat-files.png', fullPage: true });

  // 标题（中英 i18n 任选其一）
  await expect(page.getByText(/Chat 文件|Chat Files/i).first()).toBeVisible();
});
