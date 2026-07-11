import { test, expect, type Page, type Route } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fulfillJson, fulfillSse, installBrowserStubs } from './helpers';

/**
 * U15 — 全局对话（/chat）端到端，对齐 PR#169/#170「Claude 式聊天布局重构」。
 *
 * 重构后的关键流程（与旧「点新建对话按钮 → POST → 跳转」不同）：
 *   · 首页 composer 输入首条消息 → POST /api/conversations 懒创建 → 文本存进
 *     chatStore.pendingFirstMessage → router.push(/chat/<id>) → GlobalChat 加载完
 *     自动发送首条 → POST /api/llm/chat（SSE 流）。
 *   · 录音在首页 composer 用 RecordingPicker「预选」（onPickLocal，不发请求），
 *     随创建对话的 recordingIds 一并挂载。
 *   · 发送不再创建会话/不导航；conversationId 始终是已有的。
 *
 * 全量 route mock（死 DB，必须全 mock；参考 recording-resilience.spec 的 harness）：
 * 有状态地记录消息与附件，使「刷新后持久化」可断言。
 */

const ADMIN_EMAIL = 'admin@lecturelive.com';
const ADMIN_PASSWORD = 'admin123';
const ART = path.join(process.cwd(), 'artifacts');

const adminUser = {
  id: 'user-1',
  email: ADMIN_EMAIL,
  displayName: 'Admin',
  role: 'ADMIN',
};

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
    storageBytesUsed: 0,
    storageBytesLimit: 1_000_000_000,
    remainingStorageBytes: 1_000_000_000,
    allowedModels: 'local,claude',
    quotaResetAt: null,
  },
};

/** 助手固定回复（作为 SSE `text` 帧的 delta，也作为落库 assistant 消息的 content） */
const ASSISTANT_REPLY = '这是助手的模拟回复。';

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  transcriptOffsetMs: number | null;
  degradationLevel: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

interface StoredAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  kind: 'image' | 'document' | 'text';
  bytes: number;
  createdAt: string;
  cloudrevePath: string;
}

interface ChatMockState {
  /** 每个 conversation 的消息（可跨刷新持久化） */
  messagesById: Record<string, StoredMessage[]>;
  /** 每个 conversation 的附件 chips（GET /api/chat-uploads 回填用） */
  attachmentsById: Record<string, StoredAttachment[]>;
  /** 记录所有 POST /api/conversations 的 body（断言 recordingIds） */
  createBodies: Array<Record<string, unknown>>;
  /** 记录所有 POST /api/llm/chat 的 body */
  llmBodies: Array<Record<string, unknown>>;
  /** 记录 generate-title 是否被触发 */
  titleGenerated: boolean;
  /** 未被显式 mock 命中的路径（调试用） */
  unmocked: string[];
  /** 已关闭（只读）的 conversation：messages 端点回 endedAt 非空 */
  endedById: Record<string, boolean>;
  /** 这些 conversation 的 /api/llm/chat 返回「半截正文 + error」且不落库 assistant（H4） */
  errorConvIds: string[];
  /** 自增序号，用于生成稳定 id */
  seq: number;
}

function createState(): ChatMockState {
  return {
    messagesById: {},
    attachmentsById: {},
    createBodies: [],
    llmBodies: [],
    titleGenerated: false,
    unmocked: [],
    endedById: {},
    errorConvIds: [],
    seq: 0,
  };
}

function isoAt(offsetSec: number): string {
  // 固定基准时间 + 偏移，保证 createdAt 稳定且单调（不用 Date.now 避免 flaky 排序）
  return new Date(1_760_000_000_000 + offsetSec * 1000).toISOString();
}

