import { beforeEach, describe, expect, it, vi } from 'vitest';

// P2-2：只改 apiBase、apiKey 留空 = 沿用已存密钥 → 之后每一次 LLM 调用都把解密后的
// 真实 apiKey 发到新地址。私网黑名单只挡内网，公网的攻击者地址照样过。
// validateCloudreveBaseUrl 保持真实：需要它真的归一化 apiBase，才能验「原样回填不算改靶」。
const {
  requireAdminAccessMock,
  providerFindUniqueMock,
  providerUpdateMock,
  modelFindManyMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  providerFindUniqueMock: vi.fn(),
  providerUpdateMock: vi.fn(),
  modelFindManyMock: vi.fn(),
}));

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
  },
}));

vi.mock('@/lib/crypto', () => ({ encrypt: (v: string) => `enc:${v}` }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
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
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-providers/p-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: 'p-1' });

describe('PATCH /api/admin/llm-providers/[id] — 换靶闸范围：不设闸（只保 SMTP）', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    providerFindUniqueMock.mockReset();
    providerUpdateMock.mockReset();
    modelFindManyMock.mockReset();

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
      response: null,
    });
    providerFindUniqueMock.mockResolvedValue({ ...EXISTING });
    providerUpdateMock.mockImplementation(async ({ data }) => ({
      ...EXISTING,
      ...data,
      models: [],
    }));
    modelFindManyMock.mockResolvedValue([]);
  });

  // ↓ 这条固化的是「换靶闸只保 SMTP」这个刻意的范围决定（见 admin/settings/route.ts 的说明）。
  //   若有人把这道闸加回来，它会立刻转红 —— 那时应先回到范围决定本身重新讨论。
  it('只改 apiBase、apiKey 不传 → 放行并落库（厂商 key 常常取不回来）', async () => {
    const res = await PATCH(
      makeRequest({ apiBase: 'https://llm2.corp.example/v1' }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(providerUpdateMock).toHaveBeenCalled();
  });

  it('apiKey 传空串（= 保持原值）同样放行', async () => {
    const res = await PATCH(
      makeRequest({ apiBase: 'https://llm2.corp.example/v1', apiKey: '' }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(providerUpdateMock).toHaveBeenCalled();
  });

  it('改 apiBase 同时重填 apiKey → 放行，两者一起写入', async () => {
    const res = await PATCH(
      makeRequest({ apiBase: 'https://api.newvendor.example/v1', apiKey: 'k2' }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(providerUpdateMock.mock.calls[0][0].data).toMatchObject({
      apiBase: 'https://api.newvendor.example/v1',
      apiKey: 'enc:k2',
    });
  });

  it('apiBase 原样回填（仅尾斜杠差异）→ 不算改靶', async () => {
    const res = await PATCH(
      makeRequest({ apiBase: 'https://api.vendor.example/v1/', name: 'vendor2' }),
      { params }
    );
    expect(res.status).toBe(200);
  });

  it('不动 apiBase，只改名字 → 放行', async () => {
    const res = await PATCH(makeRequest({ name: 'vendor2' }), { params });
    expect(res.status).toBe(200);
  });

  it('库里没 apiKey → 改 apiBase 不拦（没东西可外带）', async () => {
    providerFindUniqueMock.mockResolvedValue({ ...EXISTING, apiKey: '' });
    const res = await PATCH(
      makeRequest({ apiBase: 'https://api.newvendor.example/v1' }),
      { params }
    );
    expect(res.status).toBe(200);
  });
});
