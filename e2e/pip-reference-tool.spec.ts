import type { Page, Route } from '@playwright/test';
import { devices, expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 画中画参考工具端到端：用 addInitScript 桩掉各家 PiP API 模拟浏览器形态，
 * 验证三级策略（Document PiP > Video PiP > 页内悬浮面板）的降级与回退。
 *
 * 覆盖的回归点（对应 2026-07-12 PiP 大修）：
 * 1. 无任何 PiP API（Firefox 形态）→ 直接 inline，面板可关闭
 * 2. Document PiP 打开失败（Chrome 形态）→ 回退 inline
 * 3. webkit 前缀 API 静默失败（iOS 低电量/无帧形态）→ 验证轮询超时 → 回退 inline
 *    （修复前 fire-and-forget 被当成功：用户点了按钮什么都不发生，也不回退）
 * 4. webkit 成功进入 video-pip；系统级关闭必须复位状态且可再次打开
 *    （修复前系统关闭不走 stopRenderLoop，60fps 渲染循环跑到页面卸载）
 * 5. ctx.roundRect 缺失（Safari ≤15 形态）：预热不许把会话页打崩（修复前 mount 即抛）
 * 6. 移动端小视口：inline 面板整体落在视口内、关闭按钮可达
 *    （修复前固定 420×320 + 初始 x 可为负，iPhone 上出屏摸不到关闭键）
 */

const SESSION_ID = 'pip-e2e';
const SEED_TEXT = 'hello world from before refresh';
const PIP_BUTTON_TITLE = 'Picture-in-Picture Translation Window';

const quotaPayload = {
  quotas: {
    id: 'user-1',
    role: 'ADMIN',
    transcriptionMinutesUsed: 0,
    transcriptionMinutesLimit: 999999,
    remainingTranscriptionMinutes: 999999,
    remainingTranscriptionMs: 999999 * 60_000,
    storageHoursUsed: 0,
    storageHoursLimit: 999999,
    allowedModels: 'local,claude',
    quotaResetAt: null,
  },
};

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);
});

async function loginThroughUi(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('alice@example.com');
  await page.locator('input[type="password"]').fill('Abcd1234');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

// 预置 zustand persist 的转录 store 快照（暂停态 + 一段已完成转录），
// 让 PiP 面板里有可断言的真实内容
async function seedRecordingSnapshot(page: Page) {
  await page.addInitScript(() => {
    const startTime = Date.now() - 60_000;
    const snapshot = {
      state: {
        segments: [
          {
            id: 'seg-1',
            sessionIndex: 0,
            speaker: '',
            language: 'en',
            text: 'hello world from before refresh',
            globalStartMs: 0,
            globalEndMs: 1000,
            startMs: 0,
            endMs: 1000,
            isFinal: true,
            confidence: 1,
            timestamp: '00:00:00',
          },
        ],
        currentPreview: '',
        currentPreviewTranslation: '',
        currentPreviewText: { finalText: '', nonFinalText: '' },
        currentPreviewTranslationText: {
          finalText: '',
          nonFinalText: '',
          state: 'idle',
          sourceLanguage: null,
        },
        recordingState: 'paused',
        recordingStartTime: startTime,
        pausedAt: startTime + 60_000,
        totalPausedMs: 0,
        totalDurationMs: 60_000,
        currentSessionIndex: 0,
      },
      version: 0,
    };
    window.sessionStorage.setItem(
      'lecture-live-transcript',
      JSON.stringify(snapshot)
    );
  });
}

// 会话页 API mock（与 recording-resilience 同一套 harness 的裁剪版）
function installSessionApiMocks(page: Page) {
  return page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: '',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, {
        user: { id: 'user-1', email: 'alice@example.com', displayName: 'Alice', role: 'ADMIN' },
        token: '__cookie_session__',
      });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, {
        user: { id: 'user-1', email: 'alice@example.com', displayName: 'Alice', role: 'ADMIN' },
        token: '__cookie_session__',
      });
    }
    if (p === '/api/sessions' && url.searchParams.get('limit') === '50') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/soniox/ping') return fulfillJson(route, { ok: true });
    if (p === '/api/sessions/active-async') return fulfillJson(route, { items: [] });

    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      return fulfillJson(route, {
        id: SESSION_ID,
        title: 'PiP E2E',
        status: 'PAUSED',
        sourceLang: 'en',
        targetLang: 'zh',
      });
    }
    if (p === `/api/sessions/${SESSION_ID}` && method === 'PATCH') {
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript/draft`) {
      if (method === 'GET') {
        return fulfillJson(route, { exists: false, payload: null });
      }
      return fulfillJson(route, { success: true, segmentCount: 1, updatedAt: Date.now() });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio/draft` && method === 'GET') {
      return fulfillJson(route, { seqs: [] });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio/draft/finalize`) {
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${SESSION_ID}/finalize` && method === 'POST') {
      return fulfillJson(route, { success: true });
    }
    if (p === '/api/soniox/temporary-key') {
      return fulfillJson(route, { error: 'disabled in e2e' }, 503);
    }

    return fulfillJson(route, { error: `Unhandled ${method} ${p}` }, 500);
  });
}

