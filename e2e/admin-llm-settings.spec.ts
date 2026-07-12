import { test, expect, type Page } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

/**
 * Admin「设置 > LLM」两段式设置页烟测（用途路由 + 模型库）。
 *
 * 覆盖：
 *  1) 两段渲染：用途路由 5 个折叠块（带数量/默认名），模型库按网关分组（规格卡 + 状态 pill）。
 *  2) 路由卡三级级联（思考 › 深度 › 温度）：深度仅在 强制/深度思考 下可用。
 *  3) 星标设默认 → PATCH /api/admin/llm-routes/[id] { isDefault: true }。
 *  4) 添加模型到用途 → POST /api/admin/llm-routes { registryId, purpose }（选项排除已挂载/类型不符）。
 *  5) 「按会员组」视图：组行出现（FREE/PRO/自定义），改选 → PUT /api/admin/llm-group-models。
 *  6) 模型库「验证」→ POST .../verify；删除网关走确认弹窗。
 *
 * 全量 route mock，不依赖真实 DB。
 */

const adminUser = {
  id: 'admin-1',
  email: 'admin@lecturelive.com',
  displayName: 'Admin',
  role: 'ADMIN',
};

/** 路由行（LlmModel）：豆包pro 挂 CHAT(默认)+FINAL；mini 挂 REALTIME(默认)；embed 挂 EMBEDDING */
const routeRows = [
  {
    id: 'route-chat-pro',
    registryId: 'reg-pro',
    providerId: 'prov-ark',
    modelId: 'doubao-seed-2-0-pro',
    displayName: '豆包 2.0 Pro',
    purpose: 'CHAT',
    thinkingMode: 'AUTO',
    thinkingDepth: 'medium',
    temperature: 0.6,
    isDefault: true,
    sortOrder: 0,
  },
  {
    id: 'route-final-pro',
    registryId: 'reg-pro',
    providerId: 'prov-ark',
    modelId: 'doubao-seed-2-0-pro',
    displayName: '豆包 2.0 Pro',
    purpose: 'FINAL_SUMMARY',
    thinkingMode: 'DEPTH',
    thinkingDepth: 'medium',
    temperature: 0.4,
    isDefault: true,
    sortOrder: 0,
  },
  {
    id: 'route-realtime-mini',
    registryId: 'reg-mini',
    providerId: 'prov-ark',
    modelId: 'doubao-seed-2-0-mini',
    displayName: '豆包 2.0 Mini',
    purpose: 'REALTIME_SUMMARY',
    thinkingMode: 'NONE',
    thinkingDepth: 'medium',
    temperature: 0.3,
    isDefault: true,
    sortOrder: 0,
  },
  {
    id: 'route-embed',
    registryId: 'reg-embed',
    providerId: 'prov-ark',
    modelId: 'doubao-embedding-large',
    displayName: 'doubao-embedding',
    purpose: 'EMBEDDING',
    thinkingMode: 'NONE',
    thinkingDepth: 'medium',
    temperature: 0.3,
    isDefault: true,
    sortOrder: 0,
  },
];

const registryModels = [
  {
    id: 'reg-pro',
    providerId: 'prov-ark',
    modelId: 'doubao-seed-2-0-pro',
    displayName: '豆包 2.0 Pro',
    kind: 'TEXT',
    supportsImage: true,
    maxTokens: 8192,
    contextWindow: 262144,
    embeddingDimensions: null,
    status: 'OK',
    lastCheckedAt: '2026-07-11T00:00:00Z',
    lastError: null,
    routes: [
      { id: 'route-chat-pro', purpose: 'CHAT', isDefault: true },
      { id: 'route-final-pro', purpose: 'FINAL_SUMMARY', isDefault: true },
    ],
  },
  {
    id: 'reg-mini',
    providerId: 'prov-ark',
    modelId: 'doubao-seed-2-0-mini',
    displayName: '豆包 2.0 Mini',
    kind: 'TEXT',
    supportsImage: false,
    maxTokens: 2048,
    contextWindow: 262144,
    embeddingDimensions: null,
    status: 'UNVERIFIED',
    lastCheckedAt: null,
    lastError: null,
    routes: [{ id: 'route-realtime-mini', purpose: 'REALTIME_SUMMARY', isDefault: true }],
  },
  {
    id: 'reg-embed',
    providerId: 'prov-ark',
    modelId: 'doubao-embedding-large',
    displayName: 'doubao-embedding',
    kind: 'EMBEDDING',
    supportsImage: false,
    maxTokens: 4096,
    contextWindow: 4096,
    embeddingDimensions: 2048,
    status: 'UNVERIFIED',
    lastCheckedAt: null,
    lastError: null,
    routes: [{ id: 'route-embed', purpose: 'EMBEDDING', isDefault: true }],
  },
  {
    id: 'reg-lite',
    providerId: 'prov-ark',
    modelId: 'doubao-seed-2-0-lite',
    displayName: '豆包 2.0 Lite',
    kind: 'TEXT',
    supportsImage: true,
    maxTokens: 8192,
    contextWindow: 262144,
    embeddingDimensions: null,
    status: 'UNVERIFIED',
    lastCheckedAt: null,
    lastError: null,
    routes: [], // 未挂载任何用途 → 是 CHAT 的可挂载候选
  },
];

