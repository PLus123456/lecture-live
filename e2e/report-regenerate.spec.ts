import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginViaForm } from './helpers';

/**
 * 回放页「报告」区：生成失败 / 缺失时的「重新生成报告」按钮端到端。
 *
 * 全靠 route mock，不连真库、不连 LLM；复用 full-transcribe.spec 的 harness
 * （installBrowserStubs + page.route('**\/api/**') + mock /api/auth/refresh 恢复会话）。
 *
 * 红绿要点：
 *  1. 报告缺失(GET report=null)或失败(report=null 但 isWorthSummarizing)时，按钮出现；
 *     成功态(report 有内容)时按钮不出现。
 *  2. 点击按钮 → POST /api/llm/report，之后 GET 返回真实报告 → 报告标题渲染。
 *     中和 POST 或「重新拉取」会转红。
 */

const SESSION_ID = 'report-e2e';

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
const REPORT_TITLE = 'REGENERATED lecture report';

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

/** 一份成功生成的完整报告（重新生成后 GET 返回）。 */
function successReport() {
  return {
    significance: { score: 0.9, reason: 'meaningful', isWorthSummarizing: true },
    report: {
      title: REPORT_TITLE,
      topic: 'e2e topic',
      participants: ['Speaker 1'],
      date: '1970-01-01',
      duration: '10m',
      overview: 'an overview sentence',
      sections: [{ title: 'Section A', points: ['point one'] }],
      conclusions: ['a conclusion'],
      actionItems: [],
      keyTerms: {},
    },
    generatedAt: new Date(0).toISOString(),
  };
}

/** report=null 但 isWorthSummarizing=true → 「报告生成失败」空态。 */
function failedReport() {
  return {
    significance: { score: 0.9, reason: 'meaningful', isWorthSummarizing: true },
    report: null,
    generatedAt: new Date(0).toISOString(),
  };
}

async function loginThroughUi(page: Page) {
  await loginViaForm(page, {
    email: 'alice@example.com',
    password: 'Abcd1234',
    prewarm: ['/session/prewarm/playback'],
  });
}

interface ReportMockOptions {
  /** 重新生成前 GET /api/llm/report 的初始形态：'empty'（无报告）| 'failed'（生成失败空态） */
  initialReport?: 'empty' | 'failed';
  /** 每次 POST /api/llm/report 回调（计数用） */
  onRegenerate?: () => void;
}

function installReportMocks(page: Page, opts: ReportMockOptions = {}) {
  const { initialReport = 'empty', onRegenerate } = opts;
  // POST 之后 GET 返回成功报告；之前按 initialReport 返回空/失败态。
  let regenerated = false;

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

    // ── 报告端点：GET 读取（随 regenerated 变化），POST 触发重新生成 ──
    if (p === '/api/llm/report' && method === 'POST') {
      onRegenerate?.();
      regenerated = true;
      return fulfillJson(route, {
        success: true,
        reportPath: 'local:reports/report-e2e.json',
        significance: successReport().significance,
        hasReport: true,
      });
    }
    if (p === '/api/llm/report' && method === 'GET') {
      if (regenerated) {
        return fulfillJson(route, { report: successReport() });
      }
      if (initialReport === 'failed') {
        return fulfillJson(route, { report: failedReport() });
      }
      return fulfillJson(route, { report: null });
    }

    // ── 会话元信息（已完成 + 有录音） ──
    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      return fulfillJson(route, {
        id: SESSION_ID,
        title: 'Report Regen E2E',
        status: 'COMPLETED',
        createdAt: new Date(0).toISOString(),
        durationMs: 600_000,
        sourceLang: 'en',
        targetLang: 'zh',
        recordingPath: 'local:recordings/report-e2e.webm',
        fullTranscribeStatus: null,
        fullTranscriptPath: null,
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript` && method === 'GET') {
      return fulfillJson(route, {
        segments: [liveSegment()],
        summaries: [],
        translations: {},
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio` && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'audio/webm',
        body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/full-transcribe-status` && method === 'GET') {
      return fulfillJson(route, { status: null, error: null, hasFullTranscript: false });
    }

    // 其余外围端点：宽松放行
    if (method === 'GET') return fulfillJson(route, {});
    return fulfillJson(route, { success: true });
  });
}

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);
});

test('报告缺失：显示「重新生成报告」→ 点击 → POST + 重新拉取 → 报告渲染', async ({
  page,
}) => {
  let regenCount = 0;
  await installReportMocks(page, { initialReport: 'empty', onRegenerate: () => (regenCount += 1) });
  await loginThroughUi(page);

  await page.goto(`/session/${SESSION_ID}/playback`);
  await expect(page.getByText(LIVE_TEXT)).toBeVisible({ timeout: 15_000 });

  // 报告为空 → 重新生成按钮出现
  const btn = page.getByTestId('report-regen-btn');
  await expect(btn).toBeVisible();
  expect(regenCount).toBe(0);

  // 点击 → POST 一次 → 重新拉取到成功报告 → 标题渲染
  await btn.click();
  await expect.poll(() => regenCount, { timeout: 10_000 }).toBe(1);
  await expect(page.getByText(REPORT_TITLE)).toBeVisible({ timeout: 10_000 });
  // 报告成功后按钮消失
  await expect(page.getByTestId('report-regen-btn')).toHaveCount(0);
});

test('报告生成失败态：显示「重新生成报告」→ 点击后成功渲染', async ({ page }) => {
  await installReportMocks(page, { initialReport: 'failed' });
  await loginThroughUi(page);

  await page.goto(`/session/${SESSION_ID}/playback`);
  await expect(page.getByText(LIVE_TEXT)).toBeVisible({ timeout: 15_000 });

  // 失败态（report=null 但值得摘要）→ 重新生成按钮出现
  const btn = page.getByTestId('report-regen-btn');
  await expect(btn).toBeVisible();

  await btn.click();
  await expect(page.getByText(REPORT_TITLE)).toBeVisible({ timeout: 10_000 });
});
