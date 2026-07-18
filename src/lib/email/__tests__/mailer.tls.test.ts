import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #18：requireTLS 原来是 `!secure && port !== 25`，端口 25 无条件豁免 STARTTLS。
 * 配了 user/password 时，中间人只要剥掉 STARTTLS 通告，我们就会明文发出 AUTH LOGIN
 * （base64 不是加密），SMTP 凭据当场泄露。豁免必须收窄到「匿名投递」。
 */

const { createTransportMock, verifyMock, sendMailMock, getSiteSettingsMock } = vi.hoisted(
  () => ({
    createTransportMock: vi.fn(),
    verifyMock: vi.fn(),
    sendMailMock: vi.fn(),
    getSiteSettingsMock: vi.fn(),
  })
);

vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));

import { verifyEmailConnection, invalidateMailer } from '@/lib/email/mailer';

const BASE = {
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: 'noreply@example.com',
  smtp_password: 'SECRET',
  sender_email: 'noreply@example.com',
  sender_name: 'LectureLive',
  site_name: 'LectureLive',
};

const lastTransportConfig = () =>
  createTransportMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

/** 用给定站点配置建一次连接，返回 nodemailer 收到的 transport 配置。 */
async function transportFor(settings: Partial<typeof BASE>) {
  getSiteSettingsMock.mockResolvedValue({ ...BASE, ...settings });
  invalidateMailer(); // 否则会命中签名缓存，拿到上一轮的 transporter
  await verifyEmailConnection();
  return lastTransportConfig();
}

describe('buildTransporter —— STARTTLS 强制口径（#18）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyMock.mockResolvedValue(true);
    sendMailMock.mockResolvedValue({ messageId: 'mid-1' });
    createTransportMock.mockReturnValue({
      verify: verifyMock,
      sendMail: sendMailMock,
      close: vi.fn(),
    });
  });

  // 本 bug 的核心：25 端口 + 有凭据，此前不要求 STARTTLS。
  it('端口 25 且配了凭据 → 仍然强制 STARTTLS', async () => {
    const cfg = await transportFor({ smtp_port: 25, smtp_user: 'me@example.com' });
    expect(cfg?.requireTLS).toBe(true);
  });

  // 保留原豁免的正当场景：老式内网中继匿名投递，确实可能不支持 STARTTLS。
  it('端口 25 且无凭据（匿名中继）→ 维持豁免', async () => {
    const cfg = await transportFor({ smtp_port: 25, smtp_user: '', smtp_password: '' });
    expect(cfg?.requireTLS).toBe(false);
  });

  it('常规提交端口 587 → 强制 STARTTLS', async () => {
    const cfg = await transportFor({ smtp_port: 587 });
    expect(cfg?.requireTLS).toBe(true);
  });

  it('无凭据但非 25 端口 → 依旧强制（豁免只针对 25）', async () => {
    const cfg = await transportFor({ smtp_port: 2525, smtp_user: '', smtp_password: '' });
    expect(cfg?.requireTLS).toBe(true);
  });

  it('隐式 TLS（465/secure）→ 不需要 STARTTLS 升级', async () => {
    const cfg = await transportFor({ smtp_port: 465, smtp_secure: true });
    expect(cfg?.secure).toBe(true);
    expect(cfg?.requireTLS).toBe(false);
  });

  it('有凭据时才带 auth，匿名投递不带', async () => {
    const withAuth = await transportFor({ smtp_user: 'me@example.com' });
    expect(withAuth?.auth).toMatchObject({ user: 'me@example.com' });

    const anon = await transportFor({ smtp_port: 25, smtp_user: '', smtp_password: '' });
    expect(anon?.auth).toBeUndefined();
  });
});