interface PipApiShape {
  documentPip?: 'absent' | 'reject';
  standardVideoPip?: 'absent' | 'reject';
  webkitVideoPip?: 'silent-fail' | 'working';
  captureStream?: 'absent';
  roundRect?: 'absent';
}

/**
 * 按目标浏览器形态桩掉/改写 PiP 相关 API。
 * 必须在页面脚本执行前注入（addInitScript），否则策略判定读到 chromium 原生 API。
 */
function shapePipApis(page: Page, shape: PipApiShape) {
  return page.addInitScript((s) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const videoProto = HTMLVideoElement.prototype as any;
    const docProto = Document.prototype as any;

    if (s.documentPip === 'absent') {
      Object.defineProperty(window, 'documentPictureInPicture', {
        value: undefined,
        configurable: true,
      });
    } else if (s.documentPip === 'reject') {
      Object.defineProperty(window, 'documentPictureInPicture', {
        value: { requestWindow: () => Promise.reject(new Error('denied by test')) },
        configurable: true,
      });
    }

    if (s.standardVideoPip === 'absent') {
      delete videoProto.requestPictureInPicture;
      delete docProto.exitPictureInPicture;
    } else if (s.standardVideoPip === 'reject') {
      videoProto.requestPictureInPicture = function () {
        return Promise.reject(new DOMException('denied by test', 'NotAllowedError'));
      };
    }

    if (s.webkitVideoPip === 'silent-fail') {
      // 复刻 iOS 真实行为：fire-and-forget，失败时既不 throw 也不改 presentationMode
      videoProto.webkitSetPresentationMode = function () { /* 静默失败 */ };
      Object.defineProperty(videoProto, 'webkitPresentationMode', {
        configurable: true,
        get() { return 'inline'; },
      });
      docProto.webkitExitPictureInPicture = () => {};
    } else if (s.webkitVideoPip === 'working') {
      videoProto.webkitSetPresentationMode = function (mode: string) {
        this.__pipMode = mode;
        this.dispatchEvent(new Event('webkitpresentationmodechanged'));
      };
      Object.defineProperty(videoProto, 'webkitPresentationMode', {
        configurable: true,
        get() { return this.__pipMode ?? 'inline'; },
      });
      docProto.webkitExitPictureInPicture = () => {};
    }

    if (s.captureStream === 'absent') {
      delete (HTMLCanvasElement.prototype as any).captureStream;
    }
    if (s.roundRect === 'absent') {
      delete (CanvasRenderingContext2D.prototype as any).roundRect;
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, shape);
}

async function openSessionPage(page: Page) {
  await installSessionApiMocks(page);
  await loginThroughUi(page);
  await seedRecordingSnapshot(page);
  await page.goto(`/session/${SESSION_ID}`);
  await expect(page.getByTitle(PIP_BUTTON_TITLE)).toBeVisible({ timeout: 15_000 });
}

test('无任何 PiP API（Firefox 形态）：直接落页内悬浮面板，内容可见且可关闭', async ({ page }) => {
  await shapePipApis(page, {
    documentPip: 'absent',
    standardVideoPip: 'absent',
    captureStream: 'absent',
  });
  await openSessionPage(page);

  await page.getByTitle(PIP_BUTTON_TITLE).click();
  const panel = page.locator('.pip-inline-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(SEED_TEXT);

  // 面板整体在视口内
  const viewport = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

  await panel.getByTitle('Close').click();
  await expect(panel).toHaveCount(0);
});

test('Document PiP 打开失败（Chrome 形态）：回退页内悬浮面板', async ({ page }) => {
  await shapePipApis(page, {
    documentPip: 'reject',
    standardVideoPip: 'absent',
  });
  await openSessionPage(page);

  await page.getByTitle(PIP_BUTTON_TITLE).click();
  await expect(page.locator('.pip-inline-panel')).toBeVisible({ timeout: 10_000 });
});

test('webkit PiP 静默失败（iOS 形态）：验证轮询超时后回退 inline，而非假装成功', async ({ page }) => {
  await shapePipApis(page, {
    documentPip: 'absent',
    standardVideoPip: 'absent',
    webkitVideoPip: 'silent-fail',
  });
  await openSessionPage(page);

  await page.getByTitle(PIP_BUTTON_TITLE).click();
  // 首次尝试 1.5s 轮询 + 重试 1.5s，之后必须出现 inline 兜底
  await expect(page.locator('.pip-inline-panel')).toBeVisible({ timeout: 15_000 });
});

test('webkit PiP 成功进入 video-pip：系统级关闭复位状态，且可再次打开', async ({ page }) => {
  await shapePipApis(page, {
    documentPip: 'absent',
    standardVideoPip: 'absent',
    webkitVideoPip: 'working',
  });
  await openSessionPage(page);

  const pipButton = page.getByTitle(PIP_BUTTON_TITLE);
  await pipButton.click();

  // 进入 video-pip：按钮翻成 Close PiP，且没有 inline 面板
  await expect(pipButton).toContainText('Close PiP');
  await expect(page.locator('.pip-inline-panel')).toHaveCount(0);

  // 模拟系统级关闭（PiP 窗口自带的 X）：presentationMode 回 inline
  await page.evaluate(() => {
    document.querySelectorAll('video').forEach((v) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v as any).webkitSetPresentationMode('inline');
    });
  });
  await expect(pipButton).not.toContainText('Close PiP');

  // 再次打开：close 后保留的 captureStream 可复用，重新进入不需要冷启动
  await pipButton.click();
  await expect(pipButton).toContainText('Close PiP');
});

