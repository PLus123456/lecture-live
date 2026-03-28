import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  loginMock,
  setAuthCookieMock,
  getSiteSettingsMock,
  enforceRateLimitMock,
  logActionMock,
} = vi.hoisted(() => ({
  loginMock: vi.fn(),
  setAuthCookieMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  logActionMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  CLIENT_SESSION_TOKEN: '__cookie_session__',
  getJwtExpiryConfig: (days?: number) => ({
    expiresInDays: days ?? 7,
    cookieMaxAge: (days ?? 7) * 24 * 60 * 60,
  }),
  login: loginMock,
  setAuthCookie: setAuthCookieMock,
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: logActionMock,
}));

import { POST } from '@/app/api/auth/login/route';

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    getSiteSettingsMock.mockResolvedValue({
      rate_limit_auth: 9,
      jwt_expiry: 14,
    });
    enforceRateLimitMock.mockResolvedValue(null);
    setAuthCookieMock.mockImplementation(
      (response: Response, token: string, options: { maxAge: number }) => {
        response.headers.set(
          'set-cookie',
          `lecture-live-token=${token}; Max-Age=${options.maxAge}; HttpOnly`
        );
      }
    );
  });

  it('返回登录用户并设置 HttpOnly cookie', async () => {
    loginMock.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'ADMIN',
      },
      token: 'server-jwt',
    });

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: {
          email: 'alice@example.com',
          password: 'Abcd1234',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, unknown>>(response)).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'ADMIN',
      },
      token: '__cookie_session__',
    });
    expect(loginMock).toHaveBeenCalledWith(
      'alice@example.com',
      'Abcd1234',
      expect.objectContaining({ jwtExpiryDays: 14 })
    );
    expect(setAuthCookieMock).toHaveBeenCalledWith(
      expect.any(Response),
      'server-jwt',
      expect.objectContaining({ maxAge: 14 * 24 * 60 * 60 })
    );
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(logActionMock).toHaveBeenCalledWith(
      expect.any(Request),
      'user.login',
      expect.objectContaining({
        user: expect.objectContaining({
          id: 'user-1',
          email: 'alice@example.com',
          role: 'ADMIN',
        }),
      })
    );
  });

  it('在缺少凭据时返回 400', async () => {
    const response = await POST(
      createJsonRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: { email: 'alice@example.com' },
      })
    );

    expect(response.status).toBe(400);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'email and password are required',
    });
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('在凭据错误时返回 401 并记录失败审计日志', async () => {
    loginMock.mockRejectedValue(new Error('Invalid credentials'));

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: {
          email: 'alice@example.com',
          password: 'wrong-password',
        },
      })
    );

    expect(response.status).toBe(401);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Invalid email or password',
    });
    expect(logActionMock).toHaveBeenCalledWith(
      expect.any(Request),
      'user.login.failed',
      expect.objectContaining({
        detail: expect.stringContaining('alice@example.com'),
      })
    );
  });
});
