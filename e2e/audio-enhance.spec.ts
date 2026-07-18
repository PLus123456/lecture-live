import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginViaForm } from './helpers';

/**
 * 录音音频增强端到端：回放页「音频增强」→ 触发 → 状态轮询（pending→processing→completed）
 * → 「原声/增强」音源切换（增强请求带 ?variant=enhanced）；以及 admin 设置页的
 * 音频增强 tab（Worker 配置 + 测试连接）。
 *
 * 全靠 route mock（复用 full-transcribe.spec 的 harness 形状），不连真库、不连 worker。
 *
 * 红绿要点（关键断言）：
 *  1. 切到「增强」后音频请求必须带 variant=enhanced——中和 audio 路由的 variant 分支会转红。
 *  2. 组未开通（available=false）时触发按钮绝不出现——中和门禁会转红。
 */

const SESSION_ID = 'enhance-e2e';

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
      allowAudioEnhance: true,
    },
  },
};

async function loginThroughUi(page: Page) {
  await loginViaForm(page, {
    email: 'alice@example.com',
    password: 'Abcd1234',
    prewarm: ['/session/prewarm/playback'],
  });
}

interface EnhanceMockOptions {
  /** 会话初始增强状态（null=从未触发） */
  initialStatus?: string | null;
  /** 会话初始增强产物路径（非空=已就绪） */
  initialEnhancedPath?: string | null;
  /** enhance-status 返回的 available（组能力门禁） */
  available?: boolean;
  /** 触发后的轮询状态序列（每次 GET 前进一格，停在末位） */
  statusSequence?: string[];
  /** POST enhance-audio 计数 */
  onTrigger?: () => void;
  /** 音频请求回调（携带 variant 参数值） */
  onAudioRequest?: (variant: string | null) => void;
}

function installEnhanceMocks(page: Page, opts: EnhanceMockOptions = {}) {
  const {
    initialStatus = null,
    initialEnhancedPath = null,
    available = true,
    // processing 停两拍：给「处理中… 55%」断言留出完整的轮询窗口（5s/拍）
    statusSequence = ['processing', 'processing', 'completed'],
    onTrigger,
    onAudioRequest,
  } = opts;

  let triggered = false;
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
        title: 'Audio Enhance E2E',
        status: 'COMPLETED',
        createdAt: new Date(0).toISOString(),
        durationMs: 600_000,
        sourceLang: 'en',
        targetLang: 'zh',
        recordingPath: `local:recordings/${SESSION_ID}.webm`,
        fullTranscribeStatus: null,
        fullTranscriptPath: null,
        audioEnhanceStatus: initialStatus,
        enhancedAudioPath: initialEnhancedPath,
      });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript` && method === 'GET') {
      return fulfillJson(route, { segments: [], summaries: [], translations: {} });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio` && method === 'GET') {
      onAudioRequest?.(url.searchParams.get('variant'));
      return route.fulfill({
        status: 200,
        contentType: url.searchParams.get('variant') === 'enhanced' ? 'audio/mp4' : 'audio/webm',
        body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      });
    }

    // ── 音频增强两端点 ──
    if (p === `/api/sessions/${SESSION_ID}/enhance-audio` && method === 'POST') {
      onTrigger?.();
      triggered = true;
      statusIndex = 0;
      return fulfillJson(route, { status: 'pending', jobId: 'job-e2e' });
    }
    if (p === `/api/sessions/${SESSION_ID}/enhance-status` && method === 'GET') {
      if (!triggered) {
        return fulfillJson(route, {
          status: initialStatus,
          error: null,
          enhancedAudioReady: Boolean(initialEnhancedPath),
          available,
        });
      }
      const status = statusSequence[Math.min(statusIndex, statusSequence.length - 1)];
      if (statusIndex < statusSequence.length - 1) statusIndex += 1;
      return fulfillJson(route, {
        status,
        error: status === 'failed' ? 'worker exploded' : null,
        enhancedAudioReady: status === 'completed',
        available,
        // 进度透传：处理中时回报 worker 实时百分比（前端应显示"处理中… 55%"）
        workerStage: status === 'processing' ? 'denoise' : null,
        workerProgress: status === 'processing' ? 55 : null,
      });
    }

    if (method === 'GET') return fulfillJson(route, {});
    return fulfillJson(route, { success: true });
  });
}

test.beforeEach(async ({ page }) => {
  await installBrowserStubs(page);
});

