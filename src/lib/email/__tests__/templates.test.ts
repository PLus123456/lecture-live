import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  verificationEmail,
  passwordResetEmail,
  securityAlertEmail,
  subscriptionSuccessEmail,
} from '@/lib/email/templates';

const ctx = { siteName: 'LectureLive', siteUrl: 'https://app.example.com' };

describe('escapeHtml', () => {
  it('转义 HTML 特殊字符', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('模板 XSS 防护', () => {
  it('displayName 中的脚本被转义，不会原样进入 HTML', () => {
    const mail = verificationEmail(ctx, {
      displayName: '<img src=x onerror=alert(1)>',
      verifyUrl: 'https://app.example.com/verify-email?token=abc',
    });
    expect(mail.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('验证邮件含验证链接与主题', () => {
    const mail = verificationEmail(ctx, { displayName: 'Alice', verifyUrl: 'https://app.example.com/verify-email?token=xyz' });
    expect(mail.subject).toContain('LectureLive');
    expect(mail.html).toContain('https://app.example.com/verify-email?token=xyz');
    expect(mail.text).toContain('https://app.example.com/verify-email?token=xyz');
  });
});

describe('重置密码模板', () => {
  it('含重置链接与单次/时效说明', () => {
    const mail = passwordResetEmail(ctx, { displayName: 'Bob', resetUrl: 'https://app.example.com/reset-password?token=r1' });
    expect(mail.html).toContain('https://app.example.com/reset-password?token=r1');
    expect(mail.html).toContain('1 小时');
  });
});

describe('安全告警模板', () => {
  it('新设备登录含 IP/时间且转义 UA', () => {
    const mail = securityAlertEmail(ctx, {
      displayName: 'Carol',
      kind: 'new_device_login',
      ip: '1.2.3.4',
      when: '2026-07-18 10:00:00',
      userAgent: '<b>UA</b>',
    });
    expect(mail.html).toContain('1.2.3.4');
    expect(mail.html).toContain('&lt;b&gt;UA&lt;/b&gt;');
  });
});

describe('订阅成功模板（通知类，带退订）', () => {
  it('渲染退订链接', () => {
    const mail = subscriptionSuccessEmail(ctx, {
      displayName: 'Dan',
      planName: 'PRO',
      amountLabel: '¥39.00',
      expiresLabel: '2026-08-18',
      unsubscribeUrl: 'https://app.example.com/api/auth/unsubscribe?token=t&category=subscription',
    });
    expect(mail.html).toContain('退订');
    expect(mail.html).toContain('unsubscribe?token=t');
    expect(mail.html).toContain('¥39.00');
  });
});
