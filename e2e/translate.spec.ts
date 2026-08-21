import { test, expect } from '@playwright/test';
import { fulfillJson, fulfillSse, installBrowserStubs, loginViaForm } from './helpers';

/**
 * 翻译页烟测 —— 全量 route mock、无真实 DB / worker。
 *
 * 覆盖：
 *  1) 文本 tab：输入 → 防抖触发 /api/translate/text（SSE）→ 译文流式渲染 + 请求体正确。
 *  2) 文档 tab：任务列表渲染（完成任务显示下载/双语按钮；失败任务显示重试与退款标记）。
 *  3) 上传 PDF → 报价确认弹窗 → 确认后调 /confirm。
 *  4) 组能力关闭（docEnabled=false）时文档 tab 显示不可用文案。
 *  5) 免计费账号（管理员）：价格提示全部换成「免费」，报价弹窗不谈钱、按钮不是「付费并翻译」。
 */

const user: Record<string, unknown> = {
  id: 'user-1',
  email: 'stu@example.com',
  displayName: 'Student',
  role: 'FREE',
};

let capturedTextBody: Record<string, unknown> | null = null;
let capturedConfirmId: string | null = null;
let docEnabled = true;
let billingExempt = false;
let tasks: Array<Record<string, unknown>> = [];

const quotedTask = {
  id: 'task-q1',
  fileName: 'paper.pdf',
  fileBytes: 123456,
  pageCount: 12,
  status: 'QUOTED',
  progress: 0,
  sourceLang: 'en',
  targetLang: 'zh',
  estimatedCents: 120,
  chargedCents: 0,
  refunded: false,
  hasMono: false,
  hasDual: false,
  errorMessage: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
};

test.beforeEach(async ({ page }) => {
  capturedTextBody = null;
  capturedConfirmId = null;
  docEnabled = true;
  billingExempt = false;
  user.role = 'FREE';
  tasks = [];
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, { site_name: 'LectureLive QA', allow_registration: true });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user, token: '__cookie_session__' });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user, token: '__cookie_session__' });
    }

    if (p === '/api/translate/models') {
      return fulfillJson(route, {
        models: [
          { id: 'm-trans', displayName: 'DeepSeek V3', modelId: 'deepseek-chat' },
        ],
        defaultModel: 'm-trans',
        config: {
          textEnabled: true,
          docEnabled,
          billingExempt,
          textBillingMode: 'free',
          textDailyFreeLimit: 100,
          textPriceCentsPerKchar: 1,
          docPriceCentsPerPage: 10,
          docMaxPages: 300,
          docMaxMb: 30,
        },
      });
    }
    if (p === '/api/translate/text' && method === 'POST') {
      capturedTextBody = request.postDataJSON();
      return fulfillSse(route, [
        { event: 'text', data: { delta: '你好' } },
        { event: 'text', data: { delta: '，世界' } },
        { event: 'usage', data: { inputTokens: 5, outputTokens: 4 } },
        { event: 'done', data: { charged: 0 } },
      ]);
    }
    if (p === '/api/translate/documents' && method === 'GET') {
      return fulfillJson(route, { tasks });
    }
    if (p === '/api/translate/documents' && method === 'POST') {
      // 服务端对免计费账号直接出 0 报价（见 /api/translate/documents 的 isBillingExempt 分支）
      const quoted = billingExempt ? { ...quotedTask, estimatedCents: 0 } : quotedTask;
      tasks = [quoted, ...tasks];
      return fulfillJson(route, { task: quoted, walletBalanceCents: 10000 });
    }
    if (/^\/api\/translate\/documents\/[^/]+\/confirm$/.test(p) && method === 'POST') {
      capturedConfirmId = p.split('/')[4];
      const started = { ...quotedTask, status: 'PENDING', chargedCents: 120 };
      tasks = [started];
      return fulfillJson(route, { task: started, walletBalanceCents: 9880 });
    }
    if (/^\/api\/translate\/documents\/[^/]+$/.test(p) && method === 'GET') {
      const id = p.split('/').pop();
      const found = tasks.find((task) => task.id === id);
      return fulfillJson(route, { task: found ?? null }, found ? 200 : 404);
    }

    if (p === '/api/users/quota') {
      return fulfillJson(route, {
        quotas: {
          id: 'user-1', role: 'FREE',
          transcriptionMinutesUsed: 0, transcriptionMinutesLimit: 60,
          purchasedMinutesBalance: 0,
          remainingTranscriptionMinutes: 60, remainingTranscriptionMs: 3_600_000,
          storageHoursUsed: 0, storageHoursLimit: 10,
          storageBytesUsed: 0, storageBytesLimit: 104857600, remainingStorageBytes: 104857600,
          allowedModels: 'local', quotaResetAt: null,
        },
      });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') return fulfillJson(route, { items: [], nextCursor: null });
    return fulfillJson(route, {});
  });
});

