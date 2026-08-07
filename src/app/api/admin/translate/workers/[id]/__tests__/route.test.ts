import { beforeEach, describe, expect, it, vi } from 'vitest';

// P2-2：只改 baseUrl、token 留空 = 沿用已存 token → 调度器和 verify 之后都会把解密后的
// 真实 token 以 Authorization: Bearer 发到新地址。
const {
  requireAdminAccessMock,
  workerFindUniqueMock,
  workerUpdateMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  workerFindUniqueMock: vi.fn(),
  workerUpdateMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationWorker: {
      findUnique: workerFindUniqueMock,
      update: workerUpdateMock,
    },
  },
}));

vi.mock('@/lib/crypto', () => ({ encrypt: (v: string) => `enc:${v}` }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/storage/cloudreve', () => ({
  validateCloudreveBaseUrl: vi.fn(),
}));

import { PATCH } from '@/app/api/admin/translate/workers/[id]/route';

const EXISTING = {
  id: 'w-1',
  name: 'worker-1',
  baseUrl: 'https://tw1.corp.example',
  token: 'enc:real-worker-token',
  enabled: true,
  concurrency: 2,
  weight: 10,
  qps: 5,
  status: 'HEALTHY',
  lastCheckedAt: null,
  lastError: null,
  sortOrder: 0,
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/translate/workers/w-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: 'w-1' });

describe('PATCH /api/admin/translate/workers/[id] — 改端点必须重填 token', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    workerFindUniqueMock.mockReset();
    workerUpdateMock.mockReset();

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
      response: null,
    });
    workerFindUniqueMock.mockResolvedValue({ ...EXISTING });
    workerUpdateMock.mockImplementation(async ({ data }) => ({
      ...EXISTING,
      ...data,
    }));
  });

  it('只改 baseUrl、token 不传 → 400，且不落库（核心攻击形状）', async () => {
    const res = await PATCH(
      makeRequest({ baseUrl: 'https://attacker.tld' }),
      { params }
    );
    expect(res.status).toBe(400);
    expect(workerUpdateMock).not.toHaveBeenCalled();
  });

  it('token 传空串（= 保持原值）同样拦下', async () => {
    const res = await PATCH(
      makeRequest({ baseUrl: 'https://attacker.tld', token: '   ' }),
      { params }
    );
    expect(res.status).toBe(400);
    expect(workerUpdateMock).not.toHaveBeenCalled();
  });

  it('改 baseUrl 同时重填 token → 放行，两者一起写入', async () => {
    const token = 'x'.repeat(40);
    const res = await PATCH(
      makeRequest({ baseUrl: 'https://tw2.corp.example', token }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(workerUpdateMock.mock.calls[0][0].data).toMatchObject({
      baseUrl: 'https://tw2.corp.example',
      token: `enc:${token}`,
    });
  });

  it('不动 baseUrl，只改并发/权重 → 放行（掩码语义不受影响）', async () => {
    const res = await PATCH(makeRequest({ concurrency: 4 }), { params });
    expect(res.status).toBe(200);
    expect(workerUpdateMock.mock.calls[0][0].data).toMatchObject({
      concurrency: 4,
    });
  });

  it('baseUrl 原样回填（仅尾斜杠差异）→ 不算改靶', async () => {
    const res = await PATCH(
      makeRequest({ baseUrl: 'https://tw1.corp.example/', enabled: false }),
      { params }
    );
    expect(res.status).toBe(200);
  });

  it('库里没 token → 改 baseUrl 不拦（没东西可外带）', async () => {
    workerFindUniqueMock.mockResolvedValue({ ...EXISTING, token: '' });
    const res = await PATCH(
      makeRequest({ baseUrl: 'https://tw2.corp.example' }),
      { params }
    );
    expect(res.status).toBe(200);
  });
});