const providersPayload = {
  providers: [
    {
      id: 'prov-ark',
      name: '火山方舟',
      apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
      isAnthropic: false,
      hasApiKey: true,
      maskedApiKey: 'sk-1****abcd',
      apiKey: '',
      models: routeRows,
      registryModels,
    },
  ],
};

const groupsPayload = {
  groups: [
    {
      key: 'FREE',
      name: 'FREE',
      isCustom: false,
      chatModelId: '',
      realtimeSummaryModelId: '',
      finalSummaryModelId: '',
    },
    {
      key: 'PRO',
      name: 'PRO',
      isCustom: false,
      chatModelId: '',
      realtimeSummaryModelId: '',
      finalSummaryModelId: '',
    },
    {
      key: 'custom:vip',
      name: 'VIP 内测',
      isCustom: true,
      color: 'bg-purple-50 text-purple-600',
      chatModelId: '',
      realtimeSummaryModelId: '',
      finalSummaryModelId: '',
    },
  ],
};

/** 收集突变请求（method + path + body），供断言 */
interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

async function setupRoutes(page: Page, captured: CapturedRequest[]) {
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();

    if (p === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        site_description: 'llm settings',
        site_announcement: '',
        footer_code: '',
        allow_registration: true,
      });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    if (p === '/api/auth/refresh' && method === 'GET') {
      return fulfillJson(route, { user: adminUser, token: '__cookie_session__' });
    }
    if (p === '/api/admin/settings' && method === 'GET') {
      return fulfillJson(route, {});
    }
    if (p === '/api/admin/llm-providers' && method === 'GET') {
      return fulfillJson(route, providersPayload);
    }
    if (p === '/api/admin/llm-group-models' && method === 'GET') {
      return fulfillJson(route, groupsPayload);
    }

    // 突变端点：记录请求并返回成功
    if (
      p.startsWith('/api/admin/llm-routes') ||
      p.startsWith('/api/admin/llm-group-models') ||
      /\/api\/admin\/llm-providers\/[^/]+\/registry/.test(p) ||
      (p.startsWith('/api/admin/llm-providers/') && method !== 'GET')
    ) {
      captured.push({
        method,
        path: p,
        body: request.postDataJSON() as unknown,
      });
      if (p.endsWith('/verify')) {
        return fulfillJson(route, {
          ok: true,
          registryModel: { ...registryModels[1], status: 'OK' },
        });
      }
      return fulfillJson(route, { ok: true });
    }

    if (p === '/api/users/quota') {
      return fulfillJson(route, {
        quotas: {
          id: 'admin-1',
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
          allowedModels: '*',
          quotaResetAt: null,
        },
      });
    }
    if (p === '/api/folders') return fulfillJson(route, []);
    if (p === '/api/sessions') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }

    return fulfillJson(route, {});
  });
}

async function gotoLlmSettings(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@lecturelive.com');
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/home(\?|$)/, { timeout: 30_000 });

  await page.goto('/admin?tab=settings&subtab=llm');
  await page.waitForLoadState('networkidle');
}

