import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  getRechargeSettingsMock,
  updateRechargeSettingsMock,
  serializeRechargeSettingsForAdminMock,
  logActionMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  getRechargeSettingsMock: vi.fn(),
  updateRechargeSettingsMock: vi.fn(),
  serializeRechargeSettingsForAdminMock: vi.fn(),
  logActionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (_scope: string, handler: (req: Request) => Promise<Response>) => handler,
}));
vi.mock('@/lib/siteSettings', () => ({ SETTING_SECRET_MASK: '[REDACTED]' }));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
}));
vi.mock('@/lib/payment/settings', () => ({
  getRechargeSettings: getRechargeSettingsMock,
  updateRechargeSettings: updateRechargeSettingsMock,
  serializeRechargeSettingsForAdmin: serializeRechargeSettingsForAdminMock,
  RechargeSettingsError: class RechargeSettingsError extends Error {
    readonly status = 400;
    constructor(message: string) {
      super(message);
      this.name = 'RechargeSettingsError';
    }
  },
}));

import { GET, PUT } from '@/app/api/admin/recharge/settings/route';
import { RechargeSettingsError } from '@/lib/payment/settings';

const CTX = { params: Promise.resolve({}) } as never;
const ADMIN = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };
const SETTINGS = {
  enabled: true,
  currencySymbol: '¥',
  currency: 'CNY',
  alipayEnabled: false,
  wechatEnabled: false,
  stripeEnabled: true,
  sandboxEnabled: false,
  alipayAppId: '',
  alipayPrivateKey: '',
  alipayPublicKey: '',
  alipaySellerId: '',
  alipayGateway: 'https://example.invalid',
  wechatAppId: '',
  wechatMchId: '',
  wechatApiV3Key: '',
  wechatSerialNo: '',
  wechatPrivateKey: '',
  wechatPlatformCert: '',
  stripeSecretKey: 'sk_live_existing',
  stripeWebhookSecret: 'whsec_live_existing',
  stripePublishableKey: 'pk_live_public',
};

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  getRechargeSettingsMock.mockReset();
  updateRechargeSettingsMock.mockReset();
  serializeRechargeSettingsForAdminMock.mockReset();
  logActionMock.mockReset();
  writeSecurityAuditMock.mockReset();
  getSecurityAuditRequestIdMock.mockReset();

  requireAdminAccessMock.mockResolvedValue({ user: ADMIN, response: null });
  getRechargeSettingsMock.mockResolvedValue(SETTINGS);
  updateRechargeSettingsMock.mockResolvedValue(undefined);
  serializeRechargeSettingsForAdminMock.mockImplementation((settings: typeof SETTINGS) => ({
    ...settings,
    alipayPrivateKey: settings.alipayPrivateKey ? '[REDACTED]' : '',
    wechatApiV3Key: settings.wechatApiV3Key ? '[REDACTED]' : '',
    wechatPrivateKey: settings.wechatPrivateKey ? '[REDACTED]' : '',
    stripeSecretKey: settings.stripeSecretKey ? '[REDACTED]' : '',
    stripeWebhookSecret: settings.stripeWebhookSecret ? '[REDACTED]' : '',
  }));
  writeSecurityAuditMock.mockResolvedValue({ requestId: 'req-1', action: 'audit' });
  getSecurityAuditRequestIdMock.mockReturnValue('req-1');
});

const get = () =>
  GET(new Request('http://localhost/api/admin/recharge/settings'), CTX);
const put = (body: unknown) =>
  PUT(
    createJsonRequest('http://localhost/api/admin/recharge/settings', {
      method: 'PUT',
      body,
    }),
    CTX
  );

