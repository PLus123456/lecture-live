import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

// #10 / #11：注册路由的两条「静默」缺陷。
// @/lib/email/domains 保持真实——白名单 fail-closed 正是要验的行为。
const {
  getSiteSettingsMock,
  enforceRateLimitMock,
  logActionMock,
  resolveRequestClientIpMock,
  isEmailEnabledMock,
  sendVerificationEmailMock,
  registerWithOptionsMock,
  validatePasswordMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  getSiteSettingsMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  logActionMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
  isEmailEnabledMock: vi.fn(),
  sendVerificationEmailMock: vi.fn(),
  registerWithOptionsMock: vi.fn(),
  validatePasswordMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: resolveRequestClientIpMock,
}));
vi.mock('@/lib/email', () => ({
  isEmailEnabled: isEmailEnabledMock,
  sendVerificationEmail: sendVerificationEmailMock,
}));
vi.mock('@/lib/userRoles', () => ({
  resolvePublicRegistrationRole: () => 'FREE',
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() },
  serializeError: (e: unknown) => e,
}));
vi.mock('@/lib/auth', () => ({
  CLIENT_SESSION_TOKEN: 'client-session',
  getJwtExpiryConfig: () => ({ expiresInDays: 7, cookieMaxAge: 604800 }),
  registerWithOptions: registerWithOptionsMock,
  setAuthCookie: vi.fn(),
  validatePassword: validatePasswordMock,
}));

import { POST } from '@/app/api/auth/register/route';

const BASE_SETTINGS = {
  allow_registration: true,
  rate_limit_auth: 5,
  password_min_length: 8,
  bcrypt_rounds: 10,
  jwt_expiry: '7d',
  email_verification: true,
  default_group: 'FREE',
  block_disposable_email: false,
  disposable_email_extra: '',
  email_domain_allowlist: '',
  email_domain_allowlist_enforce: false,
};

const CREATED_USER = {
  id: 'u1',
  email: 'user@example.com',
  displayName: '张三',
  role: 'FREE',
};

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSiteSettingsMock.mockResolvedValue({ ...BASE_SETTINGS });
    enforceRateLimitMock.mockResolvedValue(null);
    resolveRequestClientIpMock.mockReturnValue('unknown');
    isEmailEnabledMock.mockResolvedValue(true);
    sendVerificationEmailMock.mockResolvedValue({ ok: true });
    validatePasswordMock.mockReturnValue(null);
    registerWithOptionsMock.mockResolvedValue({
      user: CREATED_USER,
      token: 'jwt',
    });
  });

  const post = (body: Record<string, unknown>) =>
    POST(
      createJsonRequest('http://localhost/api/auth/register', {
        method: 'POST',
        body,
      })
    );

  const validBody = {
    email: 'user@example.com',
    password: 'passw0rd',
    displayName: '张三',
  };

  it('发信成功时回「请前往邮箱验证」，不带失败标记', async () => {
    const res = await post(validBody);
    expect(res.status).toBe(201);
    const body = await readJson<Record<string, unknown>>(res);
    expect(body.verificationRequired).toBe(true);
    expect(body.emailSendFailed).toBeUndefined();
  });

  // #11：账号已创建但验证信没发出去。旧实现只 logger.warn，照样回「请前往邮箱完成验证」，
  // 用户空等一封不存在的邮件，而邮箱已被占用 → 重注册 P2002、登录 403、重置走同一坏 SMTP。
  it('验证邮件发送失败 → 如实回 emailSendFailed 而不是「请查收」', async () => {
    sendVerificationEmailMock.mockResolvedValue({ ok: false, error: 'smtp down' });

    const res = await post(validBody);
    const body = await readJson<Record<string, unknown>>(res);

    expect(body.verificationRequired).toBe(true);
    expect(body.emailSendFailed).toBe(true);
    expect(body.message).not.toContain('请前往邮箱');
    // 运维要能在日志里看见——这类故障此前只有 warn，淹没在噪音里
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it('sendVerificationEmail 抛错同样计为发送失败', async () => {
    sendVerificationEmailMock.mockRejectedValue(new Error('connection refused'));

    const res = await post(validBody);
    const body = await readJson<Record<string, unknown>>(res);
    expect(body.emailSendFailed).toBe(true);
  });

  // 发信失败不得 fail-open 放行：那会让攻击者打爆 SMTP 即可绕过邮箱验证门禁。
  it('发信失败时不签发会话、不把账号标成已验证', async () => {
    sendVerificationEmailMock.mockResolvedValue({ ok: false });

    const res = await post(validBody);
    const body = await readJson<Record<string, unknown>>(res);

    expect(body.token).toBeUndefined();
    expect(registerWithOptionsMock.mock.calls[0][3]).toMatchObject({
      emailVerified: false,
    });
  });

  // #10：白名单强制开着，但管理员填的条目一条都没解析出来。
  it('白名单配置坏掉时拒绝注册（fail-closed）并回 503', async () => {
    getSiteSettingsMock.mockResolvedValue({
      ...BASE_SETTINGS,
      email_domain_allowlist: '*.edu.cn',
      email_domain_allowlist_enforce: true,
    });

    const res = await post(validBody);

    expect(res.status).toBe(503);
    expect(registerWithOptionsMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalled();
  });
});
