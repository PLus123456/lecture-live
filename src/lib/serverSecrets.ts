import 'server-only';

const MIN_SECRET_LENGTH = 32;

const WEAK_SECRET_PATTERNS = [
  /change[-_ ]?me/i,
  /change[-_ ]?in[-_ ]?production/i,
  /lecture-live-dev-secret/i,
  /your[-_ ]?(jwt|encryption)?[-_ ]?secret/i,
  /placeholder/i,
];

function isWeakSecret(secret: string): boolean {
  const trimmed = secret.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) {
    return true;
  }

  return WEAK_SECRET_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function readRequiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || isWeakSecret(value)) {
    throw new Error(
      `FATAL: ${name} is missing or uses a weak/default value. Generate one with: openssl rand -hex 32`
    );
  }
  return value;
}

function readOptionalSecret(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }

  if (isWeakSecret(value)) {
    throw new Error(
      `FATAL: ${name} is set but weak/default. Generate one with: openssl rand -hex 32`
    );
  }

  return value;
}

export const JWT_SECRET = readRequiredSecret('JWT_SECRET');
export const ENCRYPTION_KEY = readRequiredSecret('ENCRYPTION_KEY');
export const ENCRYPTION_KEY_PREVIOUS = readOptionalSecret('ENCRYPTION_KEY_PREVIOUS');

if (JWT_SECRET === ENCRYPTION_KEY) {
  throw new Error(
    'FATAL: ENCRYPTION_KEY must be different from JWT_SECRET to avoid shared-key compromise.'
  );
}
