import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  loginMock,
  setAuthCookieMock,
  getSiteSettingsMock,
  enforceRateLimitMock,
  logActionMock,
  isEmailEnabledMock,
  maybeNotifyNewDeviceLoginMock,
} = vi.hoisted(() => ({
  loginMock: vi.fn(),
  setAuthCookieMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  logActionMock: vi.fn(),
  isEmailEnabledMock: vi.fn(),
  maybeNotifyNewDeviceLoginMock: vi.fn(),
}));

vi.mock('@/lib/email', () => ({
  isEmailEnabled: isEmailEnabledMock,
}));

vi.mock('@/lib/email/loginAlert', () => ({
  maybeNotifyNewDeviceLogin: maybeNotifyNewDeviceLoginMock,
}));

vi.mock('@/lib/auth', () => ({
  CLIENT_SESSION_TOKEN: '__cookie_session__',
  EMAIL_NOT_VERIFIED_ERROR: 'Email not verified',
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
    isEmailEnabledMock.mockResolvedValue(false);
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

  // 邮箱验证硬门禁。此前服务端零覆盖：requireEmailVerified 被删掉、写反、或 && 改成 ||
  // 整个测试套件都不会红，唯一的"覆盖"是 e2e 里自己 mock 出来的 403 响应。
  describe('邮箱验证硬门禁', () => {
    const loginBody = {
      method: 'POST' as const,
      body: { email: 'alice@example.com', password: 'Abcd1234' },
    };

    it('开关开启且 SMTP 可用时，要求 login() 校验邮箱验证状态', async () => {
      getSiteSettingsMock.mockResolvedValue({ email_verification: true, jwt_expiry: 14 });
      isEmailEnabledMock.mockResolvedValue(true);
      loginMock.mockResolvedValue({
        user: { id: 'u1', email: 'alice@example.com', displayName: 'Alice', role: 'FREE' },
        token: 'server-jwt',
      });

      await POST(createJsonRequest('http://localhost:3000/api/auth/login', loginBody));

      expect(loginMock).toHaveBeenCalledWith(
        'alice@example.com',
        'Abcd1234',
        expect.objectContaining({ requireEmailVerified: true })
      );
    });

    it('未验证账号返回 403 + needsVerification（口令已核对正确才会走到这里）', async () => {
      getSiteSettingsMock.mockResolvedValue({ email_verification: true, jwt_expiry: 14 });
      isEmailEnabledMock.mockResolvedValue(true);
      loginMock.mockRejectedValue(new Error('Email not verified'));

      const response = await POST(
        createJsonRequest('http://localhost:3000/api/auth/login', loginBody)
      );

      expect(response.status).toBe(403);
      await expect(readJson<Record<string, unknown>>(response)).resolves.toMatchObject({
        needsVerification: true,
        email: 'alice@example.com',
      });
      expect(setAuthCookieMock).not.toHaveBeenCalled();
      expect(logActionMock).toHaveBeenCalledWith(
        expect.any(Request),
        'user.login.unverified',
        expect.objectContaining({ detail: expect.stringContaining('alice@example.com') })
      );
    });

    // fail-open：开关开着但 SMTP 没配时不得启用门禁，否则半配置的站点会把所有人锁在门外。
    it('SMTP 未配置时不启用门禁（fail-open）', async () => {
      getSiteSettingsMock.mockResolvedValue({ email_verification: true, jwt_expiry: 14 });
      isEmailEnabledMock.mockResolvedValue(false);
      loginMock.mockResolvedValue({
        user: { id: 'u1', email: 'alice@example.com', displayName: 'Alice', role: 'FREE' },
        token: 'server-jwt',
      });

      await POST(createJsonRequest('http://localhost:3000/api/auth/login', loginBody));

      expect(loginMock).toHaveBeenCalledWith(
        'alice@example.com',
        'Abcd1234',
        expect.objectContaining({ requireEmailVerified: false })
      );
    });

    it('开关关闭时不启用门禁（即使 SMTP 可用）', async () => {
      getSiteSettingsMock.mockResolvedValue({ email_verification: false, jwt_expiry: 14 });
      isEmailEnabledMock.mockResolvedValue(true);
      loginMock.mockResolvedValue({
        user: { id: 'u1', email: 'alice@example.com', displayName: 'Alice', role: 'FREE' },
        token: 'server-jwt',
      });

      await POST(createJsonRequest('http://localhost:3000/api/auth/login', loginBody));

      expect(loginMock).toHaveBeenCalledWith(
        'alice@example.com',
        'Abcd1234',
        expect.objectContaining({ requireEmailVerified: false })
      );
    });
  });
});