async function login(page: import('@playwright/test').Page) {
  await loginViaForm(page, {
    email: 'stu@example.com',
    password: 'whatever',
    prewarm: ['/translate'],
  });
}

test('文本翻译：输入 → SSE 流式译文渲染 + 请求体带语言与模型', async ({ page }) => {
  await login(page);
  await page.goto('/translate');

  const input = page.locator('textarea');
  await input.fill('Hello, world');
  // 防抖 800ms 后触发；断言译文流式渲染出来
  await expect(page.getByText('你好，世界')).toBeVisible({ timeout: 15_000 });

  expect(capturedTextBody).toMatchObject({
    text: 'Hello, world',
    sourceLang: 'auto',
    targetLang: 'zh',
    modelId: 'm-trans',
  });

  // 复制按钮出现（有译文才有）
  await expect(page.getByText(/Copy|复制/).first()).toBeVisible();
});

test('文档 tab：完成/失败任务的按钮与退款标记', async ({ page }) => {
  tasks = [
    {
      ...quotedTask,
      id: 'task-done',
      status: 'COMPLETED',
      progress: 100,
      chargedCents: 120,
      hasMono: true,
      hasDual: true,
      completedAt: new Date().toISOString(),
    },
    {
      ...quotedTask,
      id: 'task-fail',
      fileName: 'thesis.pdf',
      status: 'FAILED',
      chargedCents: 120,
      refunded: true,
      errorMessage: 'worker 翻译失败',
    },
  ];
  await login(page);
  await page.goto('/translate?tab=doc');

  // 完成任务：单语/双语下载 + 预览
  await expect(page.getByText('paper.pdf')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Translated PDF|译文 PDF/).first()).toBeVisible();
  await expect(page.getByText(/Bilingual PDF|双语对照 PDF/).first()).toBeVisible();

  // 失败任务：重试按钮 + 退款标记 + 错误信息
  await expect(page.getByText('thesis.pdf')).toBeVisible();
  await expect(page.getByText(/Retry|重试/).first()).toBeVisible();
  await expect(page.getByText(/refunded|已退款/).first()).toBeVisible();
});

test('上传 PDF → 报价确认 → confirm 请求发出', async ({ page }) => {
  await login(page);
  await page.goto('/translate?tab=doc');
  await expect(page.getByText(/Click or drop a PDF|点击或拖入 PDF/)).toBeVisible({
    timeout: 15_000,
  });

  // 通过隐藏 input 注入假 PDF（%PDF- 魔数由服务端校验，前端 mock 不管内容）
  await page.setInputFiles('input[type="file"]', {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 fake'),
  });

  // 报价弹窗：文件名 + 12 页 + ¥1.20
  await expect(page.getByText(/Confirm translation|确认翻译/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/12 pages|12 页/).first()).toBeVisible();
  await expect(page.getByText('¥1.20').first()).toBeVisible();

  await page.getByRole('button', { name: /Pay & translate|付费并翻译/ }).click();
  await expect(page.getByText(/Queued|排队中/).first()).toBeVisible({ timeout: 15_000 });
  expect(capturedConfirmId).toBe('task-q1');
});

test('站点/组关闭文档翻译时显示不可用文案', async ({ page }) => {
  docEnabled = false;
  await login(page);
  await page.goto('/translate?tab=doc');
  await expect(
    page.getByText(/Document translation is not available|当前账号不可使用文档翻译/)
  ).toBeVisible({ timeout: 15_000 });
});

test('免计费账号（管理员）：价格提示换成免费，报价弹窗不谈钱', async ({ page }) => {
  billingExempt = true;
  user.role = 'ADMIN';
  await login(page);

  // 文本 tab：只出免费提示，不出「每千字符 ¥x 扣费」
  await page.goto('/translate');
  await expect(
    page.getByText(/Administrator account · translation is free|管理员账号 · 翻译不计费/)
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/per 1,000 characters|每千字符/)).toHaveCount(0);

  // 文档 tab：单价提示换成免费，仍保留页数/体积上限
  await page.goto('/translate?tab=doc');
  await expect(
    page.getByText(/Free for admins · up to 300 pages|管理员免费 · 上限 300 页/)
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/\/page ·|\/页 ·/)).toHaveCount(0);

  // 报价弹窗：没有「费用/钱包余额」行，按钮不是「付费并翻译」
  await page.setInputFiles('input[type="file"]', {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 fake'),
  });
  await expect(page.getByText(/Confirm translation|确认翻译/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Administrator account — no charge|管理员账号不计费/)).toBeVisible();
  await expect(page.getByText(/wallet balance|钱包余额/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pay & translate|付费并翻译/ })).toHaveCount(0);

  await page.getByRole('button', { name: /Start translation|开始翻译/ }).click();
  await expect(page.getByText(/Queued|排队中/).first()).toBeVisible({ timeout: 15_000 });
  expect(capturedConfirmId).toBe('task-q1');
});
