import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SEC-034：只改 apiBase、apiKey 留空会让服务端把不可见的旧密钥发往新地址。
// outbound exact-origin policy 保持真实，同时验证尾斜杠等价不会被误判为改靶。
const {
  requireAdminAccessMock,
  providerFindUniqueMock,
  providerUpdateMock,
  modelFindManyMock,
  queryRawMock,
  transactionMock,
  securityWriteMock,
  reauthMock,
  securityAuditMock,
  dnsLookupMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  providerFindUniqueMock: vi.fn(),
  providerUpdateMock: vi.fn(),
  modelFindManyMock: vi.fn(),
  queryRawMock: vi.fn(),
  transactionMock: vi.fn(),
  securityWriteMock: vi.fn(),
  reauthMock: vi.fn(),
  securityAuditMock: vi.fn(),
  dnsLookupMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    llmProvider: {
      findUnique: providerFindUniqueMock,
      update: providerUpdateMock,
    },
    llmModel: { findMany: modelFindManyMock },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/crypto', () => ({ encrypt: (v: string) => `enc:${v}` }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/llm/adminReauth', () => ({
  requireLlmAdminCurrentPassword: reauthMock,
}));
vi.mock('@/lib/llm/securityAudit', () => ({
  writeLlmSecurityAudit: securityAuditMock,
}));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: securityWriteMock,
}));
vi.mock('@/lib/llm/defaults', () => ({
  normalizeDefaultModelsByPurpose: vi.fn(),
  pickDefaultModelIdsByPurpose: () => ({}),
}));
vi.mock('@/lib/llm/providerAdmin', () => ({
  serializeProviderForAdmin: (p: unknown) => p,
}));

import { PATCH } from '@/app/api/admin/llm-providers/[id]/route';

const EXISTING = {
  id: 'p-1',
  name: 'vendor',
  apiKey: 'enc:real-api-key',
  apiBase: 'https://api.vendor.example/v1',
  isAnthropic: false,
  sortOrder: 0,
  updatedAt: new Date('2026-08-20T10:00:00.000Z'),
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-providers/p-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: 'p-1' });

