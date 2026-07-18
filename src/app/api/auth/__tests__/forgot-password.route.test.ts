import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  findUniqueMock,
  getSiteSettingsMock,
  enforceRateLimitMock,
  logActionMock,
  isEmailEnabledMock,
  sendPasswordResetEmailMock,
  resolveRequestClientIpMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  logActionMock: vi.fn(),
  isEmailEnabledMock: vi.fn(),
  sendPasswordResetEmailMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: findUniqueMock } },
}));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: resolveRequestClientIpMock,
}));
vi.mock('@/lib/email', () => ({
  isEmailEnabled: isEmailEnabledMock,
  sendPasswordResetEmail: sendPasswordResetEmailMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() },
  serializeError: (e: unknown) => e,
}));

import { POST } from '@/app/api/auth/forgot-password/route';

const ACTIVE_USER = {
  id: 'u1',
  email: 'user@example.com',
  displayName: '张三',
  status: 1,
};

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSiteSettingsMock.mockResolvedValue({ email_verification: true });
    enforceRateLimitMock.mockResolvedValue(null);
    resolveRequestClientIpMock.mockReturnValue('unknown');
    isEmailEnabledMock.mockResolvedValue(true);
    sendPasswordResetEmailMock.mockResolvedValue({ ok: true });
    findUniqueMock.mockResolvedValue(ACTIVE_USER);
  });

  const post = (email: string) =>
    POST(
      createJsonRequest('http://localhost/api/auth/forgot-password', {
        method: 'POST',
        body: { email },
      })
    );

  it('正常账号发送重置邮件', async () => {
    const res = await post('user@example.com');
    expect(res.status).toBe(200);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmailMock.mock.calls[0][0]).toMatchObject({ id: 'u1' });
  });

  it('账号被封禁时静默跳过', async () => {
    findUniqueMock.mockResolvedValue({ ...ACTIVE_USER, status: 0 });
    const res = await post('user@example.com');
    expect(res.status).toBe(200);
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
  });

  // #12 时序枚举：账号存在的分支此前 await 完整 SMTP 往返（200ms~3s），不存在则立即返回。
  // 通用响应文案挡不住耗时差 —— 攻击者据此即可批量筛出「哪些邮箱注册过」。
  // 不做墙钟断言（必然 flaky），改测结构属性：发信永远挂起时路由仍要能返回。
  it('不等待 SMTP 往返：发信挂起时依然立即返回', async () => {
    let releaseSend: (() => void) | undefined;
    sendPasswordResetEmailMock.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseSend = resolve;
      })
    );

    // 若实现改回 await，这里会一直挂着直到测试超时 → 红
    const res = await post('user@example.com');

    expect(res.status).toBe(200);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
    releaseSend?.();
  });

  it('发信失败不影响对外响应，但要落错误日志', async () => {
    sendPasswordResetEmailMock.mockRejectedValue(new Error('smtp down'));

    const res = await post('user@example.com');
    expect(res.status).toBe(200);

    // fire-and-forget：断言前先排空微任务，否则 .catch 还没跑到
    await new Promise((r) => setTimeout(r, 0));
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  // 发信投递失败不该抹掉「用户发起过重置」这条审计——两者是不同的事实。
  it('审计日志不依赖投递成败', async () => {
    sendPasswordResetEmailMock.mockRejectedValue(new Error('smtp down'));

    await post('user@example.com');
    await new Promise((r) => setTimeout(r, 0));

    expect(logActionMock).toHaveBeenCalledWith(
      expect.anything(),
      'user.password.reset_requested',
      expect.anything()
    );
  });

  // 防枚举：账号存在/不存在/被封禁，对外响应必须逐字节一致。
  it('所有分支返回完全相同的通用响应', async () => {
    const bodies: unknown[] = [];

    bodies.push(await readJson(await post('user@example.com')));

    findUniqueMock.mockResolvedValue(null);
    bodies.push(await readJson(await post('nobody@example.com')));

    findUniqueMock.mockResolvedValue({ ...ACTIVE_USER, status: 0 });
    bodies.push(await readJson(await post('banned@example.com')));

    for (const body of bodies) {
      expect(body).toEqual(bodies[0]);
    }
  });
});
