import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * C02/P6-4：公开的 /api/setup 引导路由。
 *
 * 中间件整条放行这条路径（middleware.ts:142），此前唯一的门禁是 setup_complete 布尔
 * + 10 次/10 分钟限流，而完整接管只需要 3-4 个请求：建隐藏管理员 / 把 LLM 端点指向
 * 攻击者 / 把 Soniox 端点指向攻击者 / 抢先置位 setup_complete 把实例锁死。
 *
 * 这里 validateCloudreveBaseUrl 保持真实，验证的是真正的私网黑名单。
 */

const {
  userCountMock,
  userFindFirstMock,
  userCreateMock,
  siteSettingFindUniqueMock,
  siteSettingUpsertMock,
  siteSettingCreateMock,
  llmProviderCreateMock,
  transactionMock,
  enforceRateLimitMock,
  verifyAuthMock,
  prismaMock,
} = vi.hoisted(() => {
  const mocks = {
    userCountMock: vi.fn(),
    userFindFirstMock: vi.fn(),
    userCreateMock: vi.fn(),
    siteSettingFindUniqueMock: vi.fn(),
    siteSettingUpsertMock: vi.fn(),
    siteSettingCreateMock: vi.fn(),
    llmProviderCreateMock: vi.fn(),
    llmProviderCountMock: vi.fn(),
    transactionMock: vi.fn(),
    enforceRateLimitMock: vi.fn(),
    verifyAuthMock: vi.fn(),
  };
  return {
    ...mocks,
    prismaMock: {
      user: {
        count: mocks.userCountMock,
        findFirst: mocks.userFindFirstMock,
        create: mocks.userCreateMock,
      },
      siteSetting: {
        findUnique: mocks.siteSettingFindUniqueMock,
        upsert: mocks.siteSettingUpsertMock,
        create: mocks.siteSettingCreateMock,
      },
      llmProvider: {
        create: mocks.llmProviderCreateMock,
        count: mocks.llmProviderCountMock,
      },
      llmRegistryModel: { create: vi.fn() },
      llmModel: { create: vi.fn() },
      $queryRaw: vi.fn(async () => [{ 1: 1 }]),
      $transaction: mocks.transactionMock,
    },
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));

vi.mock('@/lib/crypto', () => ({ encrypt: (value: string) => `enc:${value}` }));

vi.mock('@/lib/siteSettings', () => ({ invalidateSiteSettingsCache: vi.fn() }));

vi.mock('@/lib/soniox/env', () => ({ invalidateSonioxDbConfigCache: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
  signToken: () => 'signed-token',
  setAuthCookie: (response: unknown) => response,
  CLIENT_SESSION_TOKEN: '__cookie_session__',
  validatePassword: () => null,
}));

import { GET, POST } from '@/app/api/setup/route';

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_BOOTSTRAP_TOKEN = process.env.SETUP_BOOTSTRAP_TOKEN;

/**
 * 新门禁（本轮修复）：首次部署匿名窗口只放行 step=database / step=admin，
 * llm / soniox / complete 一律要求「已登录 ADMIN」或引导密钥。
 * 那些只想验证 URL 校验/前置条件的用例，先把自己放进已授权上下文。
 */
function asLoggedInAdmin() {
  userCountMock.mockResolvedValue(1);
  verifyAuthMock.mockResolvedValue({ id: 'admin-1', email: 'a@b.c', role: 'ADMIN' });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SETUP_BOOTSTRAP_TOKEN;
  enforceRateLimitMock.mockResolvedValue(null);
  // setup_complete 未置位
  siteSettingFindUniqueMock.mockResolvedValue(null);
  // 全新库：还没有任何管理员
  userCountMock.mockResolvedValue(0);
  userFindFirstMock.mockResolvedValue(null);
  siteSettingCreateMock.mockResolvedValue({});
  siteSettingUpsertMock.mockResolvedValue({});
  llmProviderCreateMock.mockResolvedValue({ id: 'p1', name: 'openai' });
  userCreateMock.mockResolvedValue({
    id: 'admin-1',
    email: 'admin@example.com',
    displayName: 'Admin',
    role: 'ADMIN',
    tokenVersion: 0,
  });
  verifyAuthMock.mockResolvedValue(null);
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(prismaMock)
  );
});

