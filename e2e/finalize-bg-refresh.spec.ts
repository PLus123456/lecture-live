import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 收尾后台生成结果的自动刷新端到端：录音收尾后报告/标题由服务端后台 LLM 任务生成
 * （常见 30s~2min 才落库），回放页须轮询任务队列、任务结束原地刷新——不再要求手动刷新整页。
 *
 * 全靠 route mock（复用 audio-enhance.spec 的 harness 形状），用 background-tasks 的
 * GET 次数驱动「报告生成中 → 标题生成中 → 全部完成」三段式状态机。
 *
 * 红绿要点（关键断言）：
 *  1. ?finalized=1 落地时报告 tab 显示「生成中」而非「暂无报告/重新生成」——中和乐观态会转红。
 *  2. 报告任务离队后报告内容自动出现、标题任务离队后 h1 自动换成生成的标题，全程无整页刷新
 *     ——中和轮询刷新逻辑会转红。
 *  3. 队列始终无任务的旧会话不显示「生成中」，直接给「重新生成」入口——中和终止条件会转红。
 */

const SESSION_ID = 'bg-refresh-e2e';
const PLACEHOLDER_TITLE = '会话 7月12日 15:58';
const GENERATED_TITLE = 'Transformer 架构入门讲座';
const REPORT_TITLE = 'Transformer 入门讲座报告';

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
    featureFlags: {
      maxThinkingDepth: 'high',
      allowRealtimeSummary: true,
      allowFinalSummary: true,
      allowAudioEnhance: false,
    },
  },
};

const reportPayload = {
  significance: { score: 0.92, reason: 'informative lecture', isWorthSummarizing: true },
  report: {
    title: REPORT_TITLE,
    topic: 'Transformer 基础',
    participants: ['讲师'],
    date: '2026-07-12',
    duration: '10:00',
    overview: '介绍了自注意力机制与位置编码。',
    sections: [{ title: '自注意力', points: ['QKV 矩阵'] }],
    conclusions: ['注意力优于循环结构'],
    actionItems: [],
    keyTerms: {},
  },
  generatedAt: '2026-07-12T16:00:00.000Z',
};

