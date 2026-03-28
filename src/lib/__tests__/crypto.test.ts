import { describe, expect, it } from 'vitest';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { decrypt, encrypt, isEncrypted } from '@/lib/crypto';

function createLegacyCiphertext(plaintext: string) {
  const key = createHash('sha256').update(process.env.JWT_SECRET as string).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `enc:${iv.toString('hex')}:${tag}:${encrypted}`;
}

describe('crypto helpers', () => {
  it('可以加密并解密明文', () => {
    const plaintext = 'super-secret-api-key';
    const encrypted = encrypt(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('不会重复加密已经加密过的值', () => {
    const encrypted = encrypt('hello');
    expect(encrypt(encrypted)).toBe(encrypted);
  });

  it('兼容旧版密文并升级为新格式', () => {
    const legacy = createLegacyCiphertext('legacy-secret');
    expect(isEncrypted(legacy)).toBe(true);
    expect(decrypt(legacy)).toBe('legacy-secret');

    const upgraded = encrypt(legacy);
    expect(upgraded.startsWith('enc:v2:')).toBe(true);
    expect(decrypt(upgraded)).toBe('legacy-secret');
  });

  it('非加密字符串会原样返回', () => {
    expect(encrypt('')).toBe('');
    expect(decrypt('')).toBe('');
    expect(decrypt('plain-text')).toBe('plain-text');
    expect(isEncrypted('plain-text')).toBe(false);
  });
});