afterEach(() => {
  if (ORIGINAL_BOOTSTRAP_TOKEN === undefined) delete process.env.SETUP_BOOTSTRAP_TOKEN;
  else process.env.SETUP_BOOTSTRAP_TOKEN = ORIGINAL_BOOTSTRAP_TOKEN;
});

describe('POST /api/setup —— 未认证引导窗口 (C02 / P6-4)', () => {
  it('全新库（零管理员）仍可匿名走 step=admin —— 真正的首次部署窗口不被堵死', async () => {
    const res = await POST(
      makeRequest({
        step: 'admin',
        email: 'admin@example.com',
        password: 'Abcd1234',
        displayName: 'Admin',
      })
    );
    expect(res.status).toBe(200);
    expect(userCreateMock).toHaveBeenCalledTimes(1);
  });

  it('已有管理员时，匿名调用 step=llm 被拒（403）', async () => {
    userCountMock.mockResolvedValue(1);

    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'evil', apiKey: 'k', apiBase: 'https://attacker.example.com' },
        ],
      })
    );

    expect(res.status).toBe(403);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
  });

  it('已有管理员时，匿名调用 step=complete 被拒 —— 不能抢先把实例锁死', async () => {
    userCountMock.mockResolvedValue(1);

    const res = await POST(makeRequest({ step: 'complete' }));

    expect(res.status).toBe(403);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('已有管理员且带管理员会话时放行（向导后续步骤照常）', async () => {
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue({
      id: 'admin-1',
      email: 'a@b.c',
      role: 'ADMIN',
    });

    const res = await POST(makeRequest({ step: 'complete' }));

    expect(res.status).toBe(200);
    expect(siteSettingUpsertMock).toHaveBeenCalled();
  });

  it('已有管理员但登录的是普通用户：仍拒（403）', async () => {
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue({ id: 'u1', email: 'u@b.c', role: 'PRO' });

    const res = await POST(makeRequest({ step: 'complete' }));
    expect(res.status).toBe(403);
  });

  it('配了 SETUP_BOOTSTRAP_TOKEN 时：不带/带错密钥一律 401，哪怕库是全新的', async () => {
    process.env.SETUP_BOOTSTRAP_TOKEN = 'super-secret-bootstrap-token';

    const missing = await POST(
      makeRequest({
        step: 'admin',
        email: 'a@b.c',
        password: 'Abcd1234',
        displayName: 'A',
      })
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(
      makeRequest(
        { step: 'admin', email: 'a@b.c', password: 'Abcd1234', displayName: 'A' },
        { 'x-setup-token': 'super-secret-bootstrap-tokeN' }
      )
    );
    expect(wrong.status).toBe(401);
    expect(userCreateMock).not.toHaveBeenCalled();
  });

  it('配了 SETUP_BOOTSTRAP_TOKEN 且密钥正确时放行', async () => {
    process.env.SETUP_BOOTSTRAP_TOKEN = 'super-secret-bootstrap-token';

    const res = await POST(
      makeRequest(
        { step: 'admin', email: 'a@b.c', password: 'Abcd1234', displayName: 'A' },
        { 'x-setup-token': 'super-secret-bootstrap-token' }
      )
    );
    expect(res.status).toBe(200);
  });

  it('配了 SETUP_BOOTSTRAP_TOKEN 也不锁死管理员：已登录 ADMIN 无需带密钥', async () => {
    // 两条通行证是「或」的关系——否则运维一配密钥，浏览器里的向导（不会带这个 header）
    // 就整条走不通了。
    process.env.SETUP_BOOTSTRAP_TOKEN = 'super-secret-bootstrap-token';
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue({
      id: 'admin-1',
      email: 'a@b.c',
      role: 'ADMIN',
    });

    const res = await POST(makeRequest({ step: 'complete' }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/setup step=admin —— 首个管理员的并发抢占 (C02 / P6-4)', () => {
  it('创建走事务，并先对 setup_admin_claimed 做唯一键 CAS 抢占', async () => {
    await POST(
      makeRequest({
        step: 'admin',
        email: 'admin@example.com',
        password: 'Abcd1234',
        displayName: 'Admin',
      })
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(siteSettingCreateMock).toHaveBeenCalledWith({
      data: { key: 'setup_admin_claimed', value: 'true' },
    });
  });

  it('CAS 抢占失败（并发的另一个请求已认领）→ 409，不建第二个管理员', async () => {
    siteSettingCreateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['key'] },
      })
    );

    const res = await POST(
      makeRequest({
        step: 'admin',
        email: 'admin@example.com',
        password: 'Abcd1234',
        displayName: 'Admin',
      })
    );

    expect(res.status).toBe(409);
    expect(userCreateMock).not.toHaveBeenCalled();
  });

  it('存量库（已有管理员但没有 CAS 行）仍按老口径 409', async () => {
    userFindFirstMock.mockResolvedValue({ id: 'existing-admin' });

    const res = await POST(
      makeRequest({
        step: 'admin',
        email: 'admin@example.com',
        password: 'Abcd1234',
        displayName: 'Admin',
      })
    );

    expect(res.status).toBe(409);
    expect(userCreateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/setup —— 出站地址校验 (C02 / P6-4)', () => {
  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:8080/v1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:3000',
    'not-a-url',
  ])('step=llm 拒绝内网/非法 apiBase: %s', async (apiBase) => {
    asLoggedInAdmin();
    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [{ name: 'x', apiKey: 'k', apiBase }],
      })
    );

    expect(res.status).toBe(400);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
  });

  it('step=llm 接受正常的公网 apiBase', async () => {
    asLoggedInAdmin();
    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
        ],
      })
    );

    expect(res.status).toBe(200);
    expect(llmProviderCreateMock).toHaveBeenCalledTimes(1);
    expect(llmProviderCreateMock.mock.calls[0][0].data.apiBase).toBe(
      'https://api.openai.com/v1'
    );
  });

  it('step=soniox 拒绝内网 wsUrl，且一个字段都不落库', async () => {
    asLoggedInAdmin();
    const res = await POST(
      makeRequest({
        step: 'soniox',
        regions: {
          us: { apiKey: 'k', wsUrl: 'ws://127.0.0.1:9999', restUrl: 'https://api.soniox.com' },
        },
      })
    );

    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('step=soniox 拒绝内网 restUrl', async () => {
    asLoggedInAdmin();
    const res = await POST(
      makeRequest({
        step: 'soniox',
        regions: {
          us: { apiKey: 'k', restUrl: 'http://192.168.1.10:8000' },
        },
      })
    );

    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('step=soniox 接受正常的公网地址', async () => {
    asLoggedInAdmin();
    const res = await POST(
      makeRequest({
        step: 'soniox',
        regions: {
          us: {
            apiKey: 'k',
            wsUrl: 'wss://stt-rt.soniox.com/transcribe-websocket',
            restUrl: 'https://api.soniox.com',
          },
        },
        defaultRegion: 'us',
      })
    );

    expect(res.status).toBe(200);
    expect(siteSettingUpsertMock).toHaveBeenCalled();
  });
});

describe('POST /api/setup step=complete —— 前置条件 (C02 / P6-4)', () => {
  it('零管理员时拒绝置位 setup_complete（否则实例被匿名锁死，只能连库恢复）', async () => {
    // 新门禁下匿名者连 step=complete 都进不来（403），所以这里用引导密钥
    // 把自己放进「已授权但库里还没有管理员」的状态，才验得到 handleCompleteSetup 的前置条件。
    process.env.SETUP_BOOTSTRAP_TOKEN = 'super-secret-bootstrap-token';
    userCountMock.mockResolvedValue(0);

    const res = await POST(
      makeRequest(
        { step: 'complete' },
        { 'x-setup-token': 'super-secret-bootstrap-token' }
      )
    );

    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  ★ 报告漏掉的真洞：首次部署匿名窗口对所有 step 放行                     */
/* ------------------------------------------------------------------ */

describe('POST /api/setup —— 匿名窗口只放行 database / admin（★）', () => {
  /**
   * `requireSetupAuthorization` 的注释白纸黑字写着「只剩 step=admin 一条路径」，
   * 但代码是 `if (adminCount === 0) { if (!bootstrapToken) return null; }` ——
   * 对**所有** step 放行，POST 的 switch 里也没有任何按 step 的二次限制。
   * 于是首次部署窗口内匿名者可以直接 step=llm 把 LLM provider 指到自己的服务器
   * （用户 prompt 与转录持续外发 / SSRF），或 step=soniox 换掉实时转录端点。
   */
  it('零管理员 + 无引导密钥：匿名 step=llm 被拒，且一行都不落库', async () => {
    userCountMock.mockResolvedValue(0);

    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'evil', apiKey: 'k', apiBase: 'https://attacker.example.com' },
        ],
      })
    );

    expect(res.status).toBe(403);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
  });

  it('零管理员 + 无引导密钥：匿名 step=soniox 被拒，且一行都不落库', async () => {
    userCountMock.mockResolvedValue(0);

    const res = await POST(
      makeRequest({
        step: 'soniox',
        regions: {
          us: { apiKey: 'k', wsUrl: 'wss://attacker.example.com/ws' },
        },
      })
    );

    expect(res.status).toBe(403);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('零管理员 + 无引导密钥：匿名 step=complete 被拒', async () => {
    userCountMock.mockResolvedValue(0);

    const res = await POST(makeRequest({ step: 'complete' }));

    expect(res.status).toBe(403);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('真正的首次部署路径没被堵死：匿名 step=database / step=admin 仍可用', async () => {
    userCountMock.mockResolvedValue(0);

    const dbRes = await POST(makeRequest({ step: 'database' }));
    expect(dbRes.status).toBe(200);

    const adminRes = await POST(
      makeRequest({
        step: 'admin',
        email: 'admin@example.com',
        password: 'Abcd1234',
        displayName: 'Admin',
      })
    );
    expect(adminRes.status).toBe(200);
    expect(userCreateMock).toHaveBeenCalledTimes(1);
  });

  it('建完管理员后向导后续步骤照常（已登录 ADMIN）', async () => {
    asLoggedInAdmin();

    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
        ],
      })
    );

    expect(res.status).toBe(200);
    expect(llmProviderCreateMock).toHaveBeenCalledTimes(1);
  });

  it('带正确引导密钥时，运维可以直接跑 llm / soniox（无人可登录的自动化部署）', async () => {
    process.env.SETUP_BOOTSTRAP_TOKEN = 'super-secret-bootstrap-token';
    userCountMock.mockResolvedValue(0);

    const res = await POST(
      makeRequest(
        {
          step: 'llm',
          providers: [
            { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
          ],
        },
        { 'x-setup-token': 'super-secret-bootstrap-token' }
      )
    );

    expect(res.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/*  L53 / L54                                                          */
/* ------------------------------------------------------------------ */

describe('POST /api/setup —— 输入与事务 (L53 / L54)', () => {
  it('L53：畸形 JSON 返回 400 而不是框架默认 500', async () => {
    const res = await POST(
      new Request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      })
    );

    expect(res.status).toBe(400);
  });

  it('L53：JSON 数组/标量也按 400 处理', async () => {
    const res = await POST(
      new Request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[1,2,3]',
      })
    );

    expect(res.status).toBe(400);
  });

  it('L54：LLM 配置整段跑在一个事务里（中途失败不留半成品）', async () => {
    asLoggedInAdmin();
    transactionMock.mockClear();

    await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
          { name: 'claude', apiKey: 'k2', apiBase: 'https://api.anthropic.com' },
        ],
      })
    );

    // 两个供应商共用**一个**事务
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(llmProviderCreateMock).toHaveBeenCalledTimes(2);
  });

  it('L54：第二个供应商地址非法时，第一个也不会被写进去', async () => {
    asLoggedInAdmin();
    llmProviderCreateMock.mockClear();

    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
          { name: 'evil', apiKey: 'k2', apiBase: 'http://127.0.0.1:11434' },
        ],
      })
    );

    expect(res.status).toBe(400);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  M24（降级为 low）+ L55                                              */
