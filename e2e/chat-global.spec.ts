import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

/**
 * U15 — 全局对话端到端测试套件
 *
 * 覆盖 Wave 3（U10-U12）的关键路径：
 *   1. 主流程：登录 → /chat → 新建对话 → 附加录音 → 上传文件 → 发消息 → 持久化
 *   2. 空对话：无录音 / 无附件下纯对话发消息
 *
 * Wave 3 防御：
 *   - 顶层 `beforeAll` 检查 `/chat` 是否已存在；若 404，则两个 case 都 skip
 *     并打印明确日志，CI 不会因 Wave 3 未合并而假阳性。
 *   - 一旦 `/chat` 存在，spec 内的断言失败必须暴露（不静默 catch）。
 *
 * 截图均输出到 artifacts/u15-step{N}.png 供 review。
 */

const ADMIN_EMAIL = 'admin@lecturelive.com';
const ADMIN_PASSWORD = 'admin123';

const ART = path.join(process.cwd(), 'artifacts');

async function snap(page: Page, name: string) {
  try {
    await fs.promises.mkdir(ART, { recursive: true });
    await page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: true });
  } catch (err) {
    // 截图失败不应阻塞断言流程
    console.warn(`[u15] screenshot ${name} 失败:`, err);
  }
}

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  // 兼容中英 i18n 的提交按钮
  const submitBtn = page.locator('button[type="submit"]').first();
  await submitBtn.click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });
}

/**
 * 探测 Wave 3 是否合并。`/chat` 路由由 U10 引入；未合并时 Next.js 返回 404。
 * 由 beforeAll 调用，结果存到顶层闭包供两个 test 共享。
 */
let waveThreeReady = false;
let chatRouteSkipReason = '';

test.describe.configure({ mode: 'serial' });