function parseBody(route: Route): Record<string, unknown> {
  try {
    return JSON.parse(route.request().postData() ?? '{}') as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

/** 安装全量 chat API mock，返回可在断言中读取的 state。 */
function installChatMocks(page: Page, state: ChatMockState) {
  return page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();

    // ── 站点 / 鉴权 ──
    if (p === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'U15 global chat',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      // 整页导航 / 刷新后靠 cookie 恢复会话
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }

    // ── dashboard 外壳杂项 ──
    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/soniox/ping') return fulfillJson(route, { ok: true });
    if (p === '/api/sessions/active-async') {
      return fulfillJson(route, { items: [] });
    }

    // RecordingPicker → GET /api/sessions?limit=100（过滤 status===COMPLETED）
    if (p === '/api/sessions') {
      return fulfillJson(route, {
        items: [
          {
            id: 'rec-1',
            title: '第一节课录音',
            courseName: '物理导论',
            createdAt: isoAt(0),
            durationMs: 600_000,
            status: 'COMPLETED',
          },
        ],
        nextCursor: null,
      });
    }

    // ComposerModelControls → GET /api/llm/models
    if (p === '/api/llm/models') {
      return fulfillJson(route, {
        models: [
          {
            name: 'mock-model',
            id: 'mock-model',
            modelId: 'mock-model',
            displayName: 'Mock Model',
            supportsThinking: false,
            thinkingMode: 'NONE',
            supportsThinkingDepth: false,
            allowedDepths: [],
            supportsImage: false,
            contextWindow: 128_000,
            purpose: 'CHAT',
          },
        ],
        defaultModel: 'mock-model',
      });
    }

    // ── conversations 列表 / 创建 ──
    if (p === '/api/conversations' && method === 'GET') {
      const list = Object.keys(state.messagesById).map((id) => ({
        id,
        title: null,
        startedAt: isoAt(0),
        endedAt: null,
        degradationLevel: 0,
        archived: false,
        messageCount: state.messagesById[id].length,
        sessionIds: [],
        sessionBound: false,
      }));
      return fulfillJson(route, { conversations: list });
    }
    if (p === '/api/conversations' && method === 'POST') {
      const body = parseBody(route);
      state.createBodies.push(body);
      const id = `conv-e2e-${++state.seq}`;
      state.messagesById[id] = [];
      state.attachmentsById[id] = [];
      const recordingIds = Array.isArray(body.recordingIds)
        ? (body.recordingIds as string[])
        : [];
      return fulfillJson(route, {
        conversation: {
          id,
          title: null,
          startedAt: isoAt(0),
          endedAt: null,
          degradationLevel: 0,
          archived: false,
          messageCount: 0,
          sessionIds: recordingIds,
          sessionBound: false,
        },
      });
    }

    // ── 单对话子路由 ──
    const convSub = p.match(/^\/api\/conversations\/([^/]+)\/([^/]+)$/);
    if (convSub) {
      const [, convId, sub] = convSub;

      // GET messages → 加载历史（GlobalChat mount）
      if (sub === 'messages' && method === 'GET') {
        return fulfillJson(route, {
          conversation: {
            id: convId,
            title: null,
            startedAt: isoAt(0),
            endedAt: state.endedById[convId] ? isoAt(5) : null,
            degradationLevel: 0,
          },
          messages: state.messagesById[convId] ?? [],
        });
      }

      // 录音 pill 回填 / 附加
      if (sub === 'recordings' && method === 'GET') {
        return fulfillJson(route, { recordings: [] });
      }
      if (sub === 'recordings' && method === 'POST') {
        return fulfillJson(route, { ok: true });
      }

      // 首轮完成后 fire-and-forget 生成标题
      if (sub === 'generate-title' && method === 'POST') {
        state.titleGenerated = true;
        return fulfillJson(route, { ok: true, title: '自动标题' });
      }
    }

    // DELETE /api/conversations/<id>
    if (/^\/api\/conversations\/[^/]+$/.test(p) && method === 'DELETE') {
      return fulfillJson(route, { ok: true });
    }

    // ── 文件附件 ──
    if (p === '/api/chat-uploads' && method === 'GET') {
      const convId = url.searchParams.get('conversationId') ?? '';
      return fulfillJson(route, {
        attachments: state.attachmentsById[convId] ?? [],
      });
    }
    if (p === '/api/chat-uploads' && method === 'POST') {
      // multipart body 里含 conversationId + file；用固定文件名回应（测试上传的就是它）。
      const convId = extractMultipartField(
        route.request().postData(),
        'conversationId'
      );
      const att: StoredAttachment = {
        id: `att-${++state.seq}`,
        fileName: 'u15-sample.txt',
        mimeType: 'text/plain',
        kind: 'text',
        bytes: 24,
        createdAt: isoAt(state.seq),
        cloudrevePath: `/mock/${state.seq}/u15-sample.txt`,
      };
      if (convId) {
        (state.attachmentsById[convId] ||= []).push(att);
      }
      return fulfillJson(route, {
        attachmentId: att.id,
        cloudrevePath: att.cloudrevePath,
        kind: att.kind,
        bytes: att.bytes,
        extractedTextPreview: 'hello e2e',
        fileName: att.fileName,
      });
    }
    if (/^\/api\/chat-uploads\/[^/]+$/.test(p) && method === 'DELETE') {
      return fulfillJson(route, { ok: true });
    }

    // ── 发送消息：SSE 流 + 落库 user/assistant（供刷新持久化断言）──
    if (p === '/api/llm/chat' && method === 'POST') {
      const body = parseBody(route);
      state.llmBodies.push(body);
      const convId = String(body.conversationId ?? '');
      const question = String(body.question ?? '');
      const msgs = (state.messagesById[convId] ||= []);
      // 落库 user 消息（与真实后端一致：user 在调 LLM 前先落库）
      msgs.push({
        id: `m-${++state.seq}`,
        role: 'user',
        content: question,
        transcriptOffsetMs: 0,
        degradationLevel: null,
        inputTokens: null,
        outputTokens: null,
        createdAt: isoAt(state.seq),
      });
      // H4：模拟「先流出半截正文，再报错」——服务端不落库 assistant（半截答案不持久化）。
      if (state.errorConvIds.includes(convId)) {
        return fulfillSse(route, [
          { event: 'text', data: { delta: '这是半截答案……' } },
          { event: 'error', data: { error: '生成失败，请重试。', contextFull: false } },
        ]);
      }
      msgs.push({
        id: `m-${++state.seq}`,
        role: 'assistant',
        content: ASSISTANT_REPLY,
        transcriptOffsetMs: 0,
        degradationLevel: 1,
        inputTokens: 10,
        outputTokens: 5,
        createdAt: isoAt(state.seq),
      });
      return fulfillSse(route, [
        { event: 'text', data: { delta: ASSISTANT_REPLY } },
        {
          event: 'done',
          data: {
            model: 'Mock Model',
            thinkingDepth: 'medium',
            level: 1,
            budget: 100_000,
            inputTokens: 10,
            outputTokens: 5,
          },
        },
      ]);
    }

    // 兜底：记录并回良性空对象（本套件不依赖的边角端点，不因 500 打断 UI）。
    state.unmocked.push(`${method} ${p}`);
    return fulfillJson(route, {});
  });
}

