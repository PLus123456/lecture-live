import { describe, it, expect } from 'vitest';
import { generateRawToken, hashToken, EMAIL_TOKEN_TTL_MS } from '@/lib/email/tokens';

describe('generateRawToken', () => {
  it('生成足够长的 base64url token 且每次不同', () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).not.toBe(b);
    // 32 字节 base64url ≈ 43 字符，且只含 base64url 字符集
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });
});

describe('hashToken', () => {
  it('确定性 sha256 十六进制（64 hex）', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
  it('raw token 不等于其哈希（哈希不可逆存储）', () => {
    const raw = generateRawToken();
    expect(hashToken(raw)).not.toBe(raw);
  });
});

describe('TTL 常量', () => {
  it('验证 24h、重置 1h', () => {
    expect(EMAIL_TOKEN_TTL_MS.VERIFY_EMAIL).toBe(24 * 60 * 60 * 1000);
    expect(EMAIL_TOKEN_TTL_MS.RESET_PASSWORD).toBe(60 * 60 * 1000);
  });
});
