import { beforeEach, describe, expect, it, vi } from 'vitest';

// 模型库登记 API：登记 + 可选一步挂载（purposes）

const {
  requireAdminAccessMock,
  providerFindUniqueMock,
  registryFindFirstMock,
  registryAggregateMock,
  registryCreateMock,
  registryFindUniqueMock,
  routeCountMock,
  routeAggregateMock,
  routeCreateMock,
  routeUpdateManyMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  providerFindUniqueMock: vi.fn(),
  registryFindFirstMock: vi.fn(),
  registryAggregateMock: vi.fn(),
  registryCreateMock: vi.fn(),
  registryFindUniqueMock: vi.fn(),
  routeCountMock: vi.fn(),
  routeAggregateMock: vi.fn(),
  routeCreateMock: vi.fn(),
  routeUpdateManyMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    llmRegistryModel: {
      findFirst: registryFindFirstMock,
      aggregate: registryAggregateMock,
      create: registryCreateMock,
      findUnique: registryFindUniqueMock,
    },
    llmModel: {
      count: routeCountMock,
      aggregate: routeAggregateMock,
      create: routeCreateMock,
      updateMany: routeUpdateManyMock,
    },
  };
  return {
    prisma: {
      ...tx,
      llmProvider: { findUnique: providerFindUniqueMock },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));

import { POST } from '@/app/api/admin/llm-providers/[id]/registry/route';

function post(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-providers/prov-1/registry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'prov-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminAccessMock.mockResolvedValue({ user: { id: 'admin-1' }, response: null });
  providerFindUniqueMock.mockResolvedValue({ id: 'prov-1', name: '火山' });
  registryFindFirstMock.mockResolvedValue(null);
  registryAggregateMock.mockResolvedValue({ _max: { sortOrder: null } });
  registryCreateMock.mockImplementation(async ({ data }) => ({
    id: 'reg-new',
    providerId: 'prov-1',
    ...data,
  }));
  registryFindUniqueMock.mockImplementation(async () => ({
    id: 'reg-new',
    routes: [],
  }));
  routeCountMock.mockResolvedValue(0);
  routeAggregateMock.mockResolvedValue({ _max: { sortOrder: null } });
  routeCreateMock.mockImplementation(async ({ data }) => ({ id: 'route-new', ...data }));
  routeUpdateManyMock.mockResolvedValue({ count: 0 });
});

describe('POST /api/admin/llm-providers/[id]/registry', () => {
  it('缺省规格：上下文 256K（262144）、maxTokens 顶到系统输出上限 8192', async () => {
    const res = await POST(post({ modelId: 'm', displayName: 'M' }), params);
    expect(res.status).toBe(201);
    expect(registryCreateMock.mock.calls[0][0].data).toMatchObject({
      contextWindow: 262144,
      maxTokens: 8192,
    });
  });

  it('purposes 一步挂载：按用途各建一条路由行，该用途首个模型自动成为默认', async () => {
    const res = await POST(
      post({
        modelId: 'm',
        displayName: 'M',
        purposes: ['CHAT', 'FINAL_SUMMARY', 'CHAT'], // 重复项去重
      }),
      params
    );
    expect(res.status).toBe(201);
    expect(routeCreateMock).toHaveBeenCalledTimes(2);
    const purposes = routeCreateMock.mock.calls.map((c) => c[0].data.purpose);
    expect(purposes).toEqual(['CHAT', 'FINAL_SUMMARY']);
    // 该用途此前无模型 → 自动默认
    expect(routeCreateMock.mock.calls[0][0].data.isDefault).toBe(true);
    // 规格从登记值写穿
    expect(routeCreateMock.mock.calls[0][0].data).toMatchObject({
      registryId: 'reg-new',
      modelId: 'm',
      contextWindow: 262144,
      maxTokens: 8192,
    });
  });

  it('用途已有模型时挂载不抢默认', async () => {
    routeCountMock.mockResolvedValue(3);
    await POST(post({ modelId: 'm', displayName: 'M', purposes: ['CHAT'] }), params);
    expect(routeCreateMock.mock.calls[0][0].data.isDefault).toBe(false);
    expect(routeUpdateManyMock).not.toHaveBeenCalled();
  });

  it('文本模型挂嵌入用途 → 400 且不落库', async () => {
    const res = await POST(
      post({ modelId: 'm', displayName: 'M', kind: 'TEXT', purposes: ['EMBEDDING'] }),
      params
    );
    expect(res.status).toBe(400);
    expect(registryCreateMock).not.toHaveBeenCalled();
  });

  it('嵌入模型挂聊天用途 → 400', async () => {
    const res = await POST(
      post({ modelId: 'm', displayName: 'M', kind: 'EMBEDDING', purposes: ['CHAT'] }),
      params
    );
    expect(res.status).toBe(400);
  });

  it('非法用途值 → 400', async () => {
    const res = await POST(
      post({ modelId: 'm', displayName: 'M', purposes: ['SUPER_CHAT'] }),
      params
    );
    expect(res.status).toBe(400);
  });

  it('同网关同名同标识 → 400', async () => {
    registryFindFirstMock.mockResolvedValue({ id: 'reg-dup' });
    const res = await POST(post({ modelId: 'm', displayName: 'M' }), params);
    expect(res.status).toBe(400);
  });
});
