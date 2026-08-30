import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

/**
 * #14 群发端点。群发不可撤回，所以这里主要盯"不该发的时候一封都别发"。
 */

const {
  requireAdminAccessMock,
  getSiteSettingsMock,
  findBroadcastRecipientsMock,
  runBroadcastMock,
  sendGenericNotificationEmailMock,
  trackJobMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  findBroadcastRecipientsMock: vi.fn(),
  runBroadcastMock: vi.fn(),
  sendGenericNotificationEmailMock: vi.fn(),
  trackJobMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { ADMIN_INTEGRATION: 'admin_integration' },
  JOB_STATUS: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  trackJob: trackJobMock,
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
    getSecurityAuditRequestIdMock.mockReturnValue('server-request-id');
    writeSecurityAuditMock.mockResolvedValue({
      requestId: 'server-request-id',
      action: 'admin.security.email.test',
    });
    trackJobMock.mockImplementation(
      async (
        options: {
          terminalMutation?: (
            tx: unknown,
            terminal: { status: string; result?: unknown; error?: unknown }
          ) => Promise<void>;
        },
        operation: () => Promise<unknown>
      ) => {
        const tx = { auditLog: {} };
        let result: unknown;
        try {
          result = await operation();
        } catch (error) {
          await options.terminalMutation?.(tx, { status: 'FAILED', error });
          throw error;
        }
        await options.terminalMutation?.(tx, { status: 'SUCCESS', result });
        return result;
      }
    );
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
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'email.broadcast_preview',
        outcome: 'SUCCESS',
        requestId: 'server-request-id',
      })
    );
  });

  it('未知 mode 同样退化成预览而不是发送', async () => {
    const res = await post({ ...VALID, mode: 'SEND' });
    const body = await readJson<Record<string, unknown>>(res);
    expect(body.mode).toBe('preview');
    expect(runBroadcastMock).not.toHaveBeenCalled();
  });

  it('mode=send 先建立 durable journal，再 await 派发与终态审计', async () => {
    const res = await post({ ...VALID, mode: 'send' });
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.dispatched).toBe(2);
    expect(runBroadcastMock).toHaveBeenCalledTimes(1);
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_integration',
        triggeredBy: 'admin:admin-1',
        params: expect.objectContaining({
          operation: 'email_broadcast',
          requestId: 'server-request-id',
        }),
        errorSummary: expect.any(Function),
        terminalMutation: expect.any(Function),
      }),
      expect.any(Function)
    );
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'email.broadcast',
        outcome: 'SUCCESS',
      }),
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

  it('preview 安全审计失败时返回 500 且不泄露收件人数', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await post(VALID);

    expect(res.status).toBe(500);
  });

  it('durable params 与结构化审计不保存正文、凭据或 CTA query', async () => {
    const sensitive = {
      ...VALID,
      mode: 'send',
      subject: 'private-subject-value',
      bodyText: 'private-body-value',
      cta: {
        url: 'https://example.com/path?api_key=super-secret-value',
        label: 'private-label-value',
      },
    };

    const res = await post(sensitive);

    expect(res.status).toBe(200);
    const persisted = JSON.stringify({
      journal: trackJobMock.mock.calls[0]?.[0],
      audits: writeSecurityAuditMock.mock.calls.map((call) => call[1]),
    });
    expect(persisted).not.toContain('private-subject-value');
    expect(persisted).not.toContain('private-body-value');
    expect(persisted).not.toContain('private-label-value');
    expect(persisted).not.toContain('api_key');
    expect(persisted).not.toContain('super-secret-value');
    expect(
      trackJobMock.mock.calls[0]?.[0].errorSummary(
        new Error('smtp body api_key=super-secret-value')
      )
    ).toBe('EmailBroadcastError');
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