/** 从 multipart/form-data 原文里粗取某个文本字段（够用于 conversationId）。 */
function extractMultipartField(
  raw: string | null,
  field: string
): string | null {
  if (!raw) return null;
  const re = new RegExp(
    `name="${field}"\\r?\\n\\r?\\n([^\\r\\n]*)`,
    'i'
  );
  const m = raw.match(re);
  return m ? m[1] : null;
}

async function snap(page: Page, name: string) {
  try {
    await fs.promises.mkdir(ART, { recursive: true });
    await page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: true });
  } catch (err) {
    console.warn(`[u15] screenshot ${name} 失败:`, err);
  }
}

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });
}

let state: ChatMockState;

test.beforeEach(async ({ page }) => {
  state = createState();
  await installBrowserStubs(page);
  await installChatMocks(page, state);
});

test('起聊主流程：首页 composer 预选录音 → 创建对话(带 recordingIds) → 自动发送 → SSE 流式回复', async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto('/chat');

  // 首页 composer（唯一 textarea）
  const composer = page.locator('textarea');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await snap(page, 'u15-step1');

  // ---- 预选录音：打开 RecordingPicker → 选中 → 附加选中（本地模式，不发请求）
  await page
    .getByRole('button', { name: /添加录音|Attach recording/i })
    .first()
    .click();
  const row = page.locator('[data-testid="recording-row-rec-1"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await page
    .getByRole('button', { name: /附加选中|Attach Selected/i })
    .click();

  // picker 关闭后，预选录音以 pill 形式出现在 composer 上方
  await expect(page.getByText('第一节课录音').first()).toBeVisible({
    timeout: 10_000,
  });
  await snap(page, 'u15-step2');

  // ---- 输入首条消息并发送（→ POST /api/conversations 懒创建 → 跳 /chat/<id>）
  const userMsg = '帮我总结这段录音';
  await composer.fill(userMsg);

  const createPromise = page.waitForResponse(
    (res) =>
      res.url().includes('/api/conversations') &&
      res.request().method() === 'POST',
    { timeout: 15_000 }
  );
  await page.getByRole('button', { name: /^(发送|Send)$/ }).click();
  const createResp = await createPromise;
  expect(createResp.ok(), 'POST /api/conversations 应 2xx').toBeTruthy();
  const convBody = (await createResp.json()) as { conversation?: { id?: string } };
  const conversationId = convBody.conversation?.id;
  expect(conversationId, '创建响应应带新对话 id').toBeTruthy();

  // 跳转到详情页
  await page.waitForURL(new RegExp(`/chat/${conversationId}(\\?|$)`), {
    timeout: 15_000,
  });

  // 创建请求应携带预选录音的 recordingIds
  const lastCreate = state.createBodies.at(-1) ?? {};
  expect(
    Array.isArray(lastCreate.recordingIds) &&
      (lastCreate.recordingIds as string[]).includes('rec-1'),
    'POST /api/conversations 应带 recordingIds:[rec-1]'
  ).toBeTruthy();

  // ---- 自动发送首条：用户消息 + 助手流式回复都应出现
  await expect(page.getByText(userMsg).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(ASSISTANT_REPLY).first()).toBeVisible({
    timeout: 20_000,
  });

  // 发给 /api/llm/chat 的 body 应带正确 conversationId + question
  const lastLlm = state.llmBodies.at(-1) ?? {};
  expect(lastLlm.conversationId).toBe(conversationId);
  expect(lastLlm.question).toBe(userMsg);

  // 首轮完成 → 触发 generate-title
  await expect
    .poll(() => state.titleGenerated, { timeout: 10_000 })
    .toBe(true);
  await snap(page, 'u15-step3');
});