describe('PATCH /api/admin/llm-providers/[id] — SEC-034 凭据换靶闸', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    providerFindUniqueMock.mockReset();
    providerUpdateMock.mockReset();
    modelFindManyMock.mockReset();
    reauthMock.mockReset().mockResolvedValue({ ok: true });
    securityAuditMock.mockReset().mockResolvedValue(undefined);
    securityWriteMock.mockReset().mockResolvedValue(undefined);
    dnsLookupMock.mockReset().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);

    vi.stubEnv(
      'LLM_PROVIDER_ALLOWED_ORIGINS',
      [
        'https://api.vendor.example',
        'https://llm2.corp.example',
        'https://api.newvendor.example',
      ].join(',')
    );

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
      response: null,
    });
    providerFindUniqueMock.mockResolvedValue({ ...EXISTING, models: [] });
    providerUpdateMock.mockResolvedValue({ count: 1 });
    modelFindManyMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([{ ...EXISTING }]);
    const tx = {
      $queryRaw: queryRawMock,
      llmProvider: {
        findUnique: providerFindUniqueMock,
        updateMany: providerUpdateMock,
      },
      llmModel: {
        findMany: modelFindManyMock,
        deleteMany: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };
    transactionMock.mockReset().mockImplementation(
      (callback: (client: typeof tx) => unknown) => callback(tx)
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it('只改 apiBase、apiKey 不传 → 拒绝，不可外带旧密钥', async () => {
    const res = await PATCH(
      makeRequest({ apiBase: 'https://llm2.corp.example/v1' }),
      { params }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/API Key/) });
    expect(providerUpdateMock).not.toHaveBeenCalled();
  });

  it('apiKey 传空串（= 保持原值）同样拒绝', async () => {
    const res = await PATCH(
      makeRequest({ apiBase: 'https://llm2.corp.example/v1', apiKey: '' }),
      { params }
    );
    expect(res.status).toBe(400);
    expect(providerUpdateMock).not.toHaveBeenCalled();
  });

  it('未换靶时回传脱敏占位不会把真密钥覆盖成占位符', async () => {
    const res = await PATCH(makeRequest({ name: 'vendor2', apiKey: '********' }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(providerUpdateMock.mock.calls[0][0].data).not.toHaveProperty('apiKey');
  });

  it('改 apiBase 同时重填 apiKey → 放行，两者一起写入', async () => {
    const res = await PATCH(
      makeRequest({
        apiBase: 'https://api.newvendor.example/v1',
        apiKey: 'k2',
        currentPassword: 'admin-password',
      }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(providerUpdateMock.mock.calls[0][0].data).toMatchObject({
      apiBase: 'https://api.newvendor.example/v1',
      apiKey: 'enc:k2',
    });
    expect(reauthMock).toHaveBeenCalledWith(
      expect.any(Request),
      'admin-1',
      'admin-password'
    );
  });

  it('重填 key 但近期重认证失败 → 仍拒绝且等待安全审计', async () => {
    reauthMock.mockResolvedValue({
      ok: false,
      reason: 'missing_or_invalid',
      response: Response.json(
        { code: 'RECENT_AUTH_REQUIRED' },
        { status: 403 }
      ),
    });
    const res = await PATCH(
      makeRequest({
        apiBase: 'https://api.newvendor.example/v1',
        apiKey: 'k2',
        currentPassword: 'wrong',
      }),
      { params }
    );
    expect(res.status).toBe(403);
    expect(providerUpdateMock).not.toHaveBeenCalled();
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      'llm-provider.update-rejected',
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'reauth_missing_or_invalid' }),
      })
    );
  });

  it('apiBase 原样回填（仅尾斜杠差异）→ 不算改靶', async () => {
    const res = await PATCH(
      makeRequest({ apiBase: 'https://api.vendor.example/v1/', name: 'vendor2' }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(reauthMock).not.toHaveBeenCalled();
  });

  it('换靶比较最终落库 URL，查询串后的斜杠不能制造双重归一旁路', async () => {
    providerFindUniqueMock.mockResolvedValue({
      ...EXISTING,
      apiBase: 'https://api.vendor.example/v1?tenant=a',
    });

    const res = await PATCH(
      makeRequest({ apiBase: 'https://api.vendor.example/v1?tenant=a//' }),
      { params }
    );

    expect(res.status).toBe(400);
    expect(providerUpdateMock).not.toHaveBeenCalled();
  });

  it('不动 apiBase，只改名字 → 放行', async () => {
    const res = await PATCH(makeRequest({ name: 'vendor2' }), { params });
    expect(res.status).toBe(200);
    expect(reauthMock).not.toHaveBeenCalled();
  });

  it('fresh key 也不能把端点改到 allowlist 之外', async () => {
    const res = await PATCH(
      makeRequest({
        apiBase: 'https://attacker.example/v1',
        apiKey: 'brand-new-key',
        currentPassword: 'admin-password',
      }),
      { params }
    );
    expect(res.status).toBe(400);
    expect(reauthMock).not.toHaveBeenCalled();
    expect(providerUpdateMock).not.toHaveBeenCalled();
    expect(securityAuditMock).toHaveBeenCalled();
  });

  it('query secret 拒绝审计只记录计数/哈希，不记录 key 或值；审计失败时关闭失败', async () => {
    const secretUrl = 'https://api.vendor.example/v1?api_key=TOPSECRET';
    const rejected = await PATCH(
      makeRequest({
        apiBase: secretUrl,
        apiKey: 'brand-new-key',
        currentPassword: 'admin-password',
      }),
      { params }
    );
    expect(rejected.status).toBe(400);
    const auditPayload = JSON.stringify(securityAuditMock.mock.calls[0]);
    expect(auditPayload).not.toContain('api_key');
    expect(auditPayload).not.toContain('TOPSECRET');
    expect(providerUpdateMock).not.toHaveBeenCalled();

    securityAuditMock.mockReset().mockRejectedValue(new Error('audit unavailable'));
    const auditFailure = await PATCH(
      makeRequest({
        apiBase: secretUrl,
        apiKey: 'brand-new-key',
        currentPassword: 'admin-password',
      }),
      { params }
    );
    expect(auditFailure.status).toBe(500);
    expect(providerUpdateMock).not.toHaveBeenCalled();
  });

  it('修改 provider 协议模式也必须重填 key', async () => {
    const res = await PATCH(makeRequest({ isAnthropic: true }), { params });
    expect(res.status).toBe(400);
    expect(providerUpdateMock).not.toHaveBeenCalled();
  });

  it('库里没 apiKey → 改 apiBase 不拦（没东西可外带）', async () => {
    providerFindUniqueMock.mockResolvedValue({ ...EXISTING, apiKey: '', models: [] });
    queryRawMock.mockResolvedValue([{ ...EXISTING, apiKey: '' }]);
    const res = await PATCH(
      makeRequest({ apiBase: 'https://api.newvendor.example/v1' }),
      { params }
    );
    expect(res.status).toBe(200);
  });

  it('row-lock recomputation blocks a concurrent endpoint/key change that bypassed preliminary reauth', async () => {
    queryRawMock.mockResolvedValue([
      {
        ...EXISTING,
        apiBase: 'https://llm2.corp.example/v1',
        apiKey: 'enc:concurrent-key',
        updatedAt: new Date('2026-08-20T10:01:00.000Z'),
      },
    ]);

    const res = await PATCH(
      makeRequest({ apiBase: 'https://api.vendor.example/v1', apiKey: 'new-key' }),
      { params }
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'PROVIDER_BINDING_CHANGED' });
    expect(providerUpdateMock).not.toHaveBeenCalled();
    expect(reauthMock).not.toHaveBeenCalled();
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      'llm-provider.update-rejected',
      expect.objectContaining({
        detail: expect.objectContaining({
          reason: 'provider_binding_changed_since_preflight',
        }),
      })
    );
  });

  it('rejects an apiKey-only patch when the endpoint changed after preflight', async () => {
    queryRawMock.mockResolvedValue([
      {
        ...EXISTING,
        apiBase: 'https://llm2.corp.example/v1',
        updatedAt: new Date('2026-08-20T10:01:00.000Z'),
      },
    ]);

    const res = await PATCH(makeRequest({ apiKey: 'key-for-original-endpoint' }), {
      params,
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: 'PROVIDER_BINDING_CHANGED',
    });
    expect(providerUpdateMock).not.toHaveBeenCalled();
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      'llm-provider.update-rejected',
      expect.objectContaining({
        detail: expect.objectContaining({
          reason: 'provider_binding_changed_since_preflight',
          endpointChanged: true,
        }),
      })
    );
  });

  it('version CAS failure rolls back and is audited as a concurrent binding rejection', async () => {
    providerUpdateMock.mockResolvedValueOnce({ count: 0 });

    const res = await PATCH(makeRequest({ name: 'vendor2' }), { params });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'PROVIDER_BINDING_CHANGED' });
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      'llm-provider.update-rejected',
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'provider_version_changed' }),
      })
    );
  });
});
