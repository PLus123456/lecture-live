import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  extractTokenFromCookieHeader,
  getJwtExpiryConfig,
  lookupRefreshGrace,
  peekTokenJti,
  recordRefreshGrace,
  signToken,
  validatePassword,
} from '@/lib/auth';

const JWT_SECRET = process.env.JWT_SECRET as string;

const SAMPLE_USER = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'PRO' as const,
  tokenVersion: 0,
};

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

describe('刷新幂等辅助 (v3-R7)', () => {
  beforeEach(() => {
    // 无 REDIS_URL → getRedisClient 返回 null → 走内存宽限存储；每例前清空。
    const g = globalThis as Record<string, unknown>;
    delete g.__lectureLiveTokenRefreshGraceStore;
  });

  it('peekTokenJti：合法签名返回 jti', () => {
    const token = signToken(SAMPLE_USER);
    const jti = peekTokenJti(token);
    const decoded = jwt.verify(token, JWT_SECRET) as { jti: string };
    expect(jti).toBe(decoded.jti);
  });

  it('peekTokenJti：错误密钥签名的伪造 token 返回 null', () => {
    const forged = jwt.sign(
      { ...SAMPLE_USER, sessionStartedAt: Date.now(), jti: 'x' },
      'totally-wrong-secret-totally-wrong',
      { expiresIn: '7d' }
    );
    expect(peekTokenJti(forged)).toBeNull();
  });

  it('peekTokenJti：超过 30 天绝对上限返回 null', () => {
    const stale = signToken(SAMPLE_USER, {
      sessionStartedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    expect(peekTokenJti(stale)).toBeNull();
  });

  it('recordRefreshGrace / lookupRefreshGrace：记入后可查回同一新 token', async () => {
    await recordRefreshGrace('old-jti', 'new-token-value');
    expect(await lookupRefreshGrace('old-jti')).toBe('new-token-value');
  });

  it('lookupRefreshGrace：未记录的 jti 返回 null', async () => {
    expect(await lookupRefreshGrace('never-recorded')).toBeNull();
  });
});