async function loginThroughUi(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('alice@example.com');
  await page.locator('input[type="password"]').fill('Abcd1234');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

interface BgRefreshMockOptions {
  /**
   * background-tasks 每次 GET 返回的本会话在途任务序列（走完停在空集）。
   * 例：[['report_generation'], ['title_generation']] → 第1次报告在跑、第2次标题在跑、之后空。
   */
  jobPhases?: string[][];
  /** 报告何时可拉到：第 N 次 background-tasks GET 之后（0=一开始就有；Infinity=永远没有） */
  reportReadyAfterBgCalls?: number;
  /** 标题何时换成生成结果：第 N 次 background-tasks GET 之后 */
  titleReadyAfterBgCalls?: number;
  onBgTasksCall?: (n: number) => void;
}

function installBgRefreshMocks(page: Page, opts: BgRefreshMockOptions = {}) {
  const {
    // 报告任务停两拍：给「生成中」乐观态断言留出完整轮询窗口（5s/拍，同 audio-enhance 手法）
    jobPhases = [['report_generation'], ['report_generation'], ['title_generation']],
    reportReadyAfterBgCalls = 2,
    titleReadyAfterBgCalls = 3,
    onBgTasksCall,
  } = opts;

  let bgCalls = 0;
  // 门闩：/home 的 BackgroundTasksIndicator 也轮询 background-tasks，会在登录落地的几秒里
  // 把状态机的拍全部消耗掉。只有回放页拉过本会话详情（只有它会 GET /api/sessions/:id）后
  // 才开始走拍，此前一律返回空队列。
  let playbackReached = false;

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

    // ── 三段式状态机：background-tasks 的 GET 次数推进 报告/标题 的「生成完成」时点 ──
    if (p === '/api/user/background-tasks' && method === 'GET') {
      if (!playbackReached) {
        return fulfillJson(route, {
          jobs: [],
          finalizingSessions: [],
          asyncTranscribingSessions: [],
          hasActiveTasks: false,
          totalCount: 0,
        });
      }
      const phase = jobPhases[bgCalls] ?? [];
      bgCalls += 1;
      onBgTasksCall?.(bgCalls);
      const jobs = phase.map((type, i) => ({
        id: `job-${bgCalls}-${i}`,
        type,
        status: 'PROCESSING',
        sessionId: SESSION_ID,
        createdAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        sessionTitle: PLACEHOLDER_TITLE,
      }));
      return fulfillJson(route, {
        jobs,
        finalizingSessions: [],
        asyncTranscribingSessions: [],
        hasActiveTasks: jobs.length > 0,
        totalCount: jobs.length,
      });
    }

    if (p === '/api/llm/report' && method === 'GET') {
      return fulfillJson(route, {
        report: bgCalls >= reportReadyAfterBgCalls ? reportPayload : null,
      });
    }

    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      playbackReached = true;
      const titleReady = bgCalls >= titleReadyAfterBgCalls;
      return fulfillJson(route, {
        id: SESSION_ID,
        title: titleReady ? GENERATED_TITLE : PLACEHOLDER_TITLE,
        titleEn: titleReady ? 'Intro to Transformer Architecture' : null,
        titleAutoGenerated: !titleReady,
        status: 'COMPLETED',
        createdAt: new Date(0).toISOString(),
        durationMs: 600_000,
        sourceLang: 'en',
        targetLang: 'zh',
        recordingPath: `local:recordings/${SESSION_ID}.webm`,
        fullTranscribeStatus: null,
        fullTranscriptPath: null,
        audioEnhanceStatus: null,
        enhancedAudioPath: null,
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript` && method === 'GET') {
      return fulfillJson(route, { segments: [], summaries: [], translations: {} });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio` && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'audio/webm',
        body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/enhance-status` && method === 'GET') {
      return fulfillJson(route, {
        status: null,
        error: null,
        enhancedAudioReady: false,
        available: false,
      });
    }

    if (method === 'GET') return fulfillJson(route, {});
    return fulfillJson(route, { success: true });
  });
}

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);
});

test('收尾跳转：报告「生成中」→ 自动出报告 → 标题自动换成生成结果，全程无刷新', async ({
  page,
}) => {
  // 轮询 5s/拍 × 3 拍 + NAS 首编慢，放宽总时限并预热 playback 路由编译
  test.setTimeout(90_000);
  const warmup = page.request.get(`/session/${SESSION_ID}/playback`).catch(() => undefined);

  await installBgRefreshMocks(page);
  await loginThroughUi(page);
  await warmup;
  await page.goto(`/session/${SESSION_ID}/playback?finalized=1`);

  // 断言 1：落地即「报告生成中」乐观态（finalized=1），不给误导性的「重新生成」入口
  const generating = page.getByTestId('report-generating-bg');
  await expect(generating).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('report-regen-btn')).toHaveCount(0);
  // 标题此时仍是自动占位（页面有两个 h1：侧栏品牌 + 会话标题，按名字定位）
  await expect(page.getByRole('heading', { name: PLACEHOLDER_TITLE })).toBeVisible();

  // 断言 2：报告任务离队（第 2 拍）→ 报告内容自动出现
  await expect(page.getByText(REPORT_TITLE)).toBeVisible({ timeout: 25_000 });
  await expect(generating).toHaveCount(0);

  // 断言 3：标题任务离队（第 3 拍）→ h1 原地换成生成的标题（无整页刷新）
  await expect(page.getByRole('heading', { name: GENERATED_TITLE })).toBeVisible({
    timeout: 25_000,
  });
});

test('旧会话无在途任务：不显示「生成中」，直接给「重新生成」入口', async ({ page }) => {
  test.setTimeout(60_000);
  await installBgRefreshMocks(page, {
    jobPhases: [],
    reportReadyAfterBgCalls: Number.POSITIVE_INFINITY,
    titleReadyAfterBgCalls: Number.POSITIVE_INFINITY,
  });
  await loginThroughUi(page);
  // 无 finalized=1：不乐观点亮「生成中」
  await page.goto(`/session/${SESSION_ID}/playback`);

  await expect(page.getByTestId('report-regen-btn')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('report-generating-bg')).toHaveCount(0);
});

test('组禁用总摘要（只有标题任务）：生成中及时熄灭回落重新生成，标题仍自动刷新', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const warmup = page.request.get(`/session/${SESSION_ID}/playback`).catch(() => undefined);

  await installBgRefreshMocks(page, {
    jobPhases: [['title_generation']],
    reportReadyAfterBgCalls: Number.POSITIVE_INFINITY,
    titleReadyAfterBgCalls: 1,
  });
  await loginThroughUi(page);
  await warmup;
  await page.goto(`/session/${SESSION_ID}/playback?finalized=1`);

  // 第 1 拍：标题任务在跑而报告任务不在队列且拉不到报告 → 「生成中」熄灭，回落「重新生成」
  await expect(page.getByTestId('report-regen-btn')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('report-generating-bg')).toHaveCount(0);

  // 第 2 拍（队列空）：标题照常自动换成生成结果
  await expect(page.getByRole('heading', { name: GENERATED_TITLE })).toBeVisible({
    timeout: 25_000,
  });
});