/* ------------------------------------------------------------------ */

describe('GET /api/setup —— 无写副作用 + 收窄披露面 (M24 / L55)', () => {
  it('M24：GET 不再 upsert setup_complete（读接口不该有写副作用）', async () => {
    // db + admin + llm + soniox 全就绪、但 setup_complete 未置位
    userCountMock.mockResolvedValue(1);
    prismaMock.llmProvider.count.mockResolvedValue(1);
    siteSettingFindUniqueMock.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'soniox_configured' ? { value: 'true' } : null
    );
    verifyAuthMock.mockResolvedValue({ id: 'admin-1', email: 'a@b.c', role: 'ADMIN' });
    siteSettingUpsertMock.mockClear();

    const res = await GET(new Request('http://localhost/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.setupComplete).toBe(true);
    // 关键：一次写都没有发生
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('L55：已完成设置时只回 setupComplete，不再吐四个部署状态布尔', async () => {
    siteSettingFindUniqueMock.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'setup_complete' ? { value: 'true' } : null
    );

    const res = await GET(new Request('http://localhost/api/setup'));
    const body = await res.json();

    expect(body).toEqual({ setupComplete: true });
    expect(body.steps).toBeUndefined();
  });

  it('L55：已有管理员但调用方匿名时，不下发 steps 明细', async () => {
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost/api/setup'));
    const body = await res.json();

    expect(body.setupComplete).toBe(false);
    expect(body.steps).toBeUndefined();
  });

  it('L55：真正的首次部署窗口（零管理员）仍然给明细，向导不被堵死', async () => {
    userCountMock.mockResolvedValue(0);
    verifyAuthMock.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost/api/setup'));
    const body = await res.json();

    expect(body.setupComplete).toBe(false);
    expect(body.steps).toBeDefined();
    expect(body.steps.admin).toBe(false);
  });

  it('L55：已登录 ADMIN 照常拿到明细', async () => {
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue({ id: 'admin-1', email: 'a@b.c', role: 'ADMIN' });

    const res = await GET(new Request('http://localhost/api/setup'));
    const body = await res.json();

    expect(body.steps).toBeDefined();
    expect(body.steps.admin).toBe(true);
  });
});

describe('POST /api/setup step=admin —— displayName 归一化 (L7)', () => {
  it('trim + 截断到 64 字符', async () => {
    userCountMock.mockResolvedValue(0);
    userCreateMock.mockClear();

    await POST(
      makeRequest({
        step: 'admin',
        email: 'admin@example.com',
        password: 'Abcd1234',
        displayName: `   ${'A'.repeat(500)}   `,
      })
    );

    const created = userCreateMock.mock.calls[0][0].data.displayName as string;
    expect(created).toBe('A'.repeat(64));
  });

  it('只有空白的 displayName 视为缺失', async () => {
    userCountMock.mockResolvedValue(0);
    userCreateMock.mockClear();

    const res = await POST(
      makeRequest({
        step: 'admin',
        email: 'admin@example.com',
        password: 'Abcd1234',
        displayName: '    ',
      })
    );

    expect(res.status).toBe(400);
    expect(userCreateMock).not.toHaveBeenCalled();
  });
});
