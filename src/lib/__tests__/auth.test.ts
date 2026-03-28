import { describe, expect, it } from 'vitest';
import {
  extractTokenFromCookieHeader,
  getJwtExpiryConfig,
  validatePassword,
} from '@/lib/auth';

describe('auth helpers', () => {
  it('接受包含字母和数字的强密码', () => {
    expect(validatePassword('Abcd1234')).toBeNull();
  });

  it('拒绝过短或缺少数字的密码', () => {
    expect(validatePassword('Abc123')).toContain('至少');
    expect(validatePassword('OnlyLetters')).toContain('数字');
  });

  it('从 Cookie header 中提取认证 token', () => {
    expect(
      extractTokenFromCookieHeader(
        'foo=bar; lecture-live-token=test-token; theme=dark'
      )
    ).toBe('test-token');
  });

  it('返回正确的 JWT 过期配置', () => {
    expect(getJwtExpiryConfig(14)).toEqual({
      expiresInDays: 14,
      cookieMaxAge: 14 * 24 * 60 * 60,
    });
  });
});
