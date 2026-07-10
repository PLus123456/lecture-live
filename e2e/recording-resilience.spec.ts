import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 录音健壮性端到端：会话被服务端回收（reclaim）后停止收尾不再静默删库丢录音（审计 critical）。
 *
 * 场景：本标签处于「刷新恢复到暂停展示态」(live-refresh)，sessionStorage 里有本地转录；
 * 用户点停止收尾，服务端 finalize 因会话已被 reclaimStaleSessions 收成 COMPLETED 而幂等
 * 短路返回 {success:true, alreadyCompleted:true}。修复后客户端必须：保留本地 sessionStorage
 * （唯一完整副本）、给出「已在服务器结束」提示、不跳回放。
 */

const SESSION_ID = 'reclaim-e2e';

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

// 预置 zustand persist 的转录 store 快照：录音中刷新遗留的「暂停态 + 已有转录段」。
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

interface MockOptions {
  finalizeBody?: unknown;
  sessionStatus?: string; // GET /api/sessions/:id 返回的 status
  sessionGetFails?: boolean; // GET /api/sessions/:id 返回 500（模拟拉取失败）
  patchLog?: string[]; // 记录所有 PATCH /api/sessions/:id 的目标 status
  draftFullPayload?: unknown; // GET transcript/draft?full=true（冷恢复读取）
}

function installSessionApiMocks(page: Page, opts: MockOptions = {}) {
  const {
    finalizeBody = { success: true },
    sessionStatus = 'PAUSED',
    sessionGetFails = false,
    patchLog,
    draftFullPayload,
  } = opts;

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
    // 整页导航到会话页后，token 不持久化，靠 refresh 从 cookie 恢复会话
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

    // 会话元信息
    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      if (sessionGetFails) {
        return fulfillJson(route, { error: 'boom' }, 500);
      }
      return fulfillJson(route, {
        id: SESSION_ID,
        title: 'Reclaim E2E',
        status: sessionStatus,
        sourceLang: 'en',
        targetLang: 'zh',
      });
    }
    // 录制态回写：记录并放行
    if (p === `/api/sessions/${SESSION_ID}` && method === 'PATCH') {
      try {
        const body = JSON.parse(request.postData() ?? '{}') as { status?: string };
        if (patchLog && typeof body.status === 'string') patchLog.push(body.status);
      } catch {
        /* ignore */
      }
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript/draft`) {
      if (method === 'GET') {
        if (url.searchParams.get('full') === 'true') {
          return fulfillJson(
            route,
            draftFullPayload ?? { exists: false, payload: null }
          );
        }
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
    // 会话已被回收 → finalize 幂等短路（或正常成功，视 finalizeBody）
    if (p === `/api/sessions/${SESSION_ID}/finalize` && method === 'POST') {
      return fulfillJson(route, finalizeBody);
    }
    if (p === '/api/soniox/temporary-key') {
      return fulfillJson(route, { error: 'disabled in e2e' }, 503);
    }

    return fulfillJson(route, { error: `Unhandled ${method} ${p}` }, 500);
  });
}

test('会话被回收后停止：finalize 返回 alreadyCompleted 时保留本地录音、不静默删库', async ({
  page,
}) => {
  await installSessionApiMocks(page, {
    finalizeBody: { success: true, alreadyCompleted: true },
  });
  await loginThroughUi(page);
  await seedRecordingSnapshot(page);

  await page.goto(`/session/${SESSION_ID}`);
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));

  // 恢复到暂停展示态：Stop 按钮出现
  const stopButton = page.getByRole('button', { name: 'Stop', exact: true }).first();
  await expect(stopButton).toBeVisible({ timeout: 15_000 });

  // 停止收尾（服务端返回 alreadyCompleted）
  await stopButton.click();

  // 断言 1：本地 sessionStorage 转录未被清空（唯一完整副本得以保留）
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          window.sessionStorage.getItem('lecture-live-transcript')
        ),
      { timeout: 10_000 }
    )
    .not.toBeNull();

  // 断言 2：仍停留在会话页（未静默跳转回放）
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
});

test('正常停止：finalize 成功(无 alreadyCompleted)才清空本地缓存并跳回放', async ({
  page,
}) => {
  await installSessionApiMocks(page, { finalizeBody: { success: true } });
  await loginThroughUi(page);
  await seedRecordingSnapshot(page);

  await page.goto(`/session/${SESSION_ID}`);
  const stopButton = page.getByRole('button', { name: 'Stop', exact: true }).first();
  await expect(stopButton).toBeVisible({ timeout: 15_000 });
  await stopButton.click();

  // 正常收尾：跳转到回放页
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}/playback`), {
    timeout: 15_000,
  });
});

test('观察者标签(resume-cold，无本地录音态)不回写 PAUSED，不掐停另一标签的录音', async ({
  page,
}) => {
  const patchLog: string[] = [];
  await installSessionApiMocks(page, {
    sessionStatus: 'RECORDING', // 另一标签正在录
    patchLog,
    draftFullPayload: {
      exists: true,
      payload: {
        segments: [
          {
            id: 'seg-1',
            sessionIndex: 0,
            speaker: '',
            language: 'en',
            text: 'text from the recording tab',
            globalStartMs: 0,
            globalEndMs: 1000,
            startMs: 0,
            endMs: 1000,
            isFinal: true,
            confidence: 1,
            timestamp: '00:00:00',
          },
        ],
        summaries: [],
        translations: {},
        clientTs: Date.now(),
        recordingStartTime: Date.now() - 30_000,
        pausedAt: null,
        totalPausedMs: 0,
      },
    },
  });
  await loginThroughUi(page);
  // 不预置 sessionStorage：模拟「在新标签打开一个正在录音的会话」→ recoveryMode=resume-cold
  await page.goto(`/session/${SESSION_ID}`);

  // 冷恢复完成：显示出录音标签的转录内容
  await expect(page.getByText('text from the recording tab')).toBeVisible({
    timeout: 15_000,
  });
  // 给录制态回写 effect 充分时间（若会 PATCH，此刻应已发出）
  await page.waitForTimeout(1500);

  // 关键：观察者标签绝不 PATCH PAUSED，否则会掐停另一标签正在进行的录音（审计 medium）
  expect(patchLog).not.toContain('PAUSED');
});

test('会话状态拉取失败 + 本地在录：兜底 live-refresh 保留本地，不误判 fresh 清数据', async ({
  page,
}) => {
  await installSessionApiMocks(page, { sessionGetFails: true });
  await loginThroughUi(page);
  await seedRecordingSnapshot(page);

  await page.goto(`/session/${SESSION_ID}`);

  // 后端 status 拿不到 + 本地在录 → 兜底恢复到暂停展示态（Stop 按钮出现），而非当新会话
  const stopButton = page.getByRole('button', { name: 'Stop', exact: true }).first();
  await expect(stopButton).toBeVisible({ timeout: 15_000 });

  // 本地 sessionStorage 未被当作新会话清除
  const snap = await page.evaluate(() =>
    window.sessionStorage.getItem('lecture-live-transcript')
  );
  expect(snap).not.toBeNull();
});