test('已有对话：加载历史 → 上传文件附件 → 手动发消息 → SSE 回复 → 刷新后持久化', async ({
  page,
}) => {
  const convId = 'conv-existing';
  // 预置一轮历史（1 user + 1 assistant）
  state.messagesById[convId] = [
    {
      id: 'h-1',
      role: 'user',
      content: '历史问题一二三',
      transcriptOffsetMs: 0,
      degradationLevel: null,
      inputTokens: null,
      outputTokens: null,
      createdAt: isoAt(1),
    },
    {
      id: 'h-2',
      role: 'assistant',
      content: '历史回答四五六',
      transcriptOffsetMs: 0,
      degradationLevel: 1,
      inputTokens: 8,
      outputTokens: 4,
      createdAt: isoAt(2),
    },
  ];
  state.attachmentsById[convId] = [];

  await loginAsAdmin(page);
  await page.goto(`/chat/${convId}`);

  // 历史渲染
  await expect(page.getByText('历史问题一二三').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('历史回答四五六').first()).toBeVisible({
    timeout: 15_000,
  });
  await snap(page, 'u15-existing-1');

  // ---- 上传文件附件（paperclip → 隐藏的文档 file input → POST /api/chat-uploads）
  const uploadPromise = page.waitForResponse(
    (res) =>
      res.url().includes('/api/chat-uploads') &&
      res.request().method() === 'POST',
    { timeout: 20_000 }
  );
  await page
    .locator('input[type="file"][accept*=".txt"]')
    .setInputFiles({
      name: 'u15-sample.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello u15\nsecond line\n'),
    });
  const uploadResp = await uploadPromise;
  expect(uploadResp.ok(), 'POST /api/chat-uploads 应 2xx').toBeTruthy();

  // 附件 chip 出现
  await expect(page.getByText(/u15-sample\.txt/).first()).toBeVisible({
    timeout: 10_000,
  });

  // ---- 手动发一条消息
  const userMsg = '继续问一个新问题';
  const composer = page.locator('textarea');
  await composer.fill(userMsg);
  await page.getByRole('button', { name: /^(发送|Send)$/ }).click();

  await expect(page.getByText(userMsg).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(ASSISTANT_REPLY).first()).toBeVisible({
    timeout: 20_000,
  });
  await snap(page, 'u15-existing-2');

  // ---- 刷新页面：历史 + 新消息 + 附件都应持久化（从 mock 的有状态存储回读）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForURL(new RegExp(`/chat/${convId}(\\?|$)`), { timeout: 15_000 });

  await expect(page.getByText('历史问题一二三').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(userMsg).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(ASSISTANT_REPLY).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/u15-sample\.txt/).first()).toBeVisible({
    timeout: 15_000,
  });
  await snap(page, 'u15-existing-3');
});

