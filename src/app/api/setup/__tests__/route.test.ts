import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * C02/P6-4：公开的 /api/setup 引导路由。
 *
 * 中间件整条放行这条路径（middleware.ts:142），此前唯一的门禁是 setup_complete 布尔
 * + 10 次/10 分钟限流，而完整接管只需要 3-4 个请求：建隐藏管理员 / 把 LLM 端点指向
 * 攻击者 / 把 Soniox 端点指向攻击者 / 抢先置位 setup_complete 把实例锁死。
 *
 * 这里 LLM 出站策略保持真实，验证 setup 不会成为 SSRF 旁路。
 */

const {
  userCountMock,
  userFindFirstMock,
  userCreateMock,
  siteSettingFindUniqueMock,
  siteSettingUpsertMock,
  siteSettingCreateMock,
  llmProviderCreateMock,
  llmProviderCountMock,
  transactionMock,
  enforceRateLimitMock,
  verifyAuthMock,
  dnsLookupMock,
  llmReauthMock,
  llmSecurityAuditMock,
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
    dnsLookupMock: vi.fn(),
    llmReauthMock: vi.fn(),
    llmSecurityAuditMock: vi.fn(),
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

vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));
vi.mock('@/lib/llm/adminReauth', () => ({
  requireLlmAdminCurrentPassword: llmReauthMock,
}));
vi.mock('@/lib/llm/securityAudit', () => ({
  writeLlmSecurityAudit: llmSecurityAuditMock,
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));

vi.mock('@/lib/crypto', () => ({ encrypt: (value: string) => `enc:${value}` }));

vi.mock('@/lib/siteSettings', () => ({ invalidateSiteSettingsCache: vi.fn() }));

vi.mock('@/lib/soniox/env', () => ({ invalidateSonioxDbConfigCache: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
  getAuthTokenSessionBinding: () => 'binding-setup',
  issueAuthToken: async () => 'signed-token',
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

const BOOTSTRAP_TOKEN = 'test-bootstrap-token-32-bytes-minimum-value';
const ORIGINAL_BOOTSTRAP_TOKEN = process.env.SETUP_BOOTSTRAP_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SETUP_BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN;
  dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  llmReauthMock.mockResolvedValue({ ok: true });
  llmSecurityAuditMock.mockResolvedValue(undefined);
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
  it('跨源 text/plain bootstrap 请求在任何 DB/认领前拒绝且不写 cookie', async () => {
    const res = await POST(
      new Request('https://app.example/api/setup', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'same-site',
          'Content-Type': 'text/plain',
          'x-setup-token': BOOTSTRAP_TOKEN,
        },
        body: JSON.stringify({
          step: 'admin',
          email: 'attacker@example.com',
          password: 'Abcd1234',
          displayName: 'Attacker',
        }),
      })
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('clear-site-data')).toBeNull();
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(userCreateMock).not.toHaveBeenCalled();
  });

  it('全新库（零管理员）只有正确 bootstrap token 才可走 step=admin', async () => {
    const res = await POST(
      makeRequest(
        {
          step: 'admin',
          email: 'admin@example.com',
          password: 'Abcd1234',
          displayName: 'Admin',
        },
        { 'x-setup-token': BOOTSTRAP_TOKEN }
      )
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

  it('不带/带错密钥一律 401，哪怕库是全新的', async () => {
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
        { 'x-setup-token': `${BOOTSTRAP_TOKEN}x` }
      )
    );
    expect(wrong.status).toBe(401);
    expect(userCreateMock).not.toHaveBeenCalled();
  });

  it('缺少或弱 SETUP_BOOTSTRAP_TOKEN 时 fail-closed（503）', async () => {
    delete process.env.SETUP_BOOTSTRAP_TOKEN;
    const missing = await POST(
      makeRequest(
        { step: 'admin', email: 'a@b.c', password: 'Abcd1234', displayName: 'A' },
        { 'x-setup-token': BOOTSTRAP_TOKEN }
      )
    );
    expect(missing.status).toBe(503);

    process.env.SETUP_BOOTSTRAP_TOKEN = 'too-short';
    const weak = await POST(
      makeRequest(
        { step: 'admin', email: 'a@b.c', password: 'Abcd1234', displayName: 'A' },
        { 'x-setup-token': 'too-short' }
      )
    );
    expect(weak.status).toBe(503);
    expect(userCreateMock).not.toHaveBeenCalled();
  });

  it('SETUP_BOOTSTRAP_TOKEN 正确时放行首管认领', async () => {
    const res = await POST(
      makeRequest(
        { step: 'admin', email: 'a@b.c', password: 'Abcd1234', displayName: 'A' },
        { 'x-setup-token': BOOTSTRAP_TOKEN }
      )
    );
    expect(res.status).toBe(200);
  });

  it('首管存在后，已登录 ADMIN 无需带 bootstrap token', async () => {
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue({
      id: 'admin-1',
      email: 'a@b.c',
      role: 'ADMIN',
    });

    const res = await POST(makeRequest({ step: 'complete' }));
    expect(res.status).toBe(200);
  });

  it('首管存在后 bootstrap token 永久失效，不能替代 ADMIN 会话', async () => {
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue(null);

    const res = await POST(
      makeRequest(
        {
          step: 'llm',
          providers: [
            { name: 'evil', apiKey: 'k', apiBase: 'https://attacker.example.com' },
          ],
        },
        { 'x-setup-token': BOOTSTRAP_TOKEN }
      )
    );

    expect(res.status).toBe(403);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
  });

  it.each(['database', 'llm', 'soniox', 'complete'])(
    'bootstrap token 不能执行非 admin 步骤: %s',
    async (step) => {
      const res = await POST(
        makeRequest({ step }, { 'x-setup-token': BOOTSTRAP_TOKEN })
      );

      expect(res.status).toBe(403);
      expect(llmProviderCreateMock).not.toHaveBeenCalled();
      expect(siteSettingUpsertMock).not.toHaveBeenCalled();
    }
  );
});

describe('GET /api/setup —— 只读状态', () => {
  it('即使 admin/LLM/Soniox 都就绪也不隐式写 setup_complete', async () => {
    userCountMock.mockResolvedValue(1);
    llmProviderCountMock.mockResolvedValue(1);
    siteSettingFindUniqueMock.mockImplementation(
      async ({ where }: { where: { key: string } }) =>
        where.key === 'soniox_configured' ? { value: 'true' } : null
    );

    const response = await GET(new Request('http://localhost/api/setup'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      setupComplete: false,
      steps: { admin: true, llm: true, soniox: true },
    });
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/setup step=admin —— 首个管理员的并发抢占 (C02 / P6-4)', () => {
  it('创建走事务，并先对 setup_admin_claimed 做唯一键 CAS 抢占', async () => {
    await POST(
      makeRequest(
        {
          step: 'admin',
          email: 'admin@example.com',
          password: 'Abcd1234',
          displayName: 'Admin',
        },
        { 'x-setup-token': BOOTSTRAP_TOKEN }
      )
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
      makeRequest(
        {
          step: 'admin',
          email: 'admin@example.com',
          password: 'Abcd1234',
          displayName: 'Admin',
        },
        { 'x-setup-token': BOOTSTRAP_TOKEN }
      )
    );

    expect(res.status).toBe(409);
    expect(userCreateMock).not.toHaveBeenCalled();
  });

  it('存量库（已有管理员但没有 CAS 行）仍按老口径 409', async () => {
    userFindFirstMock.mockResolvedValue({ id: 'existing-admin' });

    const res = await POST(
      makeRequest(
        {
          step: 'admin',
          email: 'admin@example.com',
          password: 'Abcd1234',
          displayName: 'Admin',
        },
        { 'x-setup-token': BOOTSTRAP_TOKEN }
      )
    );

    expect(res.status).toBe(409);
    expect(userCreateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/setup —— LLM 出站策略 (SEC-034)', () => {
  beforeEach(() => {
    userCountMock.mockResolvedValue(1);
    verifyAuthMock.mockResolvedValue({
      id: 'admin-1',
      email: 'a@b.c',
      role: 'ADMIN',
    });
  });

  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:8080/v1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:3000',
    'not-a-url',
  ])('step=llm 拒绝内网/回环/元数据/非法 apiBase: %s', async (apiBase) => {
    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [{ name: 'x', apiKey: 'k', apiBase }],
      })
    );

    expect(res.status).toBe(400);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
    expect(llmReauthMock).not.toHaveBeenCalled();
    expect(llmSecurityAuditMock).toHaveBeenCalledTimes(1);
  });

  it('step=llm 接受正常的公网 apiBase', async () => {
    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
        ],
        currentPassword: 'admin-password',
      })
    );

    expect(res.status).toBe(200);
    expect(llmProviderCreateMock).toHaveBeenCalledTimes(1);
    expect(llmProviderCreateMock.mock.calls[0][0].data.apiBase).toBe(
      'https://api.openai.com/v1'
    );
    expect(llmReauthMock).toHaveBeenCalledWith(
      expect.any(Request),
      'admin-1',
      'admin-password'
    );
  });

  it('被盗 ADMIN 会话缺少 currentPassword 时不能通过 setup 创建 provider', async () => {
    llmReauthMock.mockResolvedValue({
      ok: false,
      reason: 'missing_or_invalid',
      response: Response.json(
        { code: 'RECENT_AUTH_REQUIRED' },
        { status: 403 }
      ),
    });

    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
        ],
      })
    );

    expect(res.status).toBe(403);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
    expect(llmSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      'llm-provider.create-rejected',
      expect.objectContaining({
        detail: expect.objectContaining({
          reason: 'setup_reauth_missing_or_invalid',
          setup: true,
        }),
      })
    );
  });

  it('任意公网厂商 origin 都放行（已去掉 origin 白名单）', async () => {
    const res = await POST(
      makeRequest({
        step: 'llm',
        currentPassword: 'admin-password',
        providers: [
          {
            name: 'other-vendor',
            apiKey: 'k',
            apiBase: 'https://api.some-other-vendor.example/v1',
          },
        ],
      })
    );

    expect(res.status).toBe(200);
    expect(llmProviderCreateMock.mock.calls[0][0].data.apiBase).toBe(
      'https://api.some-other-vendor.example/v1'
    );
  });

  it('整批先验证：后一个 origin 被拒时前一个也不得落库', async () => {
    const res = await POST(
      makeRequest({
        step: 'llm',
        currentPassword: 'admin-password',
        providers: [
          { name: 'openai', apiKey: 'k1', apiBase: 'https://api.openai.com/v1' },
          // 换靶到内网仍然被拒；公网厂商已不再需要白名单。
          {
            name: 'evil',
            apiKey: 'k2',
            apiBase: 'http://169.254.169.254/latest/meta-data',
          },
        ],
      })
    );

    expect(res.status).toBe(400);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
    expect(llmReauthMock).not.toHaveBeenCalled();
  });

  it('整批数据库写原子化：后一个 provider 写失败时前一个也不提交', async () => {
    const committed: Array<{ id: string; name: string }> = [];
    transactionMock.mockImplementationOnce(
      async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
        const staged: Array<{ id: string; name: string }> = [];
        let createCount = 0;
        const txCreate = vi.fn(async ({ data }: { data: { name: string } }) => {
          createCount += 1;
          if (createCount === 2) throw new Error('second provider insert failed');
          const provider = { id: `tx-p${createCount}`, name: data.name };
          staged.push(provider);
          return provider;
        });
        try {
          const result = await callback({
            ...prismaMock,
            llmProvider: { ...prismaMock.llmProvider, create: txCreate },
          });
          committed.push(...staged);
          return result;
        } catch (error) {
          // Mirrors Prisma transaction rollback: staged writes are discarded.
          throw error;
        }
      }
    );

    const res = await POST(
      makeRequest({
        step: 'llm',
        currentPassword: 'admin-password',
        providers: [
          { name: 'first', apiKey: 'k1', apiBase: 'https://api.openai.com/v1' },
          { name: 'second', apiKey: 'k2', apiBase: 'https://api.openai.com/v2' },
        ],
      })
    );

    expect(res.status).toBe(500);
    expect(committed).toEqual([]);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('query secret 拒绝审计不含参数名或参数值', async () => {
    const res = await POST(
      makeRequest({
        step: 'llm',
        currentPassword: 'admin-password',
        providers: [
          {
            name: 'openai',
            apiKey: 'k',
            apiBase: 'https://api.openai.com/v1?api_key=TOPSECRET',
          },
        ],
      })
    );

    expect(res.status).toBe(400);
    const audit = JSON.stringify(llmSecurityAuditMock.mock.calls[0]);
    expect(audit).not.toContain('api_key');
    expect(audit).not.toContain('TOPSECRET');
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
  });

  it('SSRF 拒绝的审计写失败时返回 500 且关闭失败', async () => {
    llmSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const res = await POST(
      makeRequest({
        step: 'llm',
        currentPassword: 'admin-password',
        providers: [
          {
            name: 'evil',
            apiKey: 'k',
            apiBase: 'http://169.254.169.254/latest/meta-data',
          },
        ],
      })
    );

    expect(res.status).toBe(500);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
  });

  it('reauth 拒绝审计写失败时同样不创建 provider', async () => {
    llmReauthMock.mockResolvedValue({
      ok: false,
      reason: 'missing_or_invalid',
      response: Response.json({ code: 'RECENT_AUTH_REQUIRED' }, { status: 403 }),
    });
    llmSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));

    const res = await POST(
      makeRequest({
        step: 'llm',
        providers: [
          { name: 'openai', apiKey: 'k', apiBase: 'https://api.openai.com/v1' },
        ],
      })
    );

    expect(res.status).toBe(500);
    expect(llmProviderCreateMock).not.toHaveBeenCalled();
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
  it('零管理员时即使 token 正确也拒绝置位 setup_complete', async () => {
    userCountMock.mockResolvedValue(0);

    const res = await POST(
      makeRequest({ step: 'complete' }, { 'x-setup-token': BOOTSTRAP_TOKEN })
    );

    expect(res.status).toBe(403);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });
});
