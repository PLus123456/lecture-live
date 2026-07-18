import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTransportMock, verifyMock, sendMailMock, getSiteSettingsMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
  verifyMock: vi.fn(),
  sendMailMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
}));

import { verifyEmailConnection, sendMailWithConfig } from '@/lib/email/mailer';

const SAVED = {
  smtp_host: 'smtp.saved.example.com',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: 'noreply@saved.example.com',
  smtp_password: 'SAVED-SECRET',
  sender_email: 'noreply@saved.example.com',
  sender_name: 'LectureLive',
  site_name: 'LectureLive',
};

/** 取本次 createTransport 收到的配置。 */
const lastTransportConfig = () =>
  createTransportMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

describe('resolveConfigWithOverride —— 已保存 SMTP 密码的外泄防线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSiteSettingsMock.mockResolvedValue(SAVED);
    verifyMock.mockResolvedValue(true);
    sendMailMock.mockResolvedValue({ messageId: 'mid-1' });
    createTransportMock.mockReturnValue({
      verify: verifyMock,
      sendMail: sendMailMock,
      close: vi.fn(),
    });
  });

  // 核心回归：改了 host 却不填密码时，绝不能把已存密码发到对方主机去做 AUTH。
  it('覆盖 host 但未提供密码时拒绝执行，且不建立任何连接', async () => {
    const result = await verifyEmailConnection({ host: 'mx.attacker.tld' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('必须重新填写密码');
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('覆盖端口或账号同样拒绝沿用已存密码', async () => {
    const byPort = await verifyEmailConnection({ port: 2525 });
    expect(byPort.ok).toBe(false);
    expect(byPort.error).toContain('必须重新填写密码');

    const byUser = await verifyEmailConnection({ user: 'someone-else@evil.tld' });
    expect(byUser.ok).toBe(false);
    expect(byUser.error).toContain('必须重新填写密码');

    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('发送测试邮件走同一道防线（不只是测试连接）', async () => {
    const result = await sendMailWithConfig(
      { host: 'mx.attacker.tld' },
      { to: 'a@b.com', subject: 's', html: 'h', text: 't' }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('必须重新填写密码');
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('改目的地时显式提供了新密码则放行，且用的是新密码', async () => {
    const result = await verifyEmailConnection({
      host: 'smtp.newhost.example.com',
      password: 'NEW-SECRET',
    });

    expect(result.ok).toBe(true);
    expect(lastTransportConfig()).toMatchObject({
      host: 'smtp.newhost.example.com',
      auth: { user: SAVED.smtp_user, pass: 'NEW-SECRET' },
    });
  });

  // 正常路径不能被误伤：不改目的地时「测试已保存的配置」必须照常可用。
  it('未改动目的地时正常沿用已保存密码', async () => {
    const result = await verifyEmailConnection({});

    expect(result.ok).toBe(true);
    expect(lastTransportConfig()).toMatchObject({
      host: SAVED.smtp_host,
      auth: { user: SAVED.smtp_user, pass: 'SAVED-SECRET' },
    });
  });

  it('只改发件人显示名/地址不算换目的地，仍可沿用已保存密码', async () => {
    const result = await verifyEmailConnection({
      fromName: '新站点名',
      fromEmail: 'hello@saved.example.com',
    });

    expect(result.ok).toBe(true);
    expect(lastTransportConfig()).toMatchObject({
      auth: { user: SAVED.smtp_user, pass: 'SAVED-SECRET' },
    });
  });

  it('传入与已存值相同的 host/port/user 不触发拦截', async () => {
    const result = await verifyEmailConnection({
      host: SAVED.smtp_host,
      port: SAVED.smtp_port,
      user: SAVED.smtp_user,
    });

    expect(result.ok).toBe(true);
    expect(lastTransportConfig()).toMatchObject({
      auth: { user: SAVED.smtp_user, pass: 'SAVED-SECRET' },
    });
  });

  it('尚未保存过密码时，换 host 不拦截（没有可外泄的凭据）', async () => {
    getSiteSettingsMock.mockResolvedValue({ ...SAVED, smtp_password: '' });

    const result = await verifyEmailConnection({ host: 'smtp.newhost.example.com' });

    expect(result.ok).toBe(true);
  });

  it.each([
    ['带协议头', 'smtp://evil.tld'],
    ['带空白', 'evil.tld evil2.tld'],
    ['带换行（头注入）', 'evil.tld\nX-Injected: 1'],
    ['带路径', 'evil.tld/path'],
    ['带 @（凭据混淆）', 'user@evil.tld'],
  ])('拒绝格式非法的主机名：%s', async (_label, host) => {
    const result = await verifyEmailConnection({ host });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('主机名格式不正确');
    expect(createTransportMock).not.toHaveBeenCalled();
  });
});
