import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  userCountMock,
  sessionCountMock,
  shareCountMock,
  folderCountMock,
  userFindManyMock,
  sessionFindManyMock,
  shareFindManyMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  userCountMock: vi.fn(),
  sessionCountMock: vi.fn(),
  shareCountMock: vi.fn(),
  folderCountMock: vi.fn(),
  userFindManyMock: vi.fn(),
  sessionFindManyMock: vi.fn(),
  shareFindManyMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { count: userCountMock, findMany: userFindManyMock },
    session: { count: sessionCountMock, findMany: sessionFindManyMock },
    shareLink: { count: shareCountMock, findMany: shareFindManyMock },
    folder: { count: folderCountMock },
  },
}));
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: writeSecurityAuditMock }));

import { GET } from '@/app/api/admin/stats/route';

const request = () => new Request('http://localhost/api/admin/stats');

describe('GET /api/admin/stats — SEC-033', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' },
      response: null,
    });
    userCountMock.mockResolvedValue(7);
    sessionCountMock.mockResolvedValue(11);
    shareCountMock.mockResolvedValue(3);
    folderCountMock.mockResolvedValue(5);
    userFindManyMock.mockResolvedValue([]);
    sessionFindManyMock.mockResolvedValue([]);
    shareFindManyMock.mockResolvedValue([]);
    writeSecurityAuditMock.mockResolvedValue({});
  });

  it('only returns sensitive aggregates after the structured audit is durable', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totals: { users: 7, sessions: 11, shares: 3, folders: 5 },
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'stats.read',
        operator: expect.objectContaining({ id: 'admin-1' }),
        target: { type: 'admin_statistics', id: 'rolling-30-days' },
        outcome: 'SUCCESS',
      })
    );
  });

  it('fails closed when the audit row cannot be written', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '查询失败' });
  });
});
