import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 仅 mock 数据访问/鉴权/序列化等副作用依赖；outbound policy 保持真实。
const {
  requireAdminAccessMock,
  providerCreateMock,
  providerFindUniqueMock,
  providerFindManyMock,
  normalizeDefaultModelsByPurposeMock,
  pickDefaultModelIdsByPurposeMock,
  reauthMock,
  securityAuditMock,
  writeSecurityAuditMock,
  dnsLookupMock,
  ensureRegistryMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  providerCreateMock: vi.fn(),
  providerFindUniqueMock: vi.fn(),
  providerFindManyMock: vi.fn(),
  normalizeDefaultModelsByPurposeMock: vi.fn(),
  pickDefaultModelIdsByPurposeMock: vi.fn(),
  reauthMock: vi.fn(),
  securityAuditMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  dnsLookupMock: vi.fn(),
  ensureRegistryMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: (() => {
    const tx = {
      llmProvider: {
        create: providerCreateMock,
        findUnique: providerFindUniqueMock,
        findMany: providerFindManyMock,
      },
    };
    return {
      ...tx,
      $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    };
  })(),
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (value: string) => `enc:${value}`,
}));

vi.mock('@/lib/llm/defaults', () => ({
  normalizeDefaultModelsByPurpose: normalizeDefaultModelsByPurposeMock,
  pickDefaultModelIdsByPurpose: pickDefaultModelIdsByPurposeMock,
}));

vi.mock('@/lib/llm/providerAdmin', () => ({
  serializeProviderForAdmin: (provider: unknown) => provider,
}));
vi.mock('@/lib/llm/registry', () => ({
  ensureLlmRegistry: ensureRegistryMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: vi.fn(),
}));
vi.mock('@/lib/llm/adminReauth', () => ({
  requireLlmAdminCurrentPassword: reauthMock,
}));
vi.mock('@/lib/llm/securityAudit', () => ({
  writeLlmSecurityAudit: securityAuditMock,
}));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));