describe('SEC-033 /api/admin/recharge/settings GET', () => {
  it('正常返回脱敏配置前等待 SUCCESS 安全审计', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      settings: { stripeSecretKey: '[REDACTED]', stripeWebhookSecret: '[REDACTED]' },
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'recharge.settings.read',
        operator: ADMIN,
        target: { type: 'recharge_settings', id: 'global' },
        reason: 'admin_list',
        outcome: 'SUCCESS',
      })
    );
  });

  it('安全审计拒绝时返回 503，且不返回已组装配置', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await get();
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(body).not.toContain('pk_live_public');
    expect(body).not.toContain('[REDACTED]');
  });
});

describe('SEC-033 /api/admin/recharge/settings PUT', () => {
  it('以同一 requestId 写 ATTEMPTED/SUCCESS，提交凭据只审计 changed=true', async () => {
    const res = await put({
      stripeSecretKey: 'sk_live_new_secret',
      stripeWebhookSecret: 'whsec_live_new_secret',
      stripeEnabled: true,
      unknownNote: 'audit-injection-secret',
    });

    expect(res.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledTimes(2);
    const attempted = writeSecurityAuditMock.mock.calls[0][1];
    const succeeded = writeSecurityAuditMock.mock.calls[1][1];
    expect(attempted).toMatchObject({
      event: 'recharge.settings.update',
      outcome: 'ATTEMPTED',
      requestId: 'req-1',
      before: { stripeSecretKey: '[REDACTED]', stripeWebhookSecret: '[REDACTED]' },
      after: {
        stripeSecretKey: { changed: true },
        stripeWebhookSecret: { changed: true },
        stripeEnabled: true,
      },
      metadata: {
        changedFields: ['stripeSecretKey', 'stripeWebhookSecret', 'stripeEnabled'],
      },
    });
    expect(succeeded).toMatchObject({ outcome: 'SUCCESS', requestId: 'req-1' });

    const securityEvents = JSON.stringify(writeSecurityAuditMock.mock.calls.map((call) => call[1]));
    const legacyDetail = String(logActionMock.mock.calls[0][2].detail);
    expect(securityEvents).not.toContain('sk_live_new_secret');
    expect(securityEvents).not.toContain('whsec_live_new_secret');
    expect(securityEvents).not.toContain('audit-injection-secret');
    expect(legacyDetail).not.toContain('sk_live_new_secret');
    expect(legacyDetail).not.toContain('whsec_live_new_secret');
  });

  it('ATTEMPTED 审计失败时不执行配置更新', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await put({ enabled: false });

    expect(res.status).toBe(503);
    expect(updateRechargeSettingsMock).not.toHaveBeenCalled();
  });

  it('配置校验异常写 FAILED 后保留原有 400 语义', async () => {
    updateRechargeSettingsMock.mockRejectedValueOnce(
      new RechargeSettingsError('币种配置无效')
    );

    const res = await put({ currency: 'INVALID' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '币种配置无效' });
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'FAILED',
    ]);
    expect(writeSecurityAuditMock.mock.calls[1][1]).toMatchObject({
      requestId: 'req-1',
      metadata: { changedFields: ['currency'], errorType: 'RechargeSettingsError' },
    });
  });

  it('非事务配置写入异常保守记录 PARTIAL，不伪造完整失败', async () => {
    updateRechargeSettingsMock.mockRejectedValueOnce(new Error('upsert failed'));

    await expect(put({ currency: 'GBP' })).rejects.toThrow('upsert failed');

    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'PARTIAL',
    ]);
    expect(writeSecurityAuditMock.mock.calls[1][1]).toMatchObject({
      metadata: { failureStage: 'write_or_reload' },
    });
  });

  it('SUCCESS 完成审计失败时返回 503，且不泄露配置 payload', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    writeSecurityAuditMock
      .mockResolvedValueOnce({ requestId: 'req-1', action: 'attempt' })
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await put({ currency: 'GBP' });
    const body = await res.text();

    expect(updateRechargeSettingsMock).toHaveBeenCalledWith({ currency: 'GBP' });
    expect(res.status).toBe(503);
    expect(body).not.toContain('pk_live_public');
  });
});
