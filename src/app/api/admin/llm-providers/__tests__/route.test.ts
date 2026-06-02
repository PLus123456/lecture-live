import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 仅 mock 数据访问/鉴权/序列化等副作用依赖；validateCloudreveBaseUrl 保持真实，
// 以真正验证「非法/私网 apiBase 被拒」这条 SSRF 防线。
const {
  requireAdminAccessMock,
  providerCreateMock,
  providerFindUniqueMock,
  normalizeDefaultModelsByPurposeMock,
  pickDefaultModelIdsByPurposeMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  providerCreateMock: vi.fn(),
  providerFindUniqueMock: vi.fn(),
  normalizeDefaultModelsByPurposeMock: vi.fn(),
  pickDefaultModelIdsByPurposeMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    llmProvider: {
      create: providerCreateMock,
      findUnique: providerFindUniqueMock,
      findMany: vi.fn(),
    },
  },
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

vi.mock('@/lib/auditLog', () => ({
  logAction: vi.fn(),
}));

import { POST } from '@/app/api/admin/llm-providers/route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/llm-providers', () => {
  const originalAllowPrivate = process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;

  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    providerCreateMock.mockReset();
    providerFindUniqueMock.mockReset();
    normalizeDefaultModelsByPurposeMock.mockReset();
    pickDefaultModelIdsByPurposeMock.mockReset();

    // 默认：鉴权通过
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
      response: null,
    });
    pickDefaultModelIdsByPurposeMock.mockReturnValue({});
    // 私网过滤必须生效，确保旁路开关关闭
    delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
  });

  afterEach(() => {
    if (originalAllowPrivate === undefined) {
      delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
    } else {
      process.env.CLOUDREVE_ALLOW_PRIVATE_HOST = originalAllowPrivate;
    }
  });

  it('拒绝非法 apiBase（不是合法 URL）', async () => {
    const res = await POST(makeRequest({ name: 'p', apiKey: 'k', apiBase: 'not-a-url' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('apiBase') });
    expect(providerCreateMock).not.toHaveBeenCalled();
  });

  it('拒绝指向内网/本地地址的 apiBase（SSRF 防护）', async () => {
    const res = await POST(
      makeRequest({ name: 'p', apiKey: 'k', apiBase: 'http://127.0.0.1:8080/v1' })
    );
    expect(res.status).toBe(400);
    expect(providerCreateMock).not.toHaveBeenCalled();
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
    // validateCloudreveBaseUrl 去掉尾部斜杠
    expect(createArg.data.apiBase).toBe('https://api.example.com/v1');
  });
});
