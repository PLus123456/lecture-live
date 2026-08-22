import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeRawMock } = vi.hoisted(() => ({ executeRawMock: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: { $executeRaw: executeRawMock },
}));

import { expirePendingPaymentOrders } from '@/lib/payment/orderExpiry';

beforeEach(() => executeRawMock.mockReset());

describe('SEC-029 pending payment expiry sweep', () => {
  it('atomically advances only pending+unclaimed orders whose expiresAt elapsed', async () => {
    executeRawMock.mockResolvedValueOnce(3);
    const now = new Date('2026-08-20T10:00:00.000Z');

    await expect(expirePendingPaymentOrders(now)).resolves.toBe(3);

    const [sql, ...values] = executeRawMock.mock.calls[0];
    expect(String(sql)).toMatch(/status = 'pending'[\s\S]*fulfillmentStatus = 'pending'/);
    expect(String(sql)).toContain('expiresAt <=');
    expect(values).toContain(now);
  });

  it('rejects an invalid maintenance clock instead of expiring every order by coercion', async () => {
    await expect(expirePendingPaymentOrders(new Date(Number.NaN))).rejects.toThrow(
      'invalid payment expiry timestamp'
    );
    expect(executeRawMock).not.toHaveBeenCalled();
  });
});
