import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getHealthReportMock } = vi.hoisted(() => ({
  getHealthReportMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/serverSecrets', () => ({
  JWT_SECRET: 'health-test-jwt-secret-that-is-longer-than-thirty-two-bytes',
}));
vi.mock('@/lib/health', () => ({
  getHealthReport: getHealthReportMock,
}));

import { GET as getLiveness } from '@/app/api/health/route';
import { GET as getReadiness } from '@/app/api/health/ready/route';
import { deriveHealthReadinessToken } from '@/lib/healthReadiness';
import { deriveReadinessToken } from '../../../../../scripts/check-readiness.mjs';

const REPORT = {
  status: 'ok' as const,
  checkedAt: '2026-08-20T00:00:00.000Z',
  dependencies: {
    database: { status: 'up' as const, latencyMs: 1 },
    redis: { status: 'disabled' as const, latencyMs: null },
    cloudreve: { status: 'disabled' as const, latencyMs: null },
    websocket: { status: 'up' as const, latencyMs: 1 },
  },
};

describe('SEC-032 health endpoint split', () => {
  beforeEach(() => {
    getHealthReportMock.mockReset().mockResolvedValue(REPORT);
  });

  it('keeps public liveness constant-cost and dependency-free', async () => {
    const response = await getLiveness();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(getHealthReportMock).not.toHaveBeenCalled();
  });

  it('rejects deep readiness before any dependency probe', async () => {
    const response = await getReadiness(
      new Request('http://localhost/api/health/ready')
    );
    expect(response.status).toBe(401);
    expect(getHealthReportMock).not.toHaveBeenCalled();
  });

  it('authenticates internal checks and coalesces concurrent fanout', async () => {
    const token = deriveHealthReadinessToken();
    const request = () =>
      new Request('http://localhost/api/health/ready', {
        headers: { Authorization: `Bearer ${token}` },
      });

    const [first, second] = await Promise.all([
      getReadiness(request()),
      getReadiness(request()),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getHealthReportMock).toHaveBeenCalledTimes(1);
  });

  it('uses the exact same token derivation in the deployed probe script', () => {
    const secret = 'shared-health-secret-for-token-parity';
    expect(deriveHealthReadinessToken(secret)).toBe(
      deriveReadinessToken(secret)
    );
  });
});
