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

describe('getJwtExpiryConfig 钳到剩余绝对寿命 (U51 / P6-5)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;

  it('不传 sessionStartedAt 时只钳 30 天绝对上限（老口径不变）', () => {
    expect(getJwtExpiryConfig(90)).toEqual({
      expiresInDays: 30,
      cookieMaxAge: 30 * 24 * 60 * 60,
    });
  });

  it('会话已用 10 天时，jwt_expiry=90 只签剩下的 20 天', () => {
    const config = getJwtExpiryConfig(90, {
      sessionStartedAt: NOW - 10 * DAY,
      now: NOW,
    });
    expect(config.expiresInDays).toBeCloseTo(20, 6);
    expect(config.cookieMaxAge).toBe(20 * 24 * 60 * 60);
  });

  it('默认 7 天且会话已用 25 天时，只签剩下的 5 天', () => {
    const config = getJwtExpiryConfig(undefined, {
      sessionStartedAt: NOW - 25 * DAY,
      now: NOW,
    });
    expect(config.expiresInDays).toBeCloseTo(5, 6);
    expect(config.cookieMaxAge).toBe(5 * 24 * 60 * 60);
  });

  it('剩余寿命大于配置值时不放大（仍取较小者）', () => {
    const config = getJwtExpiryConfig(7, {
      sessionStartedAt: NOW - 1 * DAY,
      now: NOW,
    });
    expect(config.expiresInDays).toBe(7);
  });

  it('会话已超绝对上限时钳到 0，不发未来时刻的 cookie', () => {
    const config = getJwtExpiryConfig(30, {
      sessionStartedAt: NOW - 31 * DAY,
      now: NOW,
    });
    expect(config.expiresInDays).toBe(0);
    expect(config.cookieMaxAge).toBe(0);
  });

  it('signToken 按（可能为小数的）天数签出对应的 exp', () => {
    const halfDay = 0.5;
    const before = Math.floor(Date.now() / 1000);
    const token = signToken(SAMPLE_USER, { expiresInDays: halfDay });
    const decoded = jwt.verify(token, JWT_SECRET) as { exp: number };
    expect(decoded.exp).toBeGreaterThanOrEqual(before + 12 * 60 * 60 - 2);
    expect(decoded.exp).toBeLessThanOrEqual(before + 12 * 60 * 60 + 2);
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