import { GET, POST } from '@/app/api/admin/llm-providers/route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/llm-providers', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    providerCreateMock.mockReset();
    providerFindUniqueMock.mockReset();
    providerFindManyMock.mockReset().mockResolvedValue([]);
    normalizeDefaultModelsByPurposeMock.mockReset();
    pickDefaultModelIdsByPurposeMock.mockReset();
    reauthMock.mockReset().mockResolvedValue({ ok: true });
    securityAuditMock.mockReset().mockResolvedValue(undefined);
    writeSecurityAuditMock.mockReset().mockResolvedValue(undefined);
    dnsLookupMock.mockReset().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    vi.stubEnv('LLM_PROVIDER_ALLOWED_ORIGINS', 'https://api.example.com');

    // 默认：鉴权通过
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
      response: null,
    });
    pickDefaultModelIdsByPurposeMock.mockReturnValue({});
    ensureRegistryMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('拒绝非法 apiBase（不是合法 URL）', async () => {
    const res = await POST(makeRequest({ name: 'p', apiKey: 'k', apiBase: 'not-a-url' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('apiBase') });
    expect(providerCreateMock).not.toHaveBeenCalled();
  });

  it('拒绝不在 exact-origin allowlist 的 apiBase', async () => {
    const res = await POST(
      makeRequest({ name: 'p', apiKey: 'k', apiBase: 'http://127.0.0.1:8080/v1' })
    );
    expect(res.status).toBe(400);
    expect(providerCreateMock).not.toHaveBeenCalled();
  });

  it('合法 endpoint 但缺少 inline reauth → 不创建 provider', async () => {
    reauthMock.mockResolvedValue({
      ok: false,
      reason: 'missing_or_invalid',
      response: Response.json(
        { code: 'RECENT_AUTH_REQUIRED' },
        { status: 403 }
      ),
    });
    const res = await POST(
      makeRequest({ name: 'p', apiKey: 'k', apiBase: 'https://api.example.com/v1' })
    );
    expect(res.status).toBe(403);
    expect(providerCreateMock).not.toHaveBeenCalled();
    expect(securityAuditMock).toHaveBeenCalled();
  });

  it('拒绝 maxTokens > contextWindow 的模型（避免预算 <= 0）', async () => {
    const res = await POST(
      makeRequest({
        name: 'p',
        apiKey: 'k',
        apiBase: 'https://api.example.com/v1',
        models: [
          {
            modelId: 'gpt-x',
            displayName: 'GPT-X',
            maxTokens: 8192,
            contextWindow: 4096,
          },
        ],
      })
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('contextWindow 必须 ≥ maxTokens'),
    });
    expect(providerCreateMock).not.toHaveBeenCalled();
  });

  it('合法 apiBase + 合法模型可成功创建，并规范化尾部斜杠', async () => {
    providerCreateMock.mockResolvedValue({ id: 'prov-1', models: [] });
    providerFindUniqueMock.mockResolvedValue({ id: 'prov-1', name: 'p', models: [] });

    const res = await POST(
      makeRequest({
        name: 'p',
        apiKey: 'k',
        apiBase: 'https://api.example.com/v1/',
        currentPassword: 'admin-password',
        models: [
          { modelId: 'gpt-x', displayName: 'GPT-X', maxTokens: 4096, contextWindow: 8192 },
        ],
      })
    );

    expect(res.status).toBe(201);
    expect(providerCreateMock).toHaveBeenCalledTimes(1);
    const createArg = providerCreateMock.mock.calls[0][0] as {
      data: { apiBase: string };
    };
    // outbound policy 去掉尾部斜杠
    expect(createArg.data.apiBase).toBe('https://api.example.com/v1');
    expect(reauthMock).toHaveBeenCalledWith(
      expect.any(Request),
      'admin-1',
      'admin-password'
    );
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'llm-providers.create',
        outcome: 'SUCCESS',
        target: expect.objectContaining({ id: 'prov-1' }),
      }),
      expect.any(Object)
    );
  });

  it('SUCCESS 审计失败时关闭失败，不返回已创建配置', async () => {
    providerCreateMock.mockResolvedValue({ id: 'prov-1', models: [] });
    providerFindUniqueMock.mockResolvedValue({
      id: 'prov-1',
      name: 'p',
      apiBase: 'https://api.example.com/v1',
      apiKey: 'enc:k',
      isAnthropic: false,
      models: [],
    });
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));

    const res = await POST(
      makeRequest({
        name: 'p',
        apiKey: 'k',
        apiBase: 'https://api.example.com/v1',
        currentPassword: 'admin-password',
      })
    );

    expect(res.status).toBe(500);
    expect(writeSecurityAuditMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/admin/llm-providers', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset().mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
      response: null,
    });
    providerFindManyMock.mockReset().mockResolvedValue([]);
    writeSecurityAuditMock.mockReset().mockResolvedValue(undefined);
    ensureRegistryMock.mockReset().mockResolvedValue(undefined);
  });

  it('敏感 provider/registry 列表必须审计后才返回', async () => {
    providerFindManyMock.mockResolvedValue([
      { id: 'prov-1', models: [{ id: 'model-1' }], registryModels: [] },
    ]);
    const response = await GET(
      new Request('http://localhost/api/admin/llm-providers')
    );
    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'llm-providers.read',
        outcome: 'SUCCESS',
        target: expect.objectContaining({ ids: ['prov-1'] }),
      })
    );
  });

  it('惰性 registry 迁移通过事务 hook 同步写审计', async () => {
    const tx = { auditLog: { create: vi.fn() } };
    ensureRegistryMock.mockImplementation(async (options) => {
      await options.onMigrated(tx, {
        registryId: 'reg-1',
        providerId: 'prov-1',
        routeIds: ['route-1'],
        createdRegistry: true,
      });
    });
    const response = await GET(
      new Request('http://localhost/api/admin/llm-providers')
    );
    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'llm-registry.migrate', outcome: 'SUCCESS' }),
      tx
    );
  });

  it('列表审计失败时不返回 provider 配置', async () => {
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await GET(
      new Request('http://localhost/api/admin/llm-providers')
    );
    expect(response.status).toBe(500);
  });
});
