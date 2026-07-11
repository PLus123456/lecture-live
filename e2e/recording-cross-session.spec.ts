import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * 跨会话隔离端到端（P0-3）+ 录音重连可视 affordance（P1-4）+ 回放保护（P1-8）。
 *
 * 背景：transcript store 是 SPA 内的内存单例，导航到别的会话不销毁它。修复前，会话 A
 * 录音中导航到 B，B 会把 A 的 recordingState='recording' 当成「本会话在录」→ recoveryMode
 * 判成 live-refresh → 调 reconnectAfterRefresh 续录、并向 B 回写 RECORDING/PAUSED 状态，
 * 等于把 A 的录音「续」进 B（审计 critical）。
 *
 * 修复：store 新增 activeSessionId（起录时 setActiveSessionId 绑定本会话），page.tsx 用
 * localRecordingForSession(activeSessionId, pageSessionId, recordingState) 过滤——store 绑定到
 * 别的会话时，本会话一律视为「本地无录音」→ recoveryMode='fresh'，不 live-refresh、不续录、
 * 不回写状态。
 *
 * 本 env 约束：DB-less dev server，全部 /api/** 被 mock；到 /playback 的导航在此不稳定，
 * 故所有断言只看会话页可观测量：渲染文本 / 按钮 / sessionStorage / 记录到的 PATCH 调用。
 */

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

interface CrossSessionMockOptions {
  targetId: string; // 被导航到的会话 id（GET /api/sessions/:id 的 mock 目标）
  targetStatus: string; // 该会话后端 status（P0-3 场景用 'CREATED' 表示全新会话）
  patchLog: string[]; // 记录所有 PATCH /api/sessions/:targetId 的 status（跨会话续录会回写 RECORDING/PAUSED）
}

/**
 * 通用会话页 API mock（参数化 sessionId，区别于 recording-resilience.spec 里写死的常量）。
 * 关键：PATCH /api/sessions/:id 把 body.status 记入 patchLog —— 这是「本会话是否被当成
 * live-refresh 续录、进而回写录制态」的权威可观测信号。
 */
