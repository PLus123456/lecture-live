import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({ getRedisClient: () => null }));
vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: () => '203.0.113.7',
}));

import { enforceRateLimit } from '@/lib/rateLimit';

const MEMORY_STORE_KEY = '__lectureLiveRateLimitStore';

describe('SEC-007 rate-limit memory fallback cardinality', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[MEMORY_STORE_KEY];
  });

  it('never grows past the hard cap or evicts live security buckets', async () => {
    const req = new Request('http://localhost/api/auth/login');
    const options = {
      scope: 'auth:account-cardinality-test',
      limit: 10,
      windowMs: 60_000,
    };

    for (let index = 0; index < 5000; index += 1) {
      await expect(
        enforceRateLimit(req, { ...options, key: `email:sha256:${index}` })
      ).resolves.toBeNull();
    }

    const originalBucket = (
      globalThis as unknown as Record<string, Map<string, { count: number }>>
    )[MEMORY_STORE_KEY].get(
      'ratelimit:auth:account-cardinality-test:email:sha256:0'
    );
    const overflow = await enforceRateLimit(req, {
      ...options,
      key: 'email:sha256:overflow',
    });

    expect(overflow?.status).toBe(429);
    const store = (
      globalThis as unknown as Record<string, Map<string, { count: number }>>
    )[MEMORY_STORE_KEY];
    expect(store.size).toBe(5000);
    expect(store.get('ratelimit:auth:account-cardinality-test:email:sha256:0')).toBe(
      originalBucket
    );
    expect(
      store.has('ratelimit:auth:account-cardinality-test:email:sha256:overflow')
    ).toBe(false);
  });
});
