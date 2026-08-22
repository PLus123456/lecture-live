import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  orderFindManyMock,
  orderCountMock,
  userFindManyMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  orderFindManyMock: vi.fn(),
  orderCountMock: vi.fn(),
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
    paymentOrder: { findMany: orderFindManyMock, count: orderCountMock },
    user: { findMany: userFindManyMock },
  },
}));

import { GET } from '@/app/api/admin/recharge/orders/route';

const CTX = { params: Promise.resolve({}) } as never;
const ADMIN = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  orderFindManyMock.mockReset();
  orderCountMock.mockReset();
  userFindManyMock.mockReset();
  writeSecurityAuditMock.mockReset();
  requireAdminAccessMock.mockResolvedValue({ user: ADMIN, response: null });
  orderFindManyMock.mockResolvedValue([
    {
      id: 'order-1',
      userId: 'user-1',
      provider: 'stripe',
      status: 'paid',
      amountCents: 1200,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    },
  ]);
  orderCountMock.mockResolvedValue(1);
  userFindManyMock.mockResolvedValue([
    { id: 'user-1', email: 'buyer@example.com', displayName: 'Buyer' },
  ]);
  writeSecurityAuditMock.mockResolvedValue({ requestId: 'req-1', action: 'read' });
});

const get = () =>
  GET(
    new Request(
      'http://localhost/api/admin/recharge/orders?page=3&pageSize=5&status=paid&provider=stripe'
    ),
    CTX
  );

describe('SEC-033 /api/admin/recharge/orders', () => {
  it('成功读取前等待结构化安全审计，并记录安全筛选与分页摘要', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      orders: [{ id: 'order-1', userEmail: 'buyer@example.com' }],
      pagination: { page: 3, pageSize: 5, total: 1 },
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'recharge.orders.read',
        operator: ADMIN,
        target: { type: 'recharge_order_collection' },
        reason: 'admin_list',
        outcome: 'SUCCESS',
        metadata: expect.objectContaining({
          filters: { status: 'paid', provider: 'stripe' },
          page: 3,
          pageSize: 5,
          count: 1,
        }),
      })
    );
  });

  it('安全审计拒绝时返回 503，且不泄露已组装的敏感订单 payload', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await get();
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(body).not.toContain('order-1');
    expect(body).not.toContain('buyer@example.com');
  });
});
