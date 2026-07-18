import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, loginViaForm } from './helpers';

/**
 * 断网续采端到端：录音中网络断开时，本地录音继续、只中断转录（审计后新增功能）。
 *
 * 用 window.__E2E_FAKE_SONIOX__ 接缝把 Soniox 转录连接换成可控假连接（配合 chromium 假麦克风
 * 让 archiveManager 真正录音、hasLiveCapture 为真），驱动到真实录音态后通过 __sonioxTest.error()
 * 模拟断网，断言：出现「转录暂停但录音继续」提示，且录制态保持 recording（未被暂停）。
 */

const SESSION_ID = 'offline-e2e';

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

async function loginThroughUi(page: Page) {
  await loginViaForm(page, {
    email: 'alice@example.com',
    password: 'Abcd1234',
    prewarm: ['/session/prewarm'],
  });
}

function installMocks(page: Page) {
  return page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
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
    if (p === '/api/sessions' && method === 'GET') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/soniox/ping') return fulfillJson(route, { ok: true });
    if (p === '/api/soniox/temporary-key') {
      return fulfillJson(route, {
        api_key: 'fake',
        ws_base_url: 'wss://fake',
        region: 'test',
      });
    }
    if (p === '/api/sessions/active-async') return fulfillJson(route, { items: [] });

    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      return fulfillJson(route, {
        id: SESSION_ID,
        title: 'Offline Capture E2E',
        status: 'CREATED',
        sourceLang: 'en',
        targetLang: 'zh',
      });
    }
    if (p === `/api/sessions/${SESSION_ID}` && method === 'PATCH') {
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript/draft`) {
      if (method === 'GET') return fulfillJson(route, { exists: false, payload: null });
      return fulfillJson(route, { success: true, segmentCount: 0, updatedAt: Date.now() });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio/draft` && method === 'GET') {
      return fulfillJson(route, { seqs: [] });
    }
    // 真实录音会持续上传音频分片 —— 一律成功
    if (p === `/api/sessions/${SESSION_ID}/audio/draft/chunks` && method === 'POST') {
      return fulfillJson(route, { success: true, seq: 0, chunkCount: 1 });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio/draft/finalize`) {
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${SESSION_ID}/finalize` && method === 'POST') {
      return fulfillJson(route, { success: true });
    }

    return fulfillJson(route, { error: `Unhandled ${method} ${p}` }, 500);
  });
}

test('断网续采：录音中网络断开，转录中断但录音继续（不暂停）', async ({ page }) => {
  // 启用 Soniox 测试接缝（真实 archiveManager + 假转录连接）
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__E2E_FAKE_SONIOX__ = true;
  });
  await installMocks(page);
  await loginThroughUi(page);

  await page.goto(`/session/${SESSION_ID}`);
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));

  // 开始录音（fresh CREATED 会话）
  const startButton = page.getByRole('button', { name: 'Start', exact: true }).first();
  await expect(startButton).toBeVisible({ timeout: 15_000 });
  await startButton.click();

  // 假转录连接就绪后显式驱动「连上」→ 进入录音态（出现「暂停」按钮）
  await page.waitForFunction(
    () => Boolean((window as unknown as { __sonioxTest?: unknown }).__sonioxTest),
    { timeout: 15_000 }
  );
  await page.evaluate(() =>
    (window as unknown as { __sonioxTest: { connect: () => void } }).__sonioxTest.connect()
  );
  const pauseButton = page.getByRole('button', { name: 'Pause', exact: true }).first();
  await expect(pauseButton).toBeVisible({ timeout: 15_000 });

  // 触发断网：假转录连接报错（此后不再驱动 connect，重连不会自动连上，提示得以保留）
  await page.evaluate(() =>
    (window as unknown as { __sonioxTest: { error: (m?: string) => void } }).__sonioxTest.error(
      'e2e disconnect'
    )
  );

  // 断言 1：出现「转录暂停但录音继续」提示
  await expect(
    page.getByText(/recording is still being saved/i)
  ).toBeVisible({ timeout: 10_000 });

  // 断言 2：录制态仍为 recording（「暂停」按钮仍在，而非被切成「继续」）——录音没有被暂停
  await expect(pauseButton).toBeVisible();
});
