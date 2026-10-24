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
  LOGIN_THROTTLED_ERROR: 'Login throttled',
  getJwtExpiryConfig: (days?: number) => ({
    expiresInDays: days ?? 7,
    cookieMaxAge: (days ?? 7) * 24 * 60 * 60,
  }),
  getAuthTokenSessionBinding: () => 'binding-login',
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

  it('拒绝 sibling-origin text/plain login CSRF，且绝不签发/写 cookie', async () => {
    const response = await POST(
      new Request('https://app.example/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'same-site',
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({
          email: 'attacker@example.com',
          password: 'Password1',
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
    expect(loginMock).not.toHaveBeenCalled();
    expect(setAuthCookieMock).not.toHaveBeenCalled();
  });

  it('全局门禁在读取正文、站点设置和账号桶之前拒绝', async () => {
    const getReader = vi.fn();
    const blocked = new Response('limited', { status: 429 });
    enforceRateLimitMock.mockResolvedValueOnce(blocked);
    const request = {
      headers: new Headers(),
      body: { getReader },
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(getReader).not.toHaveBeenCalled();
    expect(getSiteSettingsMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).toHaveBeenCalledTimes(1);
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ scope: 'auth:public:global', key: 'global' })
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
      sessionBinding: 'binding-login',
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
    const accountGate = enforceRateLimitMock.mock.calls.find(
      ([, options]) => options.scope === 'auth:login'
    )?.[1];
    expect(accountGate?.key).toMatch(/^email:sha256:[a-f0-9]{64}$/);
    expect(accountGate?.key).not.toContain('alice@example.com');
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

  describe('畸形入参 / 设置不可用 / 按账号限流', () => {
    const post = (body: unknown) =>
      POST(
        createJsonRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body,
        })
      );

    // 旧实现 normalizeEmail 在 try 之外对非字符串抛 TypeError → 框架 500。
    it('非字符串 email / password 回 400，绝不进入 login()', async () => {
      for (const body of [
        { email: 123, password: 'Abcd1234' },
        { email: ['alice@example.com'], password: 'Abcd1234' },
        { email: { $ne: '' }, password: 'Abcd1234' },
        { email: 'alice@example.com', password: 12345678 },
      ]) {
        const response = await post(body);
        expect(response.status).toBe(400);
      }
      expect(loginMock).not.toHaveBeenCalled();
    });

    // 旧实现 getSiteSettings().catch(() => null) 后 requireEmailVerified 恒 false：DB 一抖，
    // 未验证账号就能登录。
    it('站点设置读不出来时回 503，不在丢掉邮箱验证门禁的情况下继续登录', async () => {
      getSiteSettingsMock.mockRejectedValue(new Error('db down'));

      const response = await post({ email: 'alice@example.com', password: 'Abcd1234' });

      expect(response.status).toBe(503);
      expect(loginMock).not.toHaveBeenCalled();
      expect(setAuthCookieMock).not.toHaveBeenCalled();
    });

    // utf8mb4_unicode_ci 下 'alïce@example.com' 与 'alice@example.com' 相等，却换出新的 email 桶。
    it('非 ASCII 写法直接回通用 401，不查库、不跑口令比对', async () => {
      for (const email of ['alïce@example.com', 'ａlice@example.com', 'ali​ce@example.com']) {
        const response = await post({ email, password: 'Abcd1234' });
        expect(response.status).toBe(401);
        await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
          error: 'Invalid email or password',
        });
      }
      expect(loginMock).not.toHaveBeenCalled();
    });

    it('无点域名等存量 ASCII 邮箱照常交给 login()（不被严格格式校验锁在门外）', async () => {
      loginMock.mockResolvedValue({
        user: { id: 'admin-1', email: 'admin@localhost', displayName: 'Admin', role: 'ADMIN' },
        token: 'server-jwt',
      });

      const response = await post({ email: 'admin@localhost', password: 'Abcd1234' });

      expect(response.status).toBe(200);
      expect(loginMock).toHaveBeenCalledWith(
        'admin@localhost',
        'Abcd1234',
        expect.any(Object)
      );
    });

    it('账号级桶按 user.id 计数；命中时把限流响应原样回给客户端', async () => {
      const limited = new Response('{"error":"Too many requests"}', {
        status: 429,
        headers: { 'Retry-After': '42' },
      });
      enforceRateLimitMock.mockImplementation(
        async (_req: Request, options: { scope: string }) =>
          options.scope === 'auth:login:user' ? limited : null
      );
      loginMock.mockImplementation(
        async (
          _email: string,
          _password: string,
          options: { beforePasswordCheck?: (userId: string) => Promise<boolean> }
        ) => {
          if (options.beforePasswordCheck && !(await options.beforePasswordCheck('user-1'))) {
            throw new Error('Login throttled');
          }
          throw new Error('unreachable');
        }
      );

      const response = await post({ email: 'alice@example.com', password: 'Abcd1234' });

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('42');
      const userGate = enforceRateLimitMock.mock.calls.find(
        ([, options]) => options.scope === 'auth:login:user'
      )?.[1];
      expect(userGate).toMatchObject({ key: 'user:user-1', limit: 9 });
      expect(setAuthCookieMock).not.toHaveBeenCalled();
    });
  });
});
