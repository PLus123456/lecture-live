import { beforeEach, describe, expect, it, vi } from 'vitest';

const { compareMock, enforceRateLimitMock, userFindUniqueMock } = vi.hoisted(() => ({
  compareMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
}));

vi.mock('bcryptjs', () => ({ default: { compare: compareMock } }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: userFindUniqueMock } },
}));

import {
  LLM_RECENT_AUTH_REQUIRED,
  requireLlmAdminCurrentPassword,
} from '@/lib/llm/adminReauth';

const request = new Request('https://app.example/api/admin/llm-providers', {
  method: 'POST',
});

describe('inline LLM admin reauthentication', () => {
  beforeEach(() => {
    enforceRateLimitMock.mockReset().mockResolvedValue(null);
    userFindUniqueMock.mockReset().mockResolvedValue({ passwordHash: 'hash' });
    compareMock.mockReset().mockResolvedValue(true);
  });

  it('returns the shared generic challenge for a missing password', async () => {
    const result = await requireLlmAdminCurrentPassword(request, 'admin-1', undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: '需要重新验证当前管理员密码',
      code: LLM_RECENT_AUTH_REQUIRED,
    });
    expect(userFindUniqueMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong password without exposing why it failed', async () => {
    compareMock.mockResolvedValue(false);
    const result = await requireLlmAdminCurrentPassword(request, 'admin-1', 'wrong');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_or_invalid');
    expect(result.response.status).toBe(403);
  });

  it('accepts the current password through the bounded rate-limited path', async () => {
    const result = await requireLlmAdminCurrentPassword(request, 'admin-1', ' correct ');
    expect(result).toEqual({ ok: true });
    expect(compareMock).toHaveBeenCalledWith(' correct ', 'hash');
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        scope: 'admin:reauth:llm-provider',
        limit: 5,
        key: 'user:admin-1',
      })
    );
  });

  it('preserves the rate-limit response before doing a password lookup', async () => {
    const limited = new Response('limited', { status: 429 });
    enforceRateLimitMock.mockResolvedValue(limited);
    const result = await requireLlmAdminCurrentPassword(request, 'admin-1', 'password');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('rate_limited');
    expect(result.response.status).toBe(429);
    expect(userFindUniqueMock).not.toHaveBeenCalled();
  });
});
