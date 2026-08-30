import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

afterEach(() => {
  delete process.env.PAYMENT_RECONCILIATION_MAINTENANCE;
});

describe('Stripe history reconciliation maintenance isolation', () => {
  it.each([
    '/api/wallet/callback/stripe',
    '/api/wallet/checkout',
    '/api/sessions/s1/full-transcribe',
    '/api/setup',
    '/api/share/view/token',
  ])('blocks normal and public capability %s before route handling', async (pathname) => {
    process.env.PAYMENT_RECONCILIATION_MAINTENANCE = '1';
    const response = await middleware(
      new NextRequest(`https://app.test${pathname}`, { method: 'POST' })
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'payment reconciliation maintenance',
    });
  });

  it('allows only login and the authenticated admin review API through the maintenance edge', async () => {
    process.env.PAYMENT_RECONCILIATION_MAINTENANCE = '1';
    const login = await middleware(
      new NextRequest('https://app.test/api/auth/login', { method: 'POST' })
    );
    expect(login.status).toBe(200);

    // The edge still applies its normal JWT guard to ADMIN review; anonymous maintenance users
    // cannot reach the route merely because the narrow path is allowed.
    const review = await middleware(
      new NextRequest('https://app.test/api/admin/recharge/reviews')
    );
    expect(review.status).toBe(401);
  });
});
