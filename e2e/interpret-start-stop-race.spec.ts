import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginAsAdmin } from './helpers';

/**
 * 同传（/interpret）启动竞态 —— H3 的端到端守卫。
 *
 * 背景（BUG_AUDIT_ox-alpha_2026-08-22 H3）：`useInterpret.start()` 里有两个 await 窗口，
 * 而当时全文件**没有任何代次（generation）机制**：
 *   窗口①：`await fetch('/api/interpret/start')`（建服务端计费锚点）
 *   窗口②：`await startSonioxRecording(...)`（mint key + WS 握手）
 * 用户在窗口内点「停止」时，`stop()` 读到 `recordingRef.current === null` 于是句柄相关
 * 全部 no-op —— 却照常结算扣费、把 UI 置成已停止；随后 start 的尾段**无条件**继续跑：
 * 窗口①下会重新 `setIsRunning(true)`（UI 假复活）并建出一个永不清理的 setInterval；
 * 窗口②下会发布麦克风 + Soniox WS 句柄，成为**永不再计费**的孤儿，`scheduleRotation`
 * 还会在 stop 清空 rotationTimerRef 之后重新排上定时器，让孤儿每 ~15 分钟自我重建。
 *
 * 本 spec 只钉住 e2e 层真正看得见的那一半（窗口①）：**停止之后 UI 不许自己活过来、
 * 计时器不许继续走**。窗口②的句柄拆除属进程内不可见状态，由
 * `src/hooks/__tests__/useInterpret.startStopRace.test.tsx` 的代次门闩用例覆盖。
 *
 * harness 说明：全量 route mock、无真实 DB；Soniox 走 `__E2E_FAKE_SONIOX__` 假连接接缝
 * （src/lib/soniox/client.ts），不连真实 wss。
 */

const adminUser = {
  id: 'admin-1',
  email: 'admin@lecturelive.com',
  displayName: 'Admin',
  role: 'ADMIN',
};

const quota = {
  id: 'admin-1',
  role: 'ADMIN',
  transcriptionMinutesUsed: 0,
  transcriptionMinutesLimit: 999999,
  remainingTranscriptionMinutes: 999999,
  remainingTranscriptionMs: 999999 * 60_000,
  purchasedMinutesBalance: 0,
  storageHoursUsed: 0,
  storageHoursLimit: 999999,
  storageBytesUsed: 0,
  storageBytesLimit: 1_000_000_000,
  remainingStorageBytes: 1_000_000_000,
  allowedModels: '*',
  quotaResetAt: null,
};

/** 由每个用例改写：`/api/interpret/start` 在这个 promise resolve 之前不返回。 */
let releaseAnchor: (() => void) | null = null;
let anchorGate: Promise<void> | null = null;
let deductCalls: Array<Record<string, unknown>> = [];
let anchorCalls = 0;

async function setupInterpretRoutes(page: Page) {
  deductCalls = [];
  anchorCalls = 0;
  await installBrowserStubs(page);

  // Soniox 假连接：不连真实 wss，连接/断网/token 全由 window.__sonioxTest 驱动。
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__E2E_FAKE_SONIOX__ = true;
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, { site_name: 'LectureLive QA', allow_registration: true });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    if (p === '/api/users/quota') return fulfillJson(route, { quotas: quota });
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') return fulfillJson(route, { items: [], nextCursor: null });

    // 计费锚点：可被测试卡住，制造 H3 窗口①
    if (p === '/api/interpret/start' && method === 'POST') {
      anchorCalls += 1;
      if (anchorGate) await anchorGate;
      return fulfillJson(route, { anchorId: 'anchor-e2e-1' });
    }
    if (p === '/api/interpret/deduct' && method === 'POST') {
      deductCalls.push((request.postDataJSON() as Record<string, unknown>) ?? {});
      return fulfillJson(route, { quotas: quota });
    }

    return fulfillJson(route, {});
  });
}

function startButton(page: Page) {
  return page.getByRole('button', { name: /^(Start|开始)$/ });
}
function stopButton(page: Page) {
  return page.getByRole('button', { name: /^(Stop|停止)$/ });
}

test.beforeEach(async ({ page }) => {
  anchorGate = null;
  releaseAnchor = null;
  await setupInterpretRoutes(page);
  await loginAsAdmin(page, { prewarm: ['/interpret'] });
  await page.goto('/interpret');
});

test('H3 窗口①：建锚点期间离开页面 → 抢建出来的锚点必须被结算，UI 不得假复活', async ({
  page,
}) => {
  anchorGate = new Promise<void>((resolve) => {
    releaseAnchor = resolve;
  });

  const start = startButton(page).first();
  await expect(start).toBeVisible({ timeout: 15_000 });
  await start.click();

  // 锚点 fetch 被卡住 —— start() 此刻停在窗口① 的 await 上。
  // 注意：窗口①里 `setIsRunning(true)` **还没执行**，所以此时页面上根本没有「停止」键，
  // 用户能做的是「离开」。这正是审计写的第二个触发路径（启动过程中导航离开 /interpret）。
  await expect.poll(() => anchorCalls, { timeout: 15_000 }).toBe(1);
  await expect(stopButton(page)).toHaveCount(0);

  // 用侧边栏链接做 **SPA 导航**（不是 page.goto —— 整页导航会连 JS 上下文一起干掉，
  // 那样就测不到「组件已卸载、在途 start 尾段仍在跑」这个真实形态了）。
  await page.getByRole('link', { name: /^(Home|首页)$/ }).first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });

  // 放行锚点请求：start() 的尾段现在才开始跑，而组件已经卸载 —— bug 的触发点。
  releaseAnchor?.();

  // 断言一：被抢建出来的服务端计费锚点必须被结算掉。
  // 修复前：stop/卸载读到 recordingRef=null 全部 no-op，锚点留在服务端既不计费也不释放，
  // 只能等 cron 兜底；同时 setIsRunning(true) 与 setInterval 在卸载后照常执行。
  await expect
    .poll(() => deductCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(deductCalls.at(-1)?.anchorId).toBe('anchor-e2e-1');

  // 断言二：回到同传页必须是干净的停止态（没有被卸载后跑完的尾段留下运行态残留）。
  await page.getByRole('link', { name: /^(Interpret|同传)$/ }).first().click();
  await page.waitForURL(/\/interpret(\?|$)/, { timeout: 30_000 });
  await expect(startButton(page).first()).toBeVisible({ timeout: 15_000 });
  await expect(stopButton(page)).toHaveCount(0);
  await expect(page.getByText(/^\d{2}:\d{2}$/)).toHaveCount(0);
});

// 正向对照：防止守卫写得过紧，把正常的一场同传也挡掉。
test('正向对照：正常开始 → 停止，一场同传完整跑通且只结算一次', async ({ page }) => {
  const start = startButton(page).first();
  await expect(start).toBeVisible({ timeout: 15_000 });
  await start.click();

  // 正常路径：锚点不卡，UI 必须进入运行态
  const stop = stopButton(page).first();
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => anchorCalls, { timeout: 10_000 }).toBe(1);

  await stop.click();

  await expect(startButton(page).first()).toBeVisible({ timeout: 15_000 });
  await expect(stopButton(page)).toHaveCount(0);

  // 恰好结算一次（stop 的 isStoppingRef 重入锁 + 代次门闩都不该导致重复或漏结算）
  await expect.poll(() => deductCalls.length, { timeout: 10_000 }).toBe(1);
});