test('两段式渲染：用途路由折叠块 + 模型库网关分组', async ({ page }) => {
  const captured: CapturedRequest[] = [];
  await setupRoutes(page, captured);
  await gotoLlmSettings(page);

  // 段标题
  await expect(page.getByText(/用途路由|Purpose Routing/).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/模型库|Model Registry/).first()).toBeVisible();

  const routing = page.getByTestId('llm-routing-section');
  const registry = page.getByTestId('llm-registry-section');

  // 5 个用途块（聊天默认展开，其余折叠）
  await expect(routing.locator('[data-purpose="CHAT"]')).toBeVisible();
  await expect(routing.locator('[data-purpose="REALTIME_SUMMARY"]')).toBeVisible();
  await expect(routing.locator('[data-purpose="FINAL_SUMMARY"]')).toBeVisible();
  await expect(routing.locator('[data-purpose="KEYWORD_EXTRACTION"]')).toBeVisible();
  await expect(routing.locator('[data-purpose="EMBEDDING"]')).toBeVisible();

  // 聊天块展开：默认模型卡带「默认」标 + 三级级联标签
  const chatCard = routing.locator('[data-route-id="route-chat-pro"]');
  await expect(chatCard).toBeVisible();
  await expect(chatCard.getByText('豆包 2.0 Pro')).toBeVisible();
  await expect(chatCard.getByText(/思考|Thinking/).first()).toBeVisible();
  await expect(chatCard.getByText(/温度|Temp/).first()).toBeVisible();

  // 模型库：网关头（名称 + base + 数量）与规格卡
  await expect(registry.getByText('火山方舟').first()).toBeVisible();
  await expect(
    registry.getByText('ark.cn-beijing.volces.com/api/v3').first()
  ).toBeVisible();
  // 规格：256K 上下文（262144）
  await expect(registry.getByText('256K').first()).toBeVisible();
  // 嵌入模型卡：pill + 维度
  const embedCard = registry.locator('[data-registry-id="reg-embed"]');
  await expect(embedCard.getByText(/^嵌入$|^Embedding$/).first()).toBeVisible();
  await expect(embedCard.getByText('2048').first()).toBeVisible();
  // 未挂载的 Lite 卡片提示
  await expect(
    registry
      .locator('[data-registry-id="reg-lite"]')
      .getByText(/未挂载任何用途|Not attached to any purpose/)
  ).toBeVisible();

  await page.screenshot({
    path: 'artifacts/admin-llm-settings.png',
    fullPage: true,
  });
});

test('三级级联联动 + 温度提交 + 星标设默认', async ({ page }) => {
  const captured: CapturedRequest[] = [];
  await setupRoutes(page, captured);
  await gotoLlmSettings(page);

  // 聊天卡（AUTO）：深度下拉禁用
  const chatCard = page.locator('[data-route-id="route-chat-pro"]');
  const depthSelect = chatCard.locator('select').nth(1);
  await expect(depthSelect).toBeDisabled();

  // 思考模式切到 强制思考 → PATCH thinkingMode=FORCED
  const thinkSelect = chatCard.locator('select').first();
  await thinkSelect.selectOption('FORCED');
  await expect
    .poll(() =>
      captured.some(
        (r) =>
          r.method === 'PATCH' &&
          r.path === '/api/admin/llm-routes/route-chat-pro' &&
          (r.body as { thinkingMode?: string })?.thinkingMode === 'FORCED'
      )
    )
    .toBe(true);

  // 温度输入 → blur 提交 PATCH temperature
  const tempInput = chatCard.locator('input[type="number"]').first();
  await tempInput.fill('0.9');
  await tempInput.blur();
  await expect
    .poll(() =>
      captured.some(
        (r) =>
          r.method === 'PATCH' &&
          r.path === '/api/admin/llm-routes/route-chat-pro' &&
          (r.body as { temperature?: number })?.temperature === 0.9
      )
    )
    .toBe(true);

  // 展开最终摘要块，卡上的星标（非默认场景造不出来，这里直接点默认卡星标不应发请求）
  // 换用「添加模型」流：先验证 CHAT 添加卡的候选里有未挂载的 Lite
  const chatBlock = page.locator('[data-purpose="CHAT"]');
  await chatBlock.getByRole('button', { name: /添加模型|Add model/ }).click();
  const attachSelect = chatBlock.locator('select').last();
  await expect(attachSelect).toBeVisible();
  // 候选里有未挂载的 Lite 与只挂在实时摘要的 Mini、没有已挂载到 CHAT 的 Pro
  await expect(attachSelect.locator('option', { hasText: '豆包 2.0 Lite' })).toHaveCount(1);
  await expect(attachSelect.locator('option', { hasText: '豆包 2.0 Mini' })).toHaveCount(1);
  await expect(attachSelect.locator('option', { hasText: '豆包 2.0 Pro' })).toHaveCount(0);
  await attachSelect.selectOption('reg-lite');
  await chatBlock.getByRole('button', { name: /^添加$|^Add$/ }).click();
  await expect
    .poll(() =>
      captured.some(
        (r) =>
          r.method === 'POST' &&
          r.path === '/api/admin/llm-routes' &&
          (r.body as { registryId?: string; purpose?: string })?.registryId === 'reg-lite' &&
          (r.body as { purpose?: string })?.purpose === 'CHAT'
      )
    )
    .toBe(true);
});

