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

import { POST } from '@/app/api/setup/route';

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_BOOTSTRAP_TOKEN = process.env.SETUP_BOOTSTRAP_TOKEN;

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
    userCountMock.mockResolvedValue(0);

    const res = await POST(makeRequest({ step: 'complete' }));

    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });
});
