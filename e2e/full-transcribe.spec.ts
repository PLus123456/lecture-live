import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 完整版补全转录（阶段B）端到端：回放页「生成完整版转录」→ 收费确认弹窗 → 触发 → 状态轮询
 * (pending→transcribing→completed) → 「实时/完整版」切换查看。
 *
 * 全靠 route mock，不连真库、不连 Soniox；复用 recording-resilience 的 harness
 * （installBrowserStubs + page.route('**\/api/**') + mock /api/auth/refresh 恢复会话）。
 *
 * 红绿要点（关键断言）：
 *  1. 点击按钮后、确认前，绝不 POST full-transcribe（收费确认不可跳过）——中和确认弹窗会转红。
 *  2. 完整版就绪并切换后，展示的是完整版文本、实时文本消失——中和切换/读取会转红。
 */

const SESSION_ID = 'full-e2e';

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

const LIVE_TEXT = 'hello from the live transcript';
const FULL_TEXT = 'FULL transcript sentence one';

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
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('alice@example.com');
  await page.locator('input[type="password"]').fill('Abcd1234');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

interface FullMockOptions {
  /** GET /api/sessions/:id 的 recordingPath（null 用于测按钮门控） */
  recordingPath?: string | null;
  /** 触发端点返回的 HTTP 码（默认 200；402 用于额度不足路径） */
  triggerStatus?: number;
  /** 每次 POST full-transcribe 回调（计数用） */
  onTrigger?: () => void;
  /** full-transcribe-status 已被调用次数计数（可选） */
  onStatusPoll?: () => void;
}

function installFullTranscribeMocks(page: Page, opts: FullMockOptions = {}) {
  const {
    recordingPath = 'local:recordings/full-e2e.webm',
    triggerStatus = 200,
    onTrigger,
    onStatusPoll,
  } = opts;

  // 状态轮询序列：pending → transcribing → completed（幂等停在 completed）
  const statusSequence = ['pending', 'transcribing', 'completed'];
  let statusIndex = 0;

  return page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();

    // ── 平台/鉴权 ──
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
    // 整页导航到回放页后 token 不持久化，靠 refresh 从 cookie 恢复会话
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, {
        user: { id: 'user-1', email: 'alice@example.com', displayName: 'Alice', role: 'ADMIN' },
        token: '__cookie_session__',
      });
    }

    // ── 侧栏 / 外围（保持轻量） ──
    if (p === '/api/sessions' && url.searchParams.get('limit') === '50') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/soniox/ping') return fulfillJson(route, { ok: true });
    if (p === '/api/sessions/active-async') return fulfillJson(route, { items: [] });
    if (p === '/api/llm/models') return fulfillJson(route, { models: [] });
    if (p === '/api/llm/report') return fulfillJson(route, { report: null });

    // ── 会话元信息（已完成 + 有录音 + 完整版未触发） ──
    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      return fulfillJson(route, {
        id: SESSION_ID,
        title: 'Full Transcribe E2E',
        status: 'COMPLETED',
        createdAt: new Date(0).toISOString(),
        durationMs: 600_000, // 10 分钟 → 估算 ceil(10 × 0.8)=8 分钟
        sourceLang: 'en',
        targetLang: 'zh',
        recordingPath,
        fullTranscribeStatus: null,
        fullTranscriptPath: null,
      });
    }
    // 实时转录
    if (p === `/api/sessions/${SESSION_ID}/transcript` && method === 'GET') {
      return fulfillJson(route, {
        segments: [liveSegment()],
        summaries: [],
        translations: {},
      });
    }
    // 录音字节（回放页会 fetch → arrayBuffer；返回 webm magic，探测时长失败会走时长兜底）
    if (p === `/api/sessions/${SESSION_ID}/audio` && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'audio/webm',
        body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      });
    }

    // ── 完整版补全转录三端点 ──
    if (p === `/api/sessions/${SESSION_ID}/full-transcribe` && method === 'POST') {
      onTrigger?.();
      if (triggerStatus === 402) {
        return fulfillJson(
          route,
          { error: 'Insufficient transcription quota', estimatedMinutes: 8 },
          402
        );
      }
      return fulfillJson(route, { status: 'pending', estimatedMinutes: 8 });
    }
    if (p === `/api/sessions/${SESSION_ID}/full-transcribe-status` && method === 'GET') {
      onStatusPoll?.();
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

    // 其余外围端点：宽松放行，避免无关渲染请求 500 造成 flaky
    if (method === 'GET') return fulfillJson(route, {});
    return fulfillJson(route, { success: true });
  });
}

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);
});

test('回放页完整版转录：收费确认弹窗 → 触发 → 轮询 → 切换查看完整版', async ({
  page,
}) => {
  let triggerCount = 0;
  await installFullTranscribeMocks(page, { onTrigger: () => (triggerCount += 1) });
  await loginThroughUi(page);

  await page.goto(`/session/${SESSION_ID}/playback`);

  // 实时转录已展示
  await expect(page.getByText(LIVE_TEXT)).toBeVisible({ timeout: 15_000 });

  // 「生成完整版转录」按钮可见（会话已完成 + 有录音）
  const btn = page.getByTestId('full-transcribe-btn');
  await expect(btn).toBeVisible();

  // 点击 → 收费确认弹窗出现；关键：确认前绝不触发计费
  await btn.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // 弹窗清楚提示计费（倍率 0.8 + 估算 8 分钟）
  await expect(dialog).toContainText('0.8');
  await expect(dialog).toContainText('8');
  expect(triggerCount).toBe(0);

  // 确认（弹窗主按钮）→ 触发 POST + 开始轮询
  await dialog.locator('button').last().click();
  await expect.poll(() => triggerCount, { timeout: 10_000 }).toBe(1);

  // 轮询走到 completed → 「实时/完整版」切换出现
  const viewFull = page.getByTestId('view-full');
  await expect(viewFull).toBeVisible({ timeout: 25_000 });

  // 切到完整版 → 展示完整版文本，实时文本消失（displaySegments 切换生效）
  await viewFull.click();
  await expect(page.getByText(FULL_TEXT)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(LIVE_TEXT)).toHaveCount(0);

  // 切回实时 → 实时文本回来
  await page.getByTestId('view-live').click();
  await expect(page.getByText(LIVE_TEXT)).toBeVisible();
});

test('额度不足(402)：确认后提示额度不足，不进入完整版切换', async ({ page }) => {
  await installFullTranscribeMocks(page, { triggerStatus: 402 });
  await loginThroughUi(page);
  await page.goto(`/session/${SESSION_ID}/playback`);

  await expect(page.getByText(LIVE_TEXT)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('full-transcribe-btn').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('button').last().click();

  // 402：不出现完整版切换（未进入 completed）
  await expect(page.getByTestId('view-full')).toHaveCount(0);
  // 仍停留在实时转录
  await expect(page.getByText(LIVE_TEXT)).toBeVisible();
});

test('门控：会话无录音时不显示「生成完整版转录」按钮', async ({ page }) => {
  await installFullTranscribeMocks(page, { recordingPath: null });
  await loginThroughUi(page);
  await page.goto(`/session/${SESSION_ID}/playback`);

  await expect(page.getByText(LIVE_TEXT)).toBeVisible({ timeout: 15_000 });
  // 无 recordingPath → 按钮不渲染
  await expect(page.getByTestId('full-transcribe-btn')).toHaveCount(0);
});
