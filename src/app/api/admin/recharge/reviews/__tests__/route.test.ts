import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  listMock,
  applyMock,
  securityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  listMock: vi.fn(),
  applyMock: vi.fn(),
  securityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/payment/adminReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/payment/adminReview')>();
  return {
    ...actual,
    listPaymentReviewQueue: listMock,
    applyPaymentReviewAction: applyMock,
  };
});
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: securityAuditMock }));

import { GET, POST } from '@/app/api/admin/recharge/reviews/route';

const admin = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminAccessMock.mockResolvedValue({ user: admin, response: null });
  securityAuditMock.mockResolvedValue({ requestId: 'r1', action: 'audit' });
});

describe('/api/admin/recharge/reviews', () => {
  it('lists all unresolved control planes behind ADMIN auth and audits the read', async () => {
    listMock.mockResolvedValue({
      reviews: [{ id: 'r1' }],
      debts: [{ id: 'd1' }],
      holds: [{ id: 'h1' }],
      orders: [{ id: 'o1' }],
      webhooks: [{ id: 'w1' }],
    });
    const response = await GET(
      new Request('https://app.test/api/admin/recharge/reviews?limit=25')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      debts: [{ id: 'd1' }],
      holds: [{ id: 'h1' }],
      webhooks: [{ id: 'w1' }],
    });
    expect(requireAdminAccessMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ scope: 'admin:recharge:reviews:list' })
    );
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'payment-review.list', outcome: 'SUCCESS' })
    );
  });

  it('dispatches a reason-bound admin action', async () => {
    applyMock.mockResolvedValue({ id: 'h1', status: 'released' });
    const response = await POST(
      new Request('https://app.test/api/admin/recharge/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'release_hold',
          id: 'h1',
          reason: '所有债务与复核项已结清',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(applyMock).toHaveBeenCalledWith(
      expect.any(Request),
      admin,
      {
        action: 'release_hold',
        id: 'h1',
        orderId: undefined,
        reason: '所有债务与复核项已结清',
      }
    );
  });

  it('exposes the explicit order selection required for webhook mapping/retry', async () => {
    applyMock.mockResolvedValue({
      webhookEventId: 'w1',
      orderId: 'o1',
      outcome: 'reversed',
    });
    const response = await POST(
      new Request('https://app.test/api/admin/recharge/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'map_and_retry_webhook',
          id: 'w1',
          orderId: 'o1',
          reason: '对账确认旧 Stripe 对象属于该订单',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(applyMock).toHaveBeenCalledWith(
      expect.any(Request),
      admin,
      expect.objectContaining({
        action: 'map_and_retry_webhook',
        id: 'w1',
        orderId: 'o1',
      })
    );
  });

  it('rejects unknown actions before touching the review service', async () => {
    const response = await POST(
      new Request('https://app.test/api/admin/recharge/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete_everything', id: 'x', reason: 'no' }),
      })
    );
    expect(response.status).toBe(400);
    expect(applyMock).not.toHaveBeenCalled();
  });
});
