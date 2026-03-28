import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const LEGACY_PREFIX = 'enc:';
const CURRENT_PREFIX = 'enc:v2:';

function requireSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getCurrentEncryptionSecret() {
  return requireSecret('ENCRYPTION_KEY');
}

function getPreviousEncryptionSecret() {
  return process.env.ENCRYPTION_KEY_PREVIOUS?.trim() || null;
}

function getJwtSecret() {
  return requireSecret('JWT_SECRET');
}

function deriveLegacyKey(secret) {
  return createHash('sha256').update(secret).digest();
}

function deriveCurrentKey(secret) {
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

function parsePayload(ciphertext, prefix) {
  const parts = ciphertext.slice(prefix.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  return {
    iv: Buffer.from(parts[0], 'hex'),
    tag: Buffer.from(parts[1], 'hex'),
    data: parts[2],
  };
}

function decryptWithKey(payload, key) {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  let decrypted = decipher.update(payload.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function inspectStoredValue(value) {
  if (!value) {
    return { plaintext: value, needsUpdate: false };
  }

  if (value.startsWith(CURRENT_PREFIX)) {
    const payload = parsePayload(value, CURRENT_PREFIX);
    try {
      return {
        plaintext: decryptWithKey(payload, deriveCurrentKey(getCurrentEncryptionSecret())),
        needsUpdate: false,
      };
    } catch {
      const previousSecret = getPreviousEncryptionSecret();
      if (!previousSecret) {
        throw new Error(
          'Unable to decrypt current-format value. Set ENCRYPTION_KEY_PREVIOUS to rotate keys.'
        );
      }

      return {
        plaintext: decryptWithKey(payload, deriveCurrentKey(previousSecret)),
        needsUpdate: true,
      };
    }
  }

  if (value.startsWith(LEGACY_PREFIX)) {
    const payload = parsePayload(value, LEGACY_PREFIX);
    return {
      plaintext: decryptWithKey(payload, deriveLegacyKey(getJwtSecret())),
      needsUpdate: true,
    };
  }

  return {
    plaintext: value,
    needsUpdate: true,
  };
}

function encryptCurrent(plaintext) {
  if (!plaintext) {
    return plaintext;
  }

  const key = deriveCurrentKey(getCurrentEncryptionSecret());
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return `${CURRENT_PREFIX}${iv.toString('hex')}:${tag}:${encrypted}`;
}

async function main() {
  const providers = await prisma.llmProvider.findMany({
    select: {
      id: true,
      name: true,
      apiKey: true,
    },
    orderBy: { sortOrder: 'asc' },
  });

  let updatedCount = 0;

  for (const provider of providers) {
    const { plaintext, needsUpdate } = inspectStoredValue(provider.apiKey);
    if (!needsUpdate) {
      continue;
    }

    await prisma.llmProvider.update({
      where: { id: provider.id },
      data: { apiKey: encryptCurrent(plaintext) },
    });

    updatedCount += 1;
    console.log(`Re-encrypted API key for provider: ${provider.name}`);
  }

  console.log(`Finished. Updated ${updatedCount} provider(s).`);
}

main()
  .catch((error) => {
    console.error('Failed to re-encrypt provider API keys:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
