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
  getAuthTokenSessionBinding: () => 'binding-register',
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

/* ------------------------------------------------------------------ */
/*  L6 / L7                                                            */
/* ------------------------------------------------------------------ */

import { Prisma } from '@prisma/client';

/** 真实的 P2002（唯一键冲突）—— 路由用 instanceof 判定，假对象过不去。 */
function duplicateEmailError() {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['email'] },
  });
}

describe('POST /api/auth/register —— L6 邮箱枚举 / L7 displayName 归一化', () => {
  const post = (body: Record<string, unknown>) =>
    POST(
      createJsonRequest('http://localhost/api/auth/register', {
        method: 'POST',
        body,
      })
    );

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

  const body = {
    email: 'user@example.com',
    password: 'Abcd1234',
    displayName: '张三',
  };

  /**
   * L6：邮箱已存在返 400、成功返 201 —— 光看状态码就能枚举已注册邮箱，
   * 与 forgot-password 的「恒定响应」标准不一致。
   * 开了邮箱验证时可以做到真正不可区分（成功路径本来也只回「请去查收」）。
   */
  it('开启邮箱验证时：邮箱已存在与注册成功的响应完全一致', async () => {
    const success = await post(body);
    const successJson = await readJson(success);

    registerWithOptionsMock.mockRejectedValueOnce(duplicateEmailError());
    const duplicate = await post(body);
    const duplicateJson = await readJson(duplicate);

    expect(duplicate.status).toBe(success.status);
    expect(duplicate.status).toBe(201);
    expect(duplicateJson).toEqual(successJson);
  });

  it('关闭邮箱验证时维持 400（成功路径必须下发会话，结构上藏不住），文案保持中性', async () => {
    getSiteSettingsMock.mockResolvedValue({
      ...BASE_SETTINGS,
      email_verification: false,
    });
    registerWithOptionsMock.mockRejectedValueOnce(duplicateEmailError());

    const res = await post(body);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(JSON.stringify(json)).not.toContain('user@example.com');
    expect(JSON.stringify(json)).not.toMatch(/exist|已存在|已被注册/i);
  });

  it('L7：displayName 落库前 trim + 截断到 64 字符', async () => {
    await post({ ...body, displayName: `  ${'字'.repeat(500)}  ` });

    expect(registerWithOptionsMock).toHaveBeenCalledTimes(1);
    const passed = registerWithOptionsMock.mock.calls[0][2] as string;
    expect(passed).toBe('字'.repeat(64));
  });

  it('L7：全空白 displayName 视为缺失（400）', async () => {
    const res = await post({ ...body, displayName: '   \t\n ' });
    expect(res.status).toBe(400);
    expect(registerWithOptionsMock).not.toHaveBeenCalled();
  });
});