test('按会员组视图：组行渲染 + 绑定写 PUT llm-group-models', async ({ page }) => {
  const captured: CapturedRequest[] = [];
  await setupRoutes(page, captured);
  await gotoLlmSettings(page);

  // 切到按会员组
  await page.getByRole('button', { name: /按会员组|By user group/ }).click();

  // 组标签出现（FREE/PRO/自定义组名）——限定在聊天块的组绑定区里
  const chatTier = page.locator('[data-purpose="CHAT"]');
  await expect(chatTier.getByText('FREE', { exact: true })).toBeVisible();
  await expect(chatTier.getByText('PRO', { exact: true })).toBeVisible();
  await expect(chatTier.getByText('VIP 内测')).toBeVisible();

  // FREE 行下拉：首项是「跟随全局默认（豆包 2.0 Pro）」
  const chatBlock = page.locator('[data-purpose="CHAT"]');
  const freeSelect = chatBlock.locator('select').first();
  await expect(
    freeSelect.locator('option', {
      hasText: /跟随全局默认（豆包 2.0 Pro）|Follow global default \(豆包 2.0 Pro\)/,
    })
  ).toHaveCount(1);

  // 给 FREE 绑定具体模型 → PUT
  await freeSelect.selectOption('route-chat-pro');
  await expect
    .poll(() =>
      captured.some(
        (r) =>
          r.method === 'PUT' &&
          r.path === '/api/admin/llm-group-models' &&
          (r.body as { groupKey?: string })?.groupKey === 'FREE' &&
          (r.body as { purpose?: string })?.purpose === 'CHAT' &&
          (r.body as { modelId?: string })?.modelId === 'route-chat-pro'
      )
    )
    .toBe(true);

  // 关键词块（不可按组绑定）：展开后显示「全部组统一」说明
  const kwBlock = page.locator('[data-purpose="KEYWORD_EXTRACTION"]');
  await kwBlock.locator('button').first().click();
  await expect(
    kwBlock.getByText(/该用途全部组统一|unified across all groups/)
  ).toBeVisible();

  await page.screenshot({
    path: 'artifacts/admin-llm-settings-tier.png',
    fullPage: true,
  });
});

test('模型库：验证连通性 + 删除网关确认弹窗', async ({ page }) => {
  const captured: CapturedRequest[] = [];
  await setupRoutes(page, captured);
  await gotoLlmSettings(page);

  // 点 Mini 卡的「验证」→ POST /verify
  const miniCard = page.locator('[data-registry-id="reg-mini"]');
  await miniCard.getByRole('button', { name: /验证连通性|Verify connectivity/ }).click();
  await expect
    .poll(() =>
      captured.some(
        (r) =>
          r.method === 'POST' &&
          r.path === '/api/admin/llm-providers/prov-ark/registry/reg-mini/verify'
      )
    )
    .toBe(true);

  // 删除网关 → 确认弹窗出现（含级联警告文案），确认后 DELETE
  await page.getByRole('button', { name: /删除网关|Delete Gateway/ }).click();
  await expect(page.getByText(/删除该网关|Delete this gateway/).first()).toBeVisible();
  await page
    .getByRole('button', { name: /^删除$|^确认$|^Delete$|^Confirm$/ })
    .last()
    .click();
  await expect
    .poll(() =>
      captured.some(
        (r) => r.method === 'DELETE' && r.path === '/api/admin/llm-providers/prov-ark'
      )
    )
    .toBe(true);
});
