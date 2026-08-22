import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  transactionFindManyMock,
  transactionCountMock,
  userFindManyMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  transactionFindManyMock: vi.fn(),
  transactionCountMock: vi.fn(),
  userFindManyMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (_scope: string, handler: (req: Request) => Promise<Response>) => handler,
}));
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: writeSecurityAuditMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    walletTransaction: {
      findMany: transactionFindManyMock,
      count: transactionCountMock,
    },
    user: { findMany: userFindManyMock },
  },
}));

import { GET } from '@/app/api/admin/recharge/ledger/route';

const CTX = { params: Promise.resolve({}) } as never;
const ADMIN = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  transactionFindManyMock.mockReset();
  transactionCountMock.mockReset();
  userFindManyMock.mockReset();
  writeSecurityAuditMock.mockReset();
  requireAdminAccessMock.mockResolvedValue({ user: ADMIN, response: null });
  transactionFindManyMock.mockResolvedValue([
    {
      id: 'txn-1',
      userId: 'user-1',
      type: 'recharge',
      amountCents: 1200,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    },
  ]);
  transactionCountMock.mockResolvedValue(1);
  userFindManyMock.mockResolvedValue([
    { id: 'user-1', email: 'target@example.com', displayName: 'Target' },
  ]);
  writeSecurityAuditMock.mockResolvedValue({ requestId: 'req-1', action: 'read' });
});

const get = () =>
  GET(
    new Request(
      'http://localhost/api/admin/recharge/ledger?page=2&pageSize=10&type=recharge&userId=user-1'
    ),
    CTX
  );

describe('SEC-033 /api/admin/recharge/ledger', () => {
  it('成功读取前等待结构化安全审计，并记录安全筛选与分页摘要', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      transactions: [{ id: 'txn-1', userEmail: 'target@example.com' }],
      pagination: { page: 2, pageSize: 10, total: 1 },
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'recharge.ledger.read',
        operator: ADMIN,
        target: { type: 'recharge_ledger_collection' },
        reason: 'admin_list',
        outcome: 'SUCCESS',
        metadata: expect.objectContaining({
          filters: { type: 'recharge', userId: 'user-1' },
          page: 2,
          pageSize: 10,
          count: 1,
        }),
      })
    );
  });

  it('安全审计拒绝时返回 503，且不泄露已组装的敏感台账 payload', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await get();
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(body).not.toContain('txn-1');
    expect(body).not.toContain('target@example.com');
  });
});
