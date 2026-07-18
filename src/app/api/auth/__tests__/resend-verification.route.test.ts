import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  findUniqueMock,
  getSiteSettingsMock,
  enforceRateLimitMock,
  logActionMock,
  isEmailEnabledMock,
  sendVerificationEmailMock,
  resolveRequestClientIpMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  logActionMock: vi.fn(),
  isEmailEnabledMock: vi.fn(),
  sendVerificationEmailMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: findUniqueMock } },
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

vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: resolveRequestClientIpMock,
}));

vi.mock('@/lib/email', () => ({
  isEmailEnabled: isEmailEnabledMock,
  sendVerificationEmail: sendVerificationEmailMock,
}));

import { POST } from '@/app/api/auth/resend-verification/route';

const UNVERIFIED_USER = {
  id: 'u1',
  email: 'user@example.com',
  displayName: '张三',
  status: 1,
  emailVerifiedAt: null,
};

describe('POST /api/auth/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSiteSettingsMock.mockResolvedValue({ email_verification: true });
    enforceRateLimitMock.mockResolvedValue(null);
    resolveRequestClientIpMock.mockReturnValue('unknown');
    isEmailEnabledMock.mockResolvedValue(true);
    sendVerificationEmailMock.mockResolvedValue({ ok: true });
    findUniqueMock.mockResolvedValue(UNVERIFIED_USER);
  });

  const post = (email: string) =>
    POST(
      createJsonRequest('http://localhost/api/auth/resend-verification', {
        method: 'POST',
        body: { email },
      })
    );

  it('门禁开启且账号待验证时重发验证邮件', async () => {
    const res = await post('user@example.com');
    expect(res.status).toBe(200);
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmailMock.mock.calls[0][0]).toMatchObject({ id: 'u1' });
  });

  // 回归防线：站点没开 email_verification 时，emailVerifiedAt 为空的账号照样能登录，
  // 「重发验证邮件」毫无业务意义。而 verify-email 消费令牌后是直接签发会话的，
  // 若此处不看开关，任何匿名者报一个已知邮箱就能让本站往对方投一封「一键登录」信。
  it('站点未开启邮箱验证时不得发信（即使账号 emailVerifiedAt 为空）', async () => {
    getSiteSettingsMock.mockResolvedValue({ email_verification: false });

    const res = await post('user@example.com');

    expect(res.status).toBe(200);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
    // 连用户都不该查——不给任何可观测差异
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('SMTP 未配置时不得发信', async () => {
    isEmailEnabledMock.mockResolvedValue(false);

    const res = await post('user@example.com');

    expect(res.status).toBe(200);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it('账号已验证时静默跳过', async () => {
    findUniqueMock.mockResolvedValue({ ...UNVERIFIED_USER, emailVerifiedAt: new Date() });

    const res = await post('user@example.com');

    expect(res.status).toBe(200);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it('账号被封禁时静默跳过', async () => {
    findUniqueMock.mockResolvedValue({ ...UNVERIFIED_USER, status: 0 });

    const res = await post('user@example.com');

    expect(res.status).toBe(200);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  // 防枚举：账号存在/不存在/已验证/门禁关闭，对外响应必须逐字节一致。
  it('所有分支返回完全相同的通用响应', async () => {
    const bodies: unknown[] = [];

    bodies.push(await readJson(await post('user@example.com')));

    findUniqueMock.mockResolvedValue(null);
    bodies.push(await readJson(await post('nobody@example.com')));

    findUniqueMock.mockResolvedValue({ ...UNVERIFIED_USER, emailVerifiedAt: new Date() });
    bodies.push(await readJson(await post('verified@example.com')));

    getSiteSettingsMock.mockResolvedValue({ email_verification: false });
    bodies.push(await readJson(await post('user@example.com')));

    for (const body of bodies) {
      expect(body).toEqual(bodies[0]);
    }
  });
});
