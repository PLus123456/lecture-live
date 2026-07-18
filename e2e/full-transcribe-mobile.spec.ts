import type { Page, Route } from '@playwright/test';
import { devices, expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginViaForm } from './helpers';

/**
 * 完整版补全转录·移动端（阶段C）端到端：mobile 回放页（MobilePlaybackLayout）transcript tab
 * 「生成完整版转录」→ 收费确认弹窗 → 触发 → 状态轮询(pending→transcribing→completed) →
 * 「实时/完整版」切换查看。与 desktop full-transcribe.spec 同一套 route mock harness，
 * 仅布局分支不同（useIsMobile → MobilePlaybackLayout）。
 *
 * 红绿要点：确认前绝不 POST full-transcribe（收费确认不可跳过）；切到完整版后展示完整版文本、
 * 实时文本消失（displaySegments 切换生效）。
 */

// Pixel 5 设备：窄视口 + 移动 UA → useIsMobile 命中，渲染 MobilePlaybackLayout。
test.use({ ...devices['Pixel 5'] });

const SESSION_ID = 'full-mobile-e2e';
const LIVE_TEXT = 'hello from the live transcript';
const FULL_TEXT = 'FULL transcript sentence one';

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

function liveSegment() {
  return {
    id: 'live-1',
    sessionIndex: 0,
    speaker: '',
    language: 'en',
    text: LIVE_TEXT,
    globalStartMs: 0,
    globalEndMs: 5000,
    startMs: 0,
    endMs: 5000,
    isFinal: true,
    confidence: 1,
    timestamp: '00:00:00',
  };
}

function fullSegment() {
  return {
    id: 'full-1',
    sessionIndex: 0,
    speaker: '',
    language: 'en',
    text: FULL_TEXT,
    globalStartMs: 0,
    globalEndMs: 8000,
    startMs: 0,
    endMs: 8000,
    isFinal: true,
    confidence: 1,
    timestamp: '00:00:00',
  };
}

async function loginThroughUi(page: Page) {
  await loginViaForm(page, {
    email: 'alice@example.com',
    password: 'Abcd1234',
    prewarm: ['/session/prewarm/playback'],
  });
}

interface FullMockOptions {
  recordingPath?: string | null;
  onTrigger?: () => void;
}

function installFullTranscribeMocks(page: Page, opts: FullMockOptions = {}) {
  const { recordingPath = 'local:recordings/full-mobile-e2e.webm', onTrigger } = opts;

  const statusSequence = ['pending', 'transcribing', 'completed'];
  let statusIndex = 0;

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
    if (p === '/api/llm/models') return fulfillJson(route, { models: [] });
    if (p === '/api/llm/report') return fulfillJson(route, { report: null });

    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      return fulfillJson(route, {
        id: SESSION_ID,
        title: 'Full Transcribe Mobile E2E',
        status: 'COMPLETED',
        createdAt: new Date(0).toISOString(),
        durationMs: 600_000,
        sourceLang: 'en',
        targetLang: 'zh',
        recordingPath,
        fullTranscribeStatus: null,
        fullTranscriptPath: null,
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript` && method === 'GET') {
      return fulfillJson(route, { segments: [liveSegment()], summaries: [], translations: {} });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio` && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'audio/webm',
        body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      });
    }

    if (p === `/api/sessions/${SESSION_ID}/full-transcribe` && method === 'POST') {
      onTrigger?.();
      return fulfillJson(route, { status: 'pending', estimatedMinutes: 8 });
    }
    if (p === `/api/sessions/${SESSION_ID}/full-transcribe-status` && method === 'GET') {
      const status = statusSequence[Math.min(statusIndex, statusSequence.length - 1)];
      if (statusIndex < statusSequence.length - 1) statusIndex += 1;
      const completed = status === 'completed';
      return fulfillJson(route, {
        status,
        error: null,
        hasFullTranscript: completed,
        ...(completed ? { segmentCount: 1 } : {}),
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/full-transcript` && method === 'GET') {
      return fulfillJson(route, {
        segments: [fullSegment()],
        summaries: [],
        translations: {},
        hasFullTranscript: true,
      });
    }

    if (method === 'GET') return fulfillJson(route, {});
    return fulfillJson(route, { success: true });
  });
}

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);
});

test('移动端完整版转录：transcript tab → 收费确认 → 触发 → 轮询 → 切换查看', async ({
  page,
}) => {
  let triggerCount = 0;
  await installFullTranscribeMocks(page, { onTrigger: () => (triggerCount += 1) });
  await loginThroughUi(page);

  await page.goto(`/session/${SESSION_ID}/playback`);

  // 切到 transcript tab（移动端默认在 report tab）
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByText(LIVE_TEXT)).toBeVisible({ timeout: 15_000 });

  // 「生成完整版转录」按钮可见（会话已完成 + 有录音）
  const btn = page.getByTestId('full-transcribe-btn');
  await expect(btn).toBeVisible();

  // 点击 → 收费确认弹窗；关键：确认前绝不触发计费
  await btn.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('0.8');
  await expect(dialog).toContainText('8');
  expect(triggerCount).toBe(0);

  // 确认 → 触发 POST + 开始轮询
  await dialog.locator('button').last().click();
  await expect.poll(() => triggerCount, { timeout: 10_000 }).toBe(1);

  // 轮询走到 completed → 「实时/完整版」切换出现
  const viewFull = page.getByTestId('view-full');
  await expect(viewFull).toBeVisible({ timeout: 25_000 });

  // 切到完整版 → 展示完整版文本，实时文本消失
  await viewFull.click();
  await expect(page.getByText(FULL_TEXT)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(LIVE_TEXT)).toHaveCount(0);

  // 切回实时 → 实时文本回来
  await page.getByTestId('view-live').click();
  await expect(page.getByText(LIVE_TEXT)).toBeVisible();
});

test('移动端门控：会话无录音时不显示「生成完整版转录」按钮', async ({ page }) => {
  await installFullTranscribeMocks(page, { recordingPath: null });
  await loginThroughUi(page);
  await page.goto(`/session/${SESSION_ID}/playback`);

  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByText(LIVE_TEXT)).toBeVisible({ timeout: 15_000 });
  // 无 recordingPath → 按钮不渲染
  await expect(page.getByTestId('full-transcribe-btn')).toHaveCount(0);
});
