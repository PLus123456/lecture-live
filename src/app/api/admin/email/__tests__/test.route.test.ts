import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  getSiteSettingsMock,
  verifyEmailConnectionMock,
  sendMailWithConfigMock,
  trackJobMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  verifyEmailConnectionMock: vi.fn(),
  sendMailWithConfigMock: vi.fn(),
  trackJobMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
  SETTING_SECRET_MASK: '********',
}));
vi.mock('@/lib/email/mailer', () => ({
  verifyEmailConnection: verifyEmailConnectionMock,
  sendMailWithConfig: sendMailWithConfigMock,
}));
vi.mock('@/lib/email', () => ({
  getBrandCtx: () => ({ siteName: 'LectureLive', siteUrl: 'https://example.com' }),
}));
vi.mock('@/lib/email/templates', () => ({
  testEmail: () => ({ subject: 'Test', html: '<p>Test</p>', text: 'Test' }),
}));
vi.mock('@/lib/email/domains', () => ({
  normalizeEmail: (value: string) => value.trim().toLowerCase(),
  isValidEmailAddress: (value: string) => value.includes('@'),
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { ADMIN_INTEGRATION: 'admin_integration' },
  JOB_STATUS: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  trackJob: trackJobMock,
}));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
}));

import { POST } from '@/app/api/admin/email/test/route';

const txClient = { auditLog: {} };

function request(body: Record<string, unknown>) {
  return createJsonRequest('http://localhost/api/admin/email/test', {
    method: 'POST',
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminAccessMock.mockResolvedValue({
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    response: null,
  });
  getSiteSettingsMock.mockResolvedValue({ site_name: 'LectureLive' });
  verifyEmailConnectionMock.mockResolvedValue({ ok: true });
  sendMailWithConfigMock.mockResolvedValue({ ok: true });
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
      let result: unknown;
      try {
        result = await operation();
      } catch (error) {
        await options.terminalMutation?.(txClient, {
          status: 'FAILED',
          error,
        });
        throw error;
      }
      await options.terminalMutation?.(txClient, {
        status: 'SUCCESS',
        result,
      });
      return result;
    }
  );
});

describe('POST /api/admin/email/test durable audit', () => {
  it('连接测试先建 operation journal，终态审计使用同一事务且不保存凭据值', async () => {
    const res = await POST(
      request({
        smtp_host: 'smtp.private.example',
        smtp_user: 'secret-user',
        smtp_password: 'super-secret-password',
      })
    );

    expect(res.status).toBe(200);
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_integration',
        params: expect.objectContaining({
          operation: 'smtp_connection_test',
          passwordProvided: true,
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
        event: 'email.smtp_test',
        outcome: 'SUCCESS',
      }),
      txClient
    );
    const persisted = JSON.stringify({
      journal: trackJobMock.mock.calls[0]?.[0],
      audit: writeSecurityAuditMock.mock.calls[0]?.[1],
    });
    expect(persisted).not.toContain('smtp.private.example');
    expect(persisted).not.toContain('secret-user');
    expect(persisted).not.toContain('super-secret-password');
    expect(
      trackJobMock.mock.calls[0]?.[0].errorSummary(
        new Error('smtp://secret-user:super-secret-password@private.example')
      )
    ).toBe('SmtpConnectionTestError');
  });

  it('测试投递只持久化收件人 hash，不保存邮箱原文', async () => {
    const res = await POST(request({ sendTo: 'Recipient@Example.com' }));

    expect(res.status).toBe(200);
    const persisted = JSON.stringify({
      journal: trackJobMock.mock.calls[0]?.[0],
      audit: writeSecurityAuditMock.mock.calls[0]?.[1],
    });
    expect(persisted).not.toContain('recipient@example.com');
    expect(persisted).toContain('recipientHash');
  });

  it('SMTP 拒绝会可靠记录 FAILED 终态并保留原 400 语义', async () => {
    verifyEmailConnectionMock.mockResolvedValue({
      ok: false,
      error: 'authentication rejected',
    });

    const res = await POST(request({}));
    const body = await readJson<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe('authentication rejected');
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'email.smtp_test',
        outcome: 'FAILED',
      }),
      txClient
    );
  });

  it('外部发送成功但终态审计失败时 route 返回 500，不重复发送', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await POST(request({ sendTo: 'recipient@example.com' }));

    expect(res.status).toBe(500);
    expect(sendMailWithConfigMock).toHaveBeenCalledTimes(1);
  });
});