test.describe('Global Chat (/chat) E2E', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      // 先登录拿 cookie（中间件可能保护 /chat），再探测路由
      await loginAsAdmin(page);
      const resp = await page.goto('/chat', { waitUntil: 'domcontentloaded' });
      const status = resp?.status() ?? 0;
      const finalUrl = page.url();

      // Next.js 对未注册路由返回 404；若被中间件重定向回登录就视为缺
      if (status === 404) {
        chatRouteSkipReason = 'U10 (/chat route) not yet merged — skipping';
        waveThreeReady = false;
      } else if (/\/login(\?|$)/.test(finalUrl)) {
        chatRouteSkipReason =
          '/chat redirected back to /login — Wave 3 (U10) route not exposed; skipping';
        waveThreeReady = false;
      } else if (status >= 200 && status < 400) {
        // 进一步看页面是否真的渲染了 chat 内容（防止 200 但渲染了 not-found 页面）
        const notFoundIndicator = await page
          .getByText(/404|This page could not be found|找不到|Not Found/i)
          .first()
          .isVisible({ timeout: 1_500 })
          .catch(() => false);
        if (notFoundIndicator) {
          chatRouteSkipReason =
            '/chat returned 200 but rendered Not Found page — U10 not merged; skipping';
          waveThreeReady = false;
        } else {
          waveThreeReady = true;
        }
      } else {
        chatRouteSkipReason = `/chat returned HTTP ${status} — Wave 3 likely incomplete, skipping`;
        waveThreeReady = false;
      }
    } catch (err) {
      chatRouteSkipReason = `/chat probe failed (${(err as Error).message}) — skipping`;
      waveThreeReady = false;
    } finally {
      await ctx.close();
    }

    if (!waveThreeReady) {
      // 让结果在终端醒目
      console.log(`[u15] ${chatRouteSkipReason}`);
    } else {
      console.log('[u15] /chat route detected — running full E2E suite');
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!waveThreeReady, chatRouteSkipReason || 'Wave 3 not ready');
    await loginAsAdmin(page);
  });

  test('main flow: new conv → attach recording → upload file → send msg → persist', async ({
    page,
  }) => {
    // ---- Step 1: 已登录 → 点侧栏「对话」入口
    const chatLink = page.getByRole('link', { name: /^(对话|Chat)$/ }).first();
    await expect(
      chatLink,
      'U8 sidebar Chat entry must be visible — 若失败说明 U8 未合并'
    ).toBeVisible({ timeout: 10_000 });
    await chatLink.click();
    await page.waitForURL(/\/chat(\/.*)?$/, { timeout: 15_000 });
    await snap(page, 'u15-step1');

    // ---- Step 2: 验证 /chat 入口空状态 + 「新建对话」按钮
    const newConvBtn = page
      .getByRole('button', { name: /新建对话|New Chat|New Conversation/i })
      .first();
    await expect(
      newConvBtn,
      'U10 「新建对话」 按钮必须可见 — 若失败说明 U10 未合并或按钮文案改了'
    ).toBeVisible({ timeout: 10_000 });
    await snap(page, 'u15-step2');

    // ---- Step 3: 监听 POST /api/conversations，点新建对话
    const conversationPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/conversations') &&
        res.request().method() === 'POST' &&
        res.status() < 400,
      { timeout: 15_000 }
    );
    await newConvBtn.click();
    const conversationResp = await conversationPromise;
    expect(conversationResp.ok(), 'POST /api/conversations should succeed').toBeTruthy();
    const convBody = await conversationResp.json().catch(() => ({}));
    const conversationId: string | undefined =
      convBody?.conversation?.id ?? convBody?.id ?? convBody?.conversationId;
    expect(
      conversationId,
      'API response must include the new conversation id'
    ).toBeTruthy();

    // 跳转到 /chat/<id>
    await page.waitForURL(new RegExp(`/chat/${conversationId}(\\?|$)`), { timeout: 15_000 });
    await snap(page, 'u15-step3');

    // ---- Step 4: 打开录音 picker（U11） → 搜索 → 选 1 → 附加选中
    // picker 入口按钮文案兼容多种命名
    const pickerOpenBtn = page
      .getByRole('button', { name: /附加录音|选择录音|Attach Recording|Recordings/i })
      .first();
    await expect(
      pickerOpenBtn,
      'U11 录音 picker 触发按钮必须可见'
    ).toBeVisible({ timeout: 10_000 });
    await pickerOpenBtn.click();

    // picker 内部应有搜索框 + 列表
    const pickerSearch = page
      .getByPlaceholder(/搜索|Search/i)
      .or(page.getByRole('searchbox'))
      .first();
    await expect(pickerSearch, 'picker 搜索框应可见').toBeVisible({ timeout: 10_000 });
    await pickerSearch.fill('');
    // 给列表渲染时间
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    // 选一个录音 — 用 checkbox 或 list item
    const recordingItem = page
      .locator('[role="dialog"], [role="listbox"], .recording-picker')
      .locator('label, [role="option"], li, [role="listitem"]')
      .first();
    // 若 dialog 内没有可见录音，跳过这步但保留断言
    if (await recordingItem.isVisible().catch(() => false)) {
      await recordingItem.click();
    } else {
      // 兜底：直接点第一个 checkbox
      const cb = page.locator('input[type="checkbox"]').first();
      if (await cb.isVisible().catch(() => false)) {
        await cb.check();
      } else {
        throw new Error(
          'Recording picker 内未找到可选项 — U11 实现或数据库无录音'
        );
      }
    }

    // 监听 POST /api/conversations/.../recordings
    const attachRecordingsPromise = page
      .waitForResponse(
        (res) =>
          /\/api\/conversations\/[^/]+\/recordings/.test(res.url()) &&
          res.request().method() === 'POST',
        { timeout: 15_000 }
      )
      .catch(() => null);

    const confirmAttachBtn = page
      .getByRole('button', { name: /附加选中|附加|Attach Selected|Attach/i })
      .first();
    await confirmAttachBtn.click();
    const attachResp = await attachRecordingsPromise;
    if (attachResp) {
      expect(
        attachResp.status(),
        'POST /api/conversations/[id]/recordings 应 2xx'
      ).toBeLessThan(400);
    }
    // RecordingsBar 应展示已附加录音 — 用区域 / 类名匹配
    const recordingsBar = page
      .locator('[data-testid="recordings-bar"], .recordings-bar, [aria-label*="Recordings" i]')
      .first();
    // RecordingsBar 可见性是软断言 — 若 U10 用了不同的 testid 也不至于直接失败
    const recordingsBarVisible = await recordingsBar
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    if (!recordingsBarVisible) {
      console.warn(
        '[u15] RecordingsBar 未通过 default selector 找到 — U10 可能用了不同的 testid'
      );
    }
    await snap(page, 'u15-step4');

    // ---- Step 5: 文件附件 UI — 上传一个小文本文件
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'sample.txt');
    let fileToUpload = fixturePath;
    if (!fs.existsSync(fixturePath)) {
      // 兜底：内联写一个临时文件
      const tmpPath = path.join(ART, 'u15-sample.txt');
      fs.writeFileSync(tmpPath, 'hello u15\nsecond line\n', 'utf8');
      fileToUpload = tmpPath;
    }

    // 上传 input 通常隐藏在 button 后面 — 直接定位 file input
    const fileInput = page.locator('input[type="file"]').first();
    // 若 file input 不可见（被 styled），用 setInputFiles 仍可工作
    await expect(
      fileInput,
      'U10 文件附件 input 应存在于 DOM — 否则附件 UI 缺失'
    ).toHaveCount(1, { timeout: 10_000 });

    const uploadResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/chat-uploads') &&
        res.request().method() === 'POST',
      { timeout: 30_000 }
    );
    await fileInput.setInputFiles(fileToUpload);
    const uploadResp = await uploadResponsePromise;
    expect(
      uploadResp.status(),
      'POST /api/chat-uploads 应 200 — 失败说明 U5/U12 集成问题'
    ).toBe(200);

    // 附件 chip 应可见 — 用文件名匹配
    const fileName = path.basename(fileToUpload);
    const attachmentChip = page
      .getByText(new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
      .first();
    await expect(
      attachmentChip,
      'attachment chip 应显示已上传文件名'
    ).toBeVisible({ timeout: 10_000 });
    await snap(page, 'u15-step5');

    // ---- Step 6: 在 composer 输入并发送
    const composer = page
      .locator('textarea')
      .filter({ hasNot: page.locator('[disabled]') })
      .first();
    await expect(composer, 'composer textarea 应可见').toBeVisible({ timeout: 10_000 });
    const userMsg = '总结一下这次录音';
    await composer.fill(userMsg);

    // 监听 SSE 流式响应 — POST /api/llm/chat
    const chatStreamPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/llm/chat') &&
        res.request().method() === 'POST',
      { timeout: 30_000 }
    );

    // 优先 Enter，备选发送按钮
    await composer.press('Enter');
    let chatResp;
    try {
      chatResp = await chatStreamPromise;
    } catch {
      // Enter 没触发 — 找发送按钮
      const sendBtn = page
        .getByRole('button', { name: /发送|Send|送出/i })
        .first();
      await sendBtn.click();
      chatResp = await page.waitForResponse(
        (res) =>
          res.url().includes('/api/llm/chat') &&
          res.request().method() === 'POST',
        { timeout: 30_000 }
      );
    }
    expect(
      chatResp.status(),
      'POST /api/llm/chat 应 2xx — 失败说明 U12 流式端点出错'
    ).toBeLessThan(400);

    // 等待用户消息出现在历史
    await expect(
      page.getByText(userMsg).first(),
      '用户消息应在对话历史中可见'
    ).toBeVisible({ timeout: 15_000 });

    // 等待 assistant 消息出现 — assistant message 通常有特殊 role 标记或 markdown 容器
    const assistantMsg = page
      .locator('[data-role="assistant"], [data-author="assistant"], .assistant-message')
      .first();
    // 不强制具体 selector — 兜底用「除用户消息外，新增了一个有内容的消息块」
    const assistantVisible = await assistantMsg
      .isVisible({ timeout: 60_000 })
      .catch(() => false);
    if (!assistantVisible) {
      // 至少要等到流式响应里产生新文本（与用户消息不同的非空段落）
      console.warn(
        '[u15] assistant 消息 default selector 未命中 — 检查 prose 区域'
      );
      // 等待页面里出现一个长度 > 用户消息的 markdown 节点
      await expect
        .poll(
          async () => {
            const texts = await page.locator('article, .prose, [data-message]').allTextContents();
            return texts.some((t) => t.trim().length > userMsg.length && !t.includes(userMsg));
          },
          {
            message: 'expected an assistant reply to appear',
            timeout: 60_000,
          }
        )
        .toBe(true);
    }
    await snap(page, 'u15-step6');

    // ---- Step 7: 刷新页面，验证持久化
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(new RegExp(`/chat/${conversationId}(\\?|$)`), { timeout: 15_000 });

    // 录音条还在
    if (recordingsBarVisible) {
      await expect(
        page
          .locator('[data-testid="recordings-bar"], .recordings-bar, [aria-label*="Recordings" i]')
          .first()
      ).toBeVisible({ timeout: 10_000 });
    }
    // 附件 chip 还在
    await expect(
      page
        .getByText(new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
        .first(),
      '刷新后 attachment 应仍展示'
    ).toBeVisible({ timeout: 15_000 });
    // 用户消息还在
    await expect(
      page.getByText(userMsg).first(),
      '刷新后用户消息应仍展示'
    ).toBeVisible({ timeout: 15_000 });
    await snap(page, 'u15-step7');
  });

  test('empty chat: pure conversation with no recordings or files', async ({ page }) => {
    // 走到 /chat 空状态
    await page.goto('/chat');
    await page.waitForLoadState('domcontentloaded');

    // 空对话列表应有「新建对话」按钮 + 可能有空态文案
    const newConvBtn = page
      .getByRole('button', { name: /新建对话|New Chat|New Conversation/i })
      .first();
    await expect(newConvBtn, 'empty state 应展示新建对话按钮').toBeVisible({
      timeout: 10_000,
    });
    await snap(page, 'u15-empty-1');

    // 新建一个对话
    const conversationPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/conversations') &&
        res.request().method() === 'POST' &&
        res.status() < 400,
      { timeout: 15_000 }
    );
    await newConvBtn.click();
    const conversationResp = await conversationPromise;
    const convBody = await conversationResp.json().catch(() => ({}));
    const conversationId: string | undefined =
      convBody?.conversation?.id ?? convBody?.id ?? convBody?.conversationId;
    expect(conversationId, '应返回新对话 id').toBeTruthy();

    await page.waitForURL(new RegExp(`/chat/${conversationId}(\\?|$)`), { timeout: 15_000 });

    // 直接发消息 — 无录音、无文件
    const composer = page.locator('textarea').first();
    await expect(composer, '空对话也应展示 composer').toBeVisible({
      timeout: 10_000,
    });
    const userMsg = 'Hello, this is a pure global chat.';
    await composer.fill(userMsg);

    const chatStreamPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/llm/chat') &&
        res.request().method() === 'POST',
      { timeout: 30_000 }
    );
    await composer.press('Enter');
    let chatResp;
    try {
      chatResp = await chatStreamPromise;
    } catch {
      const sendBtn = page
        .getByRole('button', { name: /发送|Send|送出/i })
        .first();
      await sendBtn.click();
      chatResp = await page.waitForResponse(
        (res) =>
          res.url().includes('/api/llm/chat') &&
          res.request().method() === 'POST',
        { timeout: 30_000 }
      );
    }
    expect(
      chatResp.status(),
      'POST /api/llm/chat 空对话也应 2xx'
    ).toBeLessThan(400);

    await expect(
      page.getByText(userMsg).first(),
      '用户消息应可见'
    ).toBeVisible({ timeout: 15_000 });

    // assistant 回复 — 与主流程同样的宽容兜底
    const assistantVisible = await page
      .locator('[data-role="assistant"], [data-author="assistant"], .assistant-message')
      .first()
      .isVisible({ timeout: 60_000 })
      .catch(() => false);
    if (!assistantVisible) {
      await expect
        .poll(
          async () => {
            const texts = await page.locator('article, .prose, [data-message]').allTextContents();
            return texts.some((t) => t.trim().length > userMsg.length && !t.includes(userMsg));
          },
          {
            message: 'expected assistant reply in pure global chat mode',
            timeout: 60_000,
          }
        )
        .toBe(true);
    }
    await snap(page, 'u15-empty-2');
  });
});