test('Safari ≤15 形态（无 ctx.roundRect）：会话页不崩，PiP 点击后回退 inline', async ({ page }) => {
  await shapePipApis(page, {
    documentPip: 'absent',
    standardVideoPip: 'reject', // API 存在（触发预热）但打开被拒
    roundRect: 'absent',
  });
  // 修复前：video-pip 预热在 mount 时调 ctx.roundRect 抛 TypeError，整个会话页崩掉，
  // 下面这行的 PiP 按钮可见断言就到不了
  await openSessionPage(page);

  await page.getByTitle(PIP_BUTTON_TITLE).click();
  await expect(page.locator('.pip-inline-panel')).toBeVisible({ timeout: 15_000 });
});

test.describe('移动端小视口（Pixel 5）', () => {
  // 不能整包 spread devices['Pixel 5']：defaultBrowserType 在 describe 级 use 里非法
  test.use({
    viewport: devices['Pixel 5'].viewport,
    userAgent: devices['Pixel 5'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('inline 面板收缩进视口、关闭按钮可达', async ({ page }) => {
    await shapePipApis(page, {
      documentPip: 'absent',
      standardVideoPip: 'absent',
      captureStream: 'absent',
    });
    await installSessionApiMocks(page);
    await loginThroughUi(page);
    await seedRecordingSnapshot(page);
    await page.goto(`/session/${SESSION_ID}`);

    // 移动端从「更多操作」抽屉打开 PiP
    await page.getByRole('button', { name: 'More actions' }).click({ timeout: 15_000 });
    await page.getByRole('button', { name: /Open PiP/ }).click();

    const panel = page.locator('.pip-inline-panel');
    await expect(panel).toBeVisible();

    // 修复前：固定 420×320、初始 x = 393-420-24 < 0，面板出屏、关闭按钮不可达
    const viewport = page.viewportSize()!;
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

    await panel.getByTitle('Close').click();
    await expect(panel).toHaveCount(0);
  });
});