test('手动触发：按钮 → POST → 处理中 → 完成后出现音源切换，切增强请求带 variant', async ({
  page,
}) => {
  let triggerCount = 0;
  const audioVariants: Array<string | null> = [];
  await installEnhanceMocks(page, {
    onTrigger: () => {
      triggerCount += 1;
    },
    onAudioRequest: (variant) => {
      audioVariants.push(variant);
    },
  });
  await loginThroughUi(page);
  await page.goto(`/session/${SESSION_ID}/playback`);

  // 初始：触发按钮可见（available=true 且未生成过）
  const enhanceBtn = page.getByTestId('enhance-audio-btn');
  await expect(enhanceBtn).toBeVisible({ timeout: 10_000 });
  // 初始音频加载走原声（无 variant）
  expect(audioVariants.every((v) => v !== 'enhanced')).toBe(true);

  // 点击触发 → POST 恰好一次 → 进入处理中态（含 worker 透传的实时进度百分比）
  await enhanceBtn.click();
  const processing = page.getByTestId('enhance-processing');
  await expect(processing).toBeVisible({ timeout: 10_000 });
  expect(triggerCount).toBe(1);
  await expect(processing).toContainText('55%', { timeout: 10_000 });

  // 轮询推进到 completed → 「原声/增强」切换出现（轮询间隔 5s×3 拍，放宽等待）
  const enhancedTab = page.getByTestId('audio-enhanced');
  await expect(enhancedTab).toBeVisible({ timeout: 25_000 });

  // 切到增强 → 音频重新加载且带 variant=enhanced
  await enhancedTab.click();
  await expect
    .poll(() => audioVariants.includes('enhanced'), { timeout: 10_000 })
    .toBe(true);
  await expect(enhancedTab).toHaveAttribute('aria-selected', 'true');
});

test('增强版已就绪：默认播增强（首个音频请求即带 variant），可切回原声', async ({
  page,
}) => {
  const audioVariants: Array<string | null> = [];
  await installEnhanceMocks(page, {
    initialStatus: 'completed',
    initialEnhancedPath: `/user-1/recordings/${SESSION_ID}-enh.mp4`,
    onAudioRequest: (variant) => {
      audioVariants.push(variant);
    },
  });
  await loginThroughUi(page);
  await page.goto(`/session/${SESSION_ID}/playback`);

  // 切换控件可见且「增强」被选中
  const enhancedTab = page.getByTestId('audio-enhanced');
  await expect(enhancedTab).toBeVisible({ timeout: 10_000 });
  await expect(enhancedTab).toHaveAttribute('aria-selected', 'true');

  // 首个音频请求就是增强版（没有先下载原声的浪费）
  await expect
    .poll(() => audioVariants.length > 0, { timeout: 10_000 })
    .toBe(true);
  expect(audioVariants[0]).toBe('enhanced');

  // 切回原声 → 新请求不带 variant
  await page.getByTestId('audio-original').click();
  await expect
    .poll(() => audioVariants.some((v) => v === null), { timeout: 10_000 })
    .toBe(true);
});

test('组未开通（available=false）：触发按钮不出现', async ({ page }) => {
  await installEnhanceMocks(page, { available: false });
  await loginThroughUi(page);
  await page.goto(`/session/${SESSION_ID}/playback`);

  // 用完整版转录按钮作为「页面就绪」信标，再断言增强按钮不存在
  await expect(page.getByTestId('full-transcribe-btn')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('enhance-audio-btn')).toHaveCount(0);
  await expect(page.getByTestId('audio-enhanced')).toHaveCount(0);
});

test('admin 设置：音频增强 tab 渲染配置项，测试连接展示 worker 探测结果', async ({
  page,
}) => {
  let verifyCount = 0;
  await page.route('**/api/**', async (route: Route) => {
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
        user: { id: 'admin-1', email: 'admin@lecturelive.com', displayName: 'Admin', role: 'ADMIN' },
        token: '__cookie_session__',
      });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, {
        user: { id: 'admin-1', email: 'admin@lecturelive.com', displayName: 'Admin', role: 'ADMIN' },
        token: '__cookie_session__',
      });
    }
    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/admin/settings' && method === 'GET') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        audio_enhance_enabled: true,
        audio_enhance_worker_url: 'https://enhance.example.com',
        audio_enhance_worker_token: '********',
        audio_enhance_target_lufs: '-14',
        audio_enhance_atten_lim_db: '30',
        audio_enhance_concurrency: '1',
      });
    }
    if (p === '/api/admin/audio-enhance/verify' && method === 'POST') {
      verifyCount += 1;
      // 多台逐一探测的返回形状：workers 数组（UI 渲染逐台可达性列表）
      return fulfillJson(route, {
        ok: true,
        workers: [
          {
            url: 'https://enhance.example.com',
            ok: true,
            version: '1.0.0',
            engines: { ffmpeg: true, deepFilter: true },
            queue: { running: 0, queued: 0, capacity: 1, queueLimit: 8 },
          },
        ],
      });
    }
    if (method === 'GET') return fulfillJson(route, {});
    return fulfillJson(route, { success: true });
  });

  await loginThroughUi(page);
  await page.goto('/admin?tab=settings');

  // 切到「音频增强」设置 tab（e2e 默认 en 文案，双语正则稳一手）
  await page.getByRole('button', { name: /Audio Enhance|音频增强/ }).first().click();
  await expect(
    page.getByPlaceholder(/enhance-1\.example\.com/)
  ).toBeVisible({ timeout: 10_000 });

  // 测试连接 → 展示 worker 探测结果（版本 + DeepFilterNet 可用）
  await page.getByRole('button', { name: /Test connection|测试连接/ }).click();
  await expect(page.getByText(/Worker reachable|Worker 可达/)).toBeVisible({
    timeout: 10_000,
  });
  expect(verifyCount).toBe(1);
});
