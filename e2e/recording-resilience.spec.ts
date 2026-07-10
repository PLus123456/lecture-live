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

function installSessionApiMocks(page: Page, finalizeBody: unknown) {
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

    // 会话元信息：后端仍认为在录（PAUSED）→ 配合本地暂停态 = live-refresh 恢复
    if (p === `/api/sessions/${SESSION_ID}` && method === 'GET') {
      return fulfillJson(route, {
        id: SESSION_ID,
        title: 'Reclaim E2E',
        status: 'PAUSED',
        sourceLang: 'en',
        targetLang: 'zh',
      });
    }
    // 录制态回写：放行（本用例不校验其结果）
    if (p === `/api/sessions/${SESSION_ID}` && method === 'PATCH') {
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${SESSION_ID}/transcript/draft`) {
      if (method === 'GET') return fulfillJson(route, { exists: false, payload: null });
      return fulfillJson(route, { success: true, segmentCount: 1, updatedAt: Date.now() });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio/draft` && method === 'GET') {
      return fulfillJson(route, { seqs: [] });
    }
    if (p === `/api/sessions/${SESSION_ID}/audio/draft/finalize`) {
      return fulfillJson(route, { success: true });
    }
    // 关键：会话已被回收 → finalize 幂等短路
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
  await installSessionApiMocks(page, { success: true, alreadyCompleted: true });
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
  await installSessionApiMocks(page, { success: true });
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