test('M5：已关闭对话（只读）→ 附件 chip 可见但删除入口被隐藏', async ({
  page,
}) => {
  const convId = 'conv-closed';
  state.endedById[convId] = true;
  state.messagesById[convId] = [
    {
      id: 'h-1',
      role: 'user',
      content: '关闭前的问题',
      transcriptOffsetMs: 0,
      degradationLevel: null,
      inputTokens: null,
      outputTokens: null,
      createdAt: isoAt(1),
    },
  ];
  state.attachmentsById[convId] = [
    {
      id: 'att-closed-1',
      fileName: 'closed-doc.txt',
      mimeType: 'text/plain',
      kind: 'text',
      bytes: 42,
      createdAt: isoAt(2),
      cloudrevePath: '/mock/closed/closed-doc.txt',
    },
  ];

  await loginAsAdmin(page);
  await page.goto(`/chat/${convId}`);

  // 历史 + 附件 chip 都应渲染
  await expect(page.getByText('关闭前的问题').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/closed-doc\.txt/).first()).toBeVisible({
    timeout: 15_000,
  });

  // 只读语义：附件删除入口（title="Remove" 的按钮）必须不存在
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await snap(page, 'm5-closed-readonly');
});

test('H4：半截正文后报错 → 显式失败提示、且刷新后半截答案不作为历史留存', async ({
  page,
}) => {
  const convId = 'conv-h4';
  state.messagesById[convId] = [];
  state.errorConvIds.push(convId);

  await loginAsAdmin(page);
  await page.goto(`/chat/${convId}`);

  const composer = page.locator('textarea');
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const userMsg = '触发失败的问题';
  await composer.fill(userMsg);
  await page.getByRole('button', { name: /^(发送|Send)$/ }).click();

  // 用户消息可见
  await expect(page.getByText(userMsg).first()).toBeVisible({ timeout: 15_000 });
  // 关键：失败必须显式呈现（不能只留半句话让用户以为成功）
  await expect(page.getByText(/生成失败/).first()).toBeVisible({
    timeout: 15_000,
  });
  await snap(page, 'h4-error-surfaced');

  // 刷新：半截答案没有落库（服务端 mock 未 push assistant）→ 历史里既无半截正文也无失败提示
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForURL(new RegExp(`/chat/${convId}(\\?|$)`), { timeout: 15_000 });

  await expect(page.getByText(userMsg).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/这是半截答案/)).toHaveCount(0);
  await expect(page.getByText(/生成失败/)).toHaveCount(0);
  await snap(page, 'h4-after-reload');
});
