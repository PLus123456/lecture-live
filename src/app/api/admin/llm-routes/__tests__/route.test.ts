import { beforeEach, describe, expect, it, vi } from 'vitest';

// 用途路由 API：挂载（POST /api/admin/llm-routes）与调参/默认互斥（PATCH /[id]）

const {
  requireAdminAccessMock,
  registryFindUniqueMock,
  routeFindFirstMock,
  routeFindUniqueMock,
  routeCountMock,
  routeAggregateMock,
  routeCreateMock,
  routeUpdateMock,
  routeUpdateManyMock,
  routeDeleteMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  registryFindUniqueMock: vi.fn(),
  routeFindFirstMock: vi.fn(),
  routeFindUniqueMock: vi.fn(),
  routeCountMock: vi.fn(),
  routeAggregateMock: vi.fn(),
  routeCreateMock: vi.fn(),
  routeUpdateMock: vi.fn(),
  routeUpdateManyMock: vi.fn(),
  routeDeleteMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    llmModel: {
      findFirst: routeFindFirstMock,
      findUnique: routeFindUniqueMock,
      count: routeCountMock,
      aggregate: routeAggregateMock,
      create: routeCreateMock,
      update: routeUpdateMock,
      updateMany: routeUpdateManyMock,
      delete: routeDeleteMock,
    },
    llmRegistryModel: {
      findUnique: registryFindUniqueMock,
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));

import { POST } from '@/app/api/admin/llm-routes/route';
import { PATCH, DELETE } from '@/app/api/admin/llm-routes/[id]/route';

const TEXT_REGISTRY = {
  id: 'reg-1',
  providerId: 'prov-1',
  modelId: 'gpt-4o',
  displayName: 'GPT-4o',
  kind: 'TEXT',
  supportsImage: true,
  maxTokens: 4096,
  contextWindow: 131072,
};

function post(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patch(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-routes/route-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminAccessMock.mockResolvedValue({ user: { id: 'admin-1' }, response: null });
  registryFindUniqueMock.mockResolvedValue(TEXT_REGISTRY);
  routeFindFirstMock.mockResolvedValue(null);
  routeCountMock.mockResolvedValue(0);
  routeAggregateMock.mockResolvedValue({ _max: { sortOrder: null } });
  routeCreateMock.mockImplementation(async ({ data }) => ({ id: 'route-new', ...data }));
  routeUpdateMock.mockImplementation(async ({ data }) => ({ id: 'route-1', ...data }));
  routeUpdateManyMock.mockResolvedValue({ count: 0 });
});

describe('POST /api/admin/llm-routes（挂载）', () => {
  it('规格从模型库写穿，该用途首个模型自动成为默认', async () => {
    const res = await POST(post({ registryId: 'reg-1', purpose: 'CHAT' }));
    expect(res.status).toBe(201);
    const created = routeCreateMock.mock.calls[0][0].data;
    expect(created).toMatchObject({
      providerId: 'prov-1',
      registryId: 'reg-1',
      modelId: 'gpt-4o',
      supportsImage: true,
      contextWindow: 131072,
      purpose: 'CHAT',
      isDefault: true, // 首个 → 自动默认
    });
  });

  it('该用途已有模型时不抢默认', async () => {
    routeCountMock.mockResolvedValue(2);
    await POST(post({ registryId: 'reg-1', purpose: 'CHAT' }));
    expect(routeCreateMock.mock.calls[0][0].data.isDefault).toBe(false);
    expect(routeUpdateManyMock).not.toHaveBeenCalled();
  });

  it('文本模型挂 EMBEDDING 用途 → 400', async () => {
    const res = await POST(post({ registryId: 'reg-1', purpose: 'EMBEDDING' }));
    expect(res.status).toBe(400);
  });

  it('嵌入模型挂 CHAT 用途 → 400', async () => {
    registryFindUniqueMock.mockResolvedValue({ ...TEXT_REGISTRY, kind: 'EMBEDDING' });
    const res = await POST(post({ registryId: 'reg-1', purpose: 'CHAT' }));
    expect(res.status).toBe(400);
  });

  it('重复挂载同用途 → 400', async () => {
    routeFindFirstMock.mockResolvedValue({ id: 'route-exist' });
    const res = await POST(post({ registryId: 'reg-1', purpose: 'CHAT' }));
    expect(res.status).toBe(400);
  });

  it('温度越界 → 400', async () => {
    const res = await POST(
      post({ registryId: 'reg-1', purpose: 'CHAT', temperature: 3.5 })
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/admin/llm-routes/[id]（调参 + 默认互斥）', () => {
  beforeEach(() => {
    routeFindUniqueMock.mockResolvedValue({
      id: 'route-1',
      purpose: 'CHAT',
      displayName: 'GPT-4o',
      temperature: 0.6,
    });
  });

  it('isDefault=true 时同用途其余路由取消默认', async () => {
    const res = await PATCH(patch({ isDefault: true }), params('route-1'));
    expect(res.status).toBe(200);
    expect(routeUpdateManyMock).toHaveBeenCalledWith({
      where: { purpose: 'CHAT', isDefault: true, id: { not: 'route-1' } },
      data: { isDefault: false },
    });
  });

  it('thinkingMode=DEPTH 时派生 supportsThinkingDepth=true', async () => {
    await PATCH(patch({ thinkingMode: 'DEPTH' }), params('route-1'));
    expect(routeUpdateMock.mock.calls[0][0].data).toMatchObject({
      thinkingMode: 'DEPTH',
      supportsThinkingDepth: true,
    });
  });

  it('非法思考模式 → 400', async () => {
    const res = await PATCH(patch({ thinkingMode: 'ULTRA' }), params('route-1'));
    expect(res.status).toBe(400);
  });

  it('非法温度 → 400', async () => {
    const res = await PATCH(patch({ temperature: -1 }), params('route-1'));
    expect(res.status).toBe(400);
  });

  it('路由不存在 → 404', async () => {
    routeFindUniqueMock.mockResolvedValue(null);
    const res = await PATCH(patch({ isDefault: true }), params('missing'));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/llm-routes/[id]（摘除）', () => {
  it('删除存在的路由行', async () => {
    routeFindUniqueMock.mockResolvedValue({
      id: 'route-1',
      purpose: 'CHAT',
      displayName: 'GPT-4o',
    });
    const res = await DELETE(
      new Request('http://localhost/api/admin/llm-routes/route-1', { method: 'DELETE' }),
      params('route-1')
    );
    expect(res.status).toBe(200);
    expect(routeDeleteMock).toHaveBeenCalledWith({ where: { id: 'route-1' } });
  });
});
