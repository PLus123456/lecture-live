import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

/**
 * #14 群发端点。群发不可撤回，所以这里主要盯"不该发的时候一封都别发"。
 */

const {
  requireAdminAccessMock,
  getSiteSettingsMock,
  logActionMock,
  findBroadcastRecipientsMock,
  runBroadcastMock,
  sendGenericNotificationEmailMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  logActionMock: vi.fn(),
  findBroadcastRecipientsMock: vi.fn(),
  runBroadcastMock: vi.fn(),
  sendGenericNotificationEmailMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => e,
}));
vi.mock('@/lib/email', () => ({
  sendGenericNotificationEmail: sendGenericNotificationEmailMock,
}));
vi.mock('@/lib/email/broadcast', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email/broadcast')>(
    '@/lib/email/broadcast'
  );
  return {
    ...actual,
    findBroadcastRecipients: findBroadcastRecipientsMock,
    runBroadcast: runBroadcastMock,
  };
});

import { POST } from '@/app/api/admin/email/broadcast/route';

const VALID = {
  category: 'product_updates',
  subject: '新版本发布',
  heading: '本月更新',
  bodyText: '我们上线了若干新功能。',
};

const post = (body: Record<string, unknown>) =>
  POST(
    createJsonRequest('http://localhost/api/admin/email/broadcast', {
      method: 'POST',
      body,
    })
  );

describe('POST /api/admin/email/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ marketing_emails_enabled: true });
    findBroadcastRecipientsMock.mockResolvedValue({
      users: [
        { id: 'u1', email: 'u1@example.com', displayName: 'u1' },
        { id: 'u2', email: 'u2@example.com', displayName: 'u2' },
      ],
      truncated: false,
    });
    runBroadcastMock.mockResolvedValue({ sent: 2, skipped: 0, failed: 0 });
    sendGenericNotificationEmailMock.mockResolvedValue({ ok: true });
  });

  // 群发不可撤回：请求体没写 mode 就绝不能发出去。
  it('缺省 mode 只做预览，不发任何信', async () => {
    const res = await post(VALID);
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.mode).toBe('preview');
    expect(body.recipientCount).toBe(2);
    expect(runBroadcastMock).not.toHaveBeenCalled();
    expect(sendGenericNotificationEmailMock).not.toHaveBeenCalled();
  });

  it('未知 mode 同样退化成预览而不是发送', async () => {
    const res = await post({ ...VALID, mode: 'SEND' });
    const body = await readJson<Record<string, unknown>>(res);
    expect(body.mode).toBe('preview');
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('mode=send 才真正派发，且不阻塞响应', async () => {
    // 派发任务永不 resolve：若路由 await 了它，这里会挂到超时
    runBroadcastMock.mockReturnValue(new Promise(() => {}));

    const res = await post({ ...VALID, mode: 'send' });
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.dispatched).toBe(2);
    expect(runBroadcastMock).toHaveBeenCalledTimes(1);
    expect(logActionMock).toHaveBeenCalledWith(
      expect.anything(),
      'admin.email.broadcast.send',
      expect.anything()
    );
  });

  it('mode=test 只发给管理员自己，不碰收件人列表', async () => {
    const res = await post({ ...VALID, mode: 'test' });
    const body = await readJson<Record<string, unknown>>(res);

    expect(body.sentTo).toBe('admin@test.com');
    expect(sendGenericNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendGenericNotificationEmailMock.mock.calls[0][0]).toMatchObject({
      email: 'admin@test.com',
    });
    expect(findBroadcastRecipientsMock).not.toHaveBeenCalled();
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('非法分类被拒（不能借此绕开偏好体系发事务类邮件）', async () => {
    const res = await post({ ...VALID, category: 'security_alert', mode: 'send' });
    expect(res.status).toBe(400);
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('非法收件范围被拒', async () => {
    const res = await post({ ...VALID, audience: 'EVERYONE', mode: 'send' });
    expect(res.status).toBe(400);
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('内容为空被拒', async () => {
    const res = await post({ ...VALID, bodyText: '   ', mode: 'send' });
    expect(res.status).toBe(400);
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('收件人为 0 时不派发，并说明原因', async () => {
    findBroadcastRecipientsMock.mockResolvedValue({ users: [], truncated: false });
    getSiteSettingsMock.mockResolvedValue({ marketing_emails_enabled: false });

    const res = await post({ ...VALID, mode: 'send' });
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(400);
    expect(String(body.error)).toContain('营销邮件总开关');
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('CTA 只填一半被拒', async () => {
    const res = await post({ ...VALID, mode: 'send', cta: { url: 'https://x.com' } });
    expect(res.status).toBe(400);
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('CTA 非 http(s) 链接被拒', async () => {
    const res = await post({
      ...VALID,
      mode: 'send',
      cta: { url: 'javascript:alert(1)', label: '点我' },
    });
    expect(res.status).toBe(400);
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('非管理员被挡在门外', async () => {
    requireAdminAccessMock.mockResolvedValue({
      user: null,
      response: new Response(JSON.stringify({ error: '权限不足' }), { status: 403 }),
    });

    const res = await post({ ...VALID, mode: 'send' });
    expect(res.status).toBe(403);
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });
});
