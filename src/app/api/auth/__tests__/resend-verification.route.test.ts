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
  loggerErrorMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  logActionMock: vi.fn(),
  isEmailEnabledMock: vi.fn(),
  sendVerificationEmailMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() },
  serializeError: (e: unknown) => e,
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

  // #12 时序枚举：账号存在且待验证的分支此前 await 完整 SMTP 往返（200ms~3s），
  // 其余分支立即返回 —— 响应文案一致也没用，耗时差本身就能筛出「哪些邮箱待验证」。
  // 这里不做墙钟断言（必然 flaky），改测结构属性：发信永远挂起时路由仍要能返回。
  it('不等待 SMTP 往返：发信挂起时依然立即返回', async () => {
    let releaseSend: (() => void) | undefined;
    sendVerificationEmailMock.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseSend = resolve;
      })
    );

    // 若实现改回 await，这里会一直挂着直到测试超时 → 红
    const res = await post('user@example.com');

    expect(res.status).toBe(200);
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
    releaseSend?.();
  });

  it('发信失败不影响对外响应，但要落错误日志', async () => {
    sendVerificationEmailMock.mockRejectedValue(new Error('smtp down'));

    const res = await post('user@example.com');
    expect(res.status).toBe(200);

    // fire-and-forget：断言前先排空微任务，否则 .catch 还没跑到
    await new Promise((r) => setTimeout(r, 0));
    expect(loggerErrorMock).toHaveBeenCalled();
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
