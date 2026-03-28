import 'server-only';

// src/lib/crypto.ts
// AES-256-GCM 加密/解密工具 — 用于安全存储 API Key 到数据库
// v2 使用独立 ENCRYPTION_KEY + HKDF，并兼容旧版 JWT_SECRET 派生密钥

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'crypto';
import {
  ENCRYPTION_KEY,
  ENCRYPTION_KEY_PREVIOUS,
  JWT_SECRET,
} from '@/lib/serverSecrets';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 12 字节 IV
const LEGACY_ENCRYPTED_PREFIX = 'enc:';
const CURRENT_ENCRYPTED_PREFIX = 'enc:v2:';

function deriveLegacyKey(): Buffer {
  return createHash('sha256').update(JWT_SECRET).digest();
}

function deriveCurrentKey(secret = ENCRYPTION_KEY): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      'lecturelive-salt',
      'lecturelive-encryption',
      32
    )
  );
}

function parseCiphertext(
  ciphertext: string,
  prefix: string
): { iv: Buffer; tag: Buffer; encryptedHex: string } {
  const parts = ciphertext.slice(prefix.length).split(':');
  if (parts.length !== 3) {
    throw new Error('无效的加密数据格式');
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  return {
    iv: Buffer.from(ivHex, 'hex'),
    tag: Buffer.from(tagHex, 'hex'),
    encryptedHex,
  };
}

function encryptWithKey(plaintext: string, key: Buffer, prefix: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return `${prefix}${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptWithKey(
  ciphertext: string,
  prefix: string,
  key: Buffer
): string {
  const { iv, tag, encryptedHex } = parseCiphertext(ciphertext, prefix);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function isCurrentEncrypted(value: string): boolean {
  return value.startsWith(CURRENT_ENCRYPTED_PREFIX);
}

function isLegacyEncrypted(value: string): boolean {
  return value.startsWith(LEGACY_ENCRYPTED_PREFIX) && !isCurrentEncrypted(value);
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isCurrentEncrypted(plaintext)) return plaintext;
  if (isLegacyEncrypted(plaintext)) return encrypt(decrypt(plaintext));

  return encryptWithKey(
    plaintext,
    deriveCurrentKey(),
    CURRENT_ENCRYPTED_PREFIX
  );
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext;
  if (!isEncrypted(ciphertext)) return ciphertext;

  if (isCurrentEncrypted(ciphertext)) {
    try {
      return decryptWithKey(
        ciphertext,
        CURRENT_ENCRYPTED_PREFIX,
        deriveCurrentKey()
      );
    } catch (error) {
      if (!ENCRYPTION_KEY_PREVIOUS) {
        throw error;
      }

      return decryptWithKey(
        ciphertext,
        CURRENT_ENCRYPTED_PREFIX,
        deriveCurrentKey(ENCRYPTION_KEY_PREVIOUS)
      );
    }
  }

  return decryptWithKey(
    ciphertext,
    LEGACY_ENCRYPTED_PREFIX,
    deriveLegacyKey()
  );
}

export function isEncrypted(value: string): boolean {
  return isCurrentEncrypted(value) || isLegacyEncrypted(value);
}