function installCrossSessionMocks(page: Page, opts: CrossSessionMockOptions) {
  const { targetId, targetStatus, patchLog } = opts;
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
    if (p === '/api/sessions' && method === 'GET') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/soniox/ping') return fulfillJson(route, { ok: true });
    if (p === '/api/sessions/active-async') return fulfillJson(route, { items: [] });
    // 起录/续录才会取临时 key；此处一律 503，保证测试里没有真实转录连接建立。
    if (p === '/api/soniox/temporary-key') {
      return fulfillJson(route, { error: 'disabled in e2e' }, 503);
    }

    if (p === `/api/sessions/${targetId}` && method === 'GET') {
      return fulfillJson(route, {
        id: targetId,
        title: 'Cross Session E2E',
        status: targetStatus,
        sourceLang: 'en',
        targetLang: 'zh',
      });
    }
    if (p === `/api/sessions/${targetId}` && method === 'PATCH') {
      try {
        const body = JSON.parse(request.postData() ?? '{}') as { status?: string };
        if (typeof body.status === 'string') patchLog.push(body.status);
      } catch {
        /* ignore */
      }
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${targetId}/transcript/draft`) {
      if (method === 'GET') return fulfillJson(route, { exists: false, payload: null });
      return fulfillJson(route, { success: true, segmentCount: 0, updatedAt: Date.now() });
    }
    if (p === `/api/sessions/${targetId}/audio/draft` && method === 'GET') {
      return fulfillJson(route, { seqs: [] });
    }
    if (p === `/api/sessions/${targetId}/audio/draft/finalize`) {
      return fulfillJson(route, { success: true });
    }
    if (p === `/api/sessions/${targetId}/finalize` && method === 'POST') {
      return fulfillJson(route, { success: true });
    }

    return fulfillJson(route, { error: `Unhandled ${method} ${p}` }, 500);
  });
}

/**
 * 预置 zustand persist 快照，模拟「会话 boundSessionId 正在录音」遗留的全局单例内存态：
 * recordingState='recording' + 一段有辨识度的 segment，并把 store 绑定到 boundSessionId
 * （activeSessionId，与源码 partialize 持久化字段一致）。全页导航时 addInitScript 在页面脚本
 * 前写入 sessionStorage，忠实复现 SPA 软导航时 store 单例被 B 页读到 A 态的情形。
 */
function seedRecordingSnapshotFor(page: Page, boundSessionId: string, segmentText: string) {
  return page.addInitScript(
    ([sid, segText]) => {
      const startTime = Date.now() - 60_000;
      const snapshot = {
        state: {
          segments: [
            {
              id: 'seg-bound',
              sessionIndex: 0,
              speaker: '',
              language: 'en',
              text: segText,
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
          recordingState: 'recording',
          recordingStartTime: startTime,
          pausedAt: null,
          totalPausedMs: 0,
          totalDurationMs: 60_000,
          currentSessionIndex: 0,
          activeSessionId: sid,
        },
        version: 0,
      };
      window.sessionStorage.setItem('lecture-live-transcript', JSON.stringify(snapshot));
    },
    [boundSessionId, segmentText] as const
  );
}

/* ══════════════════════════════════════════════════════════════════════
 *  P0-3（PRIMARY）：store 绑定到 A、导航到全新会话 B，B 不得把 A 的录音
 *  当成本会话续录 —— 具体表现为「不向 B 回写 RECORDING/PAUSED 状态」。
 * ════════════════════════════════════════════════════════════════════ */
test('P0-3：store 绑定到 A 时导航到全新会话 B —— B 不采纳 A 的录音（不回写 RECORDING/PAUSED 状态）', async ({
  page,
}) => {
  const patchLog: string[] = [];
  await installCrossSessionMocks(page, {
    targetId: 'sess-B',
    targetStatus: 'CREATED',
    patchLog,
  });
  await loginThroughUi(page);
  // 全局 store 绑定到 A（A 录音中），segment 文本用于跨会话泄漏辨识。
  await seedRecordingSnapshotFor(page, 'sess-A', 'SEGMENT FROM SESSION A');

  await page.goto('/session/sess-B');
  await expect(page).toHaveURL(/\/session\/sess-B$/);

  // 给「录制态回写」effect（若误判 live-refresh 会 PATCH）充分时间发出请求。
  await page.waitForTimeout(2500);

  // 核心断言：B 绝不把自己回写成 RECORDING/PAUSED —— 即没有把 A 的录音/计时当成本会话续录。
  // 修复前 recoveryMode 会误判 live-refresh → reconnectAfterRefresh + 状态回写；修复后
  // localRecordingForSession 把「绑定到别的会话」的录音态过滤成 null → recoveryMode='fresh'，
  // 不续录、不回写。
  expect(patchLog).not.toContain('RECORDING');
  expect(patchLog).not.toContain('PAUSED');

  // 仍停留在 B 会话页（未因误判续录而跳转）。
  await expect(page).toHaveURL(/\/session\/sess-B$/);

  // 跨会话挂载即释放：绑定到别的会话(A)的全局单例被清空，activeSessionId 不再是 A。
  // 这是 P0-3 数据串写根因的正解——若保留 A 的 segments 在单例里，B 起录后新段会拼到 A 的
  // 段后，且 B 的 finalize 会把 A 的转录一并写进 B（page.tsx 收尾发送 store.segments）。
  const boundTo = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('lecture-live-transcript');
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { state?: { activeSessionId?: string | null } }).state
        ?.activeSessionId ?? null;
    } catch {
      return null;
    }
  });
  expect(boundTo).not.toBe('sess-A');
});

/* ══════════════════════════════════════════════════════════════════════
 *  P0-3 控制组：store 绑定到 B 本身、导航到 B —— 这是「本会话刷新恢复」的合法
 *  live-refresh 路径，应当采纳本地录音（回写 RECORDING/PAUSED）并展示本会话 segment。
 *  与上面的隔离用例形成对照，证明隔离效果确实来自 activeSessionId 绑定，而非 mock 巧合。
 * ════════════════════════════════════════════════════════════════════ */
test('P0-3 控制组：store 绑定到 B 本身导航到 B —— 合法 live-refresh 采纳本地录音（回写 RECORDING/PAUSED）并展示本会话 segment', async ({
  page,
}) => {
  const patchLog: string[] = [];
  await installCrossSessionMocks(page, {
    // 后端认为 B 仍在录（RECORDING），配合本地录音态构成同标签刷新恢复。
    targetId: 'sess-B',
    targetStatus: 'RECORDING',
    patchLog,
  });
  await loginThroughUi(page);
  await seedRecordingSnapshotFor(page, 'sess-B', 'SEGMENT FROM SESSION B');

  await page.goto('/session/sess-B');
  await expect(page).toHaveURL(/\/session\/sess-B$/);

  // 本会话的 segment 应正常呈现（对照「隔离」不代表连自己的数据也丢）。
  await expect(page.getByText('SEGMENT FROM SESSION B')).toBeVisible({ timeout: 15_000 });

  // live-refresh 采纳本地录音态并回写状态：应出现 RECORDING/PAUSED 的 PATCH。
  await expect
    .poll(() => patchLog.filter((s) => s === 'RECORDING' || s === 'PAUSED').length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
});

/* ══════════════════════════════════════════════════════════════════════
 *  P0-3 展示层：跨会话挂载时不得展示别的会话的 segments/计时。
 *
 *  根因（已修）：page.tsx 的初始化清理 effect 原先以**原始** recordingState 判 isResumable，
 *  store 绑定到别的会话（A）且处于 recording 时会误判「可恢复」而不清空，导致 A 的 segment/
 *  计时视觉串到 B。修复：该 effect 增加 boundToOtherSession（activeSessionId ≠ 本会话）判定，
 *  绑定到别的会话时一律清空全局单例，按本会话重新开始。
 * ════════════════════════════════════════════════════════════════════ */
test(
  'P0-3 展示层：绑定到 A 导航到 B 时 B 不渲染 A 的 segment',
  async ({ page }) => {
    const patchLog: string[] = [];
    await installCrossSessionMocks(page, {
      targetId: 'sess-B',
      targetStatus: 'CREATED',
      patchLog,
    });
    await loginThroughUi(page);
    await seedRecordingSnapshotFor(page, 'sess-A', 'SEGMENT FROM SESSION A');

    await page.goto('/session/sess-B');
    await expect(page).toHaveURL(/\/session\/sess-B$/);
    await page.waitForTimeout(2000);

    // 期望：A 的 segment 文本不出现在全新会话 B 的页面上。
    await expect(page.getByText('SEGMENT FROM SESSION A')).toHaveCount(0);
  }
);

/* ══════════════════════════════════════════════════════════════════════
 *  P1-4：录音中连接错误时的「重新连接」affordance。
 *
 *  桌面端按钮渲染条件是 `isRecording && connectionState === 'error'`（page.tsx，
 *  label=session.actions.reconnect）。在本 spec 所属的 chromium project 下**无法确定性**
 *  驱动到该状态，故 fixme：
 *
 *   1) connectionState 未纳入 transcriptStore 的 persist partialize，无法用 sessionStorage
 *      快照种入 'error'；store 也未挂到 window，测试侧无从直接 setState。
 *   2) 只有 attemptReconnect 达到 MAX_RECONNECT_ATTEMPTS(5) 才会把 connectionState 稳定置
 *      'error'（其余路径瞬间被 'reconnecting'/'connecting' 覆盖），且这条路径要「保持
 *      recording 而非落 paused」必须 canRecoverLocally()/hasLiveCapture() 为真——即需要真实
 *      采集音轨。而 chromium project 用 installBrowserStubs 的空 MediaStream（无音轨），
 *      首个断连即走 pauseForInterruption 的整暂停分支 → recordingState='paused' →
 *      isRecording=false，按钮永不挂载。
 *   3) 真实采集需要 chromium-media（--use-fake-device-for-media-stream）project，其 testMatch
 *      只含 /recording-offline-capture/；本文件不匹配，且不应改动 playwright.config。
 *
 *  已在 recording-offline-capture.spec.ts（chromium-media）验证 __sonioxTest.error() 后
 *  录音在断连下继续；此处仅补记 P1-4 桌面按钮不可在本 project 确定性复现的原因。
 * ════════════════════════════════════════════════════════════════════ */
test.fixme(
  'P1-4：录音中连接 error 时出现「重新连接」按钮（本 project 无法确定性驱动 connectionState=error，见注释）',
  async () => {
    // 见上方注释：需 chromium-media 真实采集 + MAX_RECONNECT_ATTEMPTS 退避耗尽，本 project 不可达。
  }
);

/* ══════════════════════════════════════════════════════════════════════
 *  P1-8：回放页让位于活跃录音 store（recording/paused/finalizing 三态都不清空/覆盖全局
 *  实时 store）。该行为的可观测面在 /session/:id/playback 页；而本 env 到 playback 的导航
 *  不稳定（既有用例「正常停止…跳回放」在未改动基线上亦 fail）。会话页侧无独立可观测量，
 *  故按任务约束跳过 e2e，改由单测 shouldPlaybackYieldToLiveStore 覆盖
 *  （src/lib/session/__tests__/recordingLifecycle.test.ts）。
 * ════════════════════════════════════════════════════════════════════ */
test.fixme(
  'P1-8：回放页不清空活跃录音 store（依赖 playback 导航，本 env 不稳定；见 recordingLifecycle 单测）',
  async () => {
    // 见上方注释：playback 导航在 DB-less env 不稳定，纯决策逻辑由 recordingLifecycle 单测覆盖。
  }
);
