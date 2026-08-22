import {
  createDecipheriv,
  createHash,
  hkdfSync,
} from 'crypto';
import { detectStripeKeyMode } from './stripe-key-mode.mjs';
import { STRIPE_HISTORY_RECONCILIATION_MARKER } from './stripe-history-reconciliation-core.mjs';

const ALGORITHM = 'aes-256-gcm';
const LEGACY_PREFIX = 'enc:';
const CURRENT_PREFIX = 'enc:v2:';

function requireSecret(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing required ${name}`);
  return value;
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

function parseCiphertext(ciphertext, prefix) {
  const [ivHex, tagHex, encryptedHex, ...rest] = ciphertext
    .slice(prefix.length)
    .split(':');
  if (!ivHex || !tagHex || encryptedHex === undefined || rest.length > 0) {
    throw new Error('invalid encrypted setting format');
  }
  return {
    iv: Buffer.from(ivHex, 'hex'),
    tag: Buffer.from(tagHex, 'hex'),
    encryptedHex,
  };
}

function decryptWithKey(ciphertext, prefix, key) {
  const { iv, tag, encryptedHex } = parseCiphertext(ciphertext, prefix);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let plaintext = decipher.update(encryptedHex, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

/**
 * Mirrors src/lib/crypto.ts for deployment-time reads of an encrypted setting.
 * @param {string} value
 * @param {Record<string, string | undefined>} env
 */
export function decryptStoredSetting(value, env = process.env) {
  if (!value) return value;
  if (value.startsWith(CURRENT_PREFIX)) {
    const current = requireSecret(env, 'ENCRYPTION_KEY');
    try {
      return decryptWithKey(value, CURRENT_PREFIX, deriveCurrentKey(current));
    } catch (error) {
      const previous = env.ENCRYPTION_KEY_PREVIOUS?.trim();
      if (!previous) throw error;
      return decryptWithKey(value, CURRENT_PREFIX, deriveCurrentKey(previous));
    }
  }
  if (value.startsWith(LEGACY_PREFIX)) {
    const legacyKey = createHash('sha256')
      .update(requireSecret(env, 'JWT_SECRET'))
      .digest();
    return decryptWithKey(value, LEGACY_PREFIX, legacyKey);
  }
  return value;
}

/**
 * SEC-024 startup invariant: an unconfigured Stripe channel is fine, but any
 * stored production API key must be an explicitly recognizable live sk/rk key.
 * @param {string} storedValue
 * @param {Record<string, string | undefined>} env
 */
export function assertProductionStripeKey(storedValue, env = process.env) {
  if (!storedValue) return { status: 'unconfigured' };

  let secretKey;
  try {
    secretKey = decryptStoredSetting(storedValue, env);
  } catch {
    throw new Error(
      'SEC-024 production startup blocked: Stripe secret key cannot be decrypted'
    );
  }

  const mode = detectStripeKeyMode(secretKey);
  if (mode === 'test') {
    throw new Error(
      'SEC-024 production startup blocked: Stripe test-mode API key is configured; replace it with sk_live_/rk_live_ or remove it'
    );
  }
  if (mode !== 'live') {
    throw new Error(
      'SEC-024 production startup blocked: Stripe API key mode is unrecognized; production requires sk_live_ or rk_live_'
    );
  }
  return { status: 'live' };
}

/**
 * @param {any} prisma
 * @param {{ log: (...args: any[]) => void }} logger
 * @param {Record<string, string | undefined>} env
 */
export async function checkProductionPaymentConfiguration(
  prisma,
  logger = console,
  env = process.env,
  options = {}
) {
  const [row, historyRow] = await Promise.all([
    prisma.siteSetting.findUnique({
      where: { key: 'recharge_stripe_secret_key' },
      select: { value: true },
    }),
    prisma.siteSetting.findUnique({
      where: { key: STRIPE_HISTORY_RECONCILIATION_MARKER },
      select: { value: true },
    }),
  ]);
  const result = assertProductionStripeKey(row?.value ?? '', env);
  const secretKey = row?.value ? decryptStoredSetting(row.value, env) : '';
  let currentStripeAccountId = '';
  if (secretKey) {
    const response = await (options.fetchImpl ?? fetch)(
      'https://api.stripe.com/v1/account',
      {
        headers: { Authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!response.ok) {
      throw new Error(
        `SEC-024 production startup blocked: Stripe account identity lookup returned HTTP ${response.status}`
      );
    }
    const account = await response.json();
    currentStripeAccountId =
      typeof account?.id === 'string' ? account.id.trim().slice(0, 191) : '';
    if (!currentStripeAccountId.startsWith('acct_')) {
      throw new Error(
        'SEC-024 production startup blocked: Stripe live key account identity is invalid'
      );
    }
  }
  const orderRows = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS orderCount, MIN(createdAt) AS earliest,
           SUM(CASE WHEN NOT (status = 'refunded' AND fulfillmentStatus = 'reversed')
                     AND providerAccount <> 'default' THEN 1 ELSE 0 END) AS foreignAccountCount,
           SUM(CASE WHEN NOT (status = 'refunded' AND fulfillmentStatus = 'reversed')
                     AND providerMode IN ('test', 'sandbox') THEN 1 ELSE 0 END) AS nonLiveCount,
           SUM(CASE WHEN NOT (status = 'refunded' AND fulfillmentStatus = 'reversed')
                     AND providerMode = 'unknown' THEN 1 ELSE 0 END) AS unknownModeCount
    FROM PaymentOrder
    WHERE provider = 'stripe' AND status IN ('paid', 'late_paid', 'refunded')
  `);
  const history = orderRows[0] ?? {};
  const orderCount = Number(history.orderCount ?? 0);
  const foreignAccountCount = Number(history.foreignAccountCount ?? 0);
  const nonLiveCount = Number(history.nonLiveCount ?? 0);
  const unknownModeCount = Number(history.unknownModeCount ?? 0);
  let marker = null;
  try {
    marker = historyRow?.value ? JSON.parse(historyRow.value) : null;
  } catch {
    marker = null;
  }
  if (orderCount === 0) {
    if (marker?.status !== 'not_required' && marker?.status !== 'complete') {
      const cutover = {
        version: 1,
        status: 'not_required',
        cutoverAt: new Date().toISOString(),
        stripeAccountId: currentStripeAccountId || null,
        reason: 'no_existing_rights_bearing_stripe_orders',
      };
      await prisma.siteSetting.upsert({
        where: { key: STRIPE_HISTORY_RECONCILIATION_MARKER },
        create: {
          key: STRIPE_HISTORY_RECONCILIATION_MARKER,
          value: JSON.stringify(cutover),
        },
        update: { value: JSON.stringify(cutover) },
      });
      marker = cutover;
    }
  } else if (marker?.status === 'not_required') {
    const cutoverAt = new Date(marker.cutoverAt).getTime();
    const earliest = history.earliest ? new Date(history.earliest).getTime() : NaN;
    if (
      !Number.isFinite(cutoverAt) ||
      !Number.isFinite(earliest) ||
      earliest < cutoverAt ||
      unknownModeCount > 0 ||
      !currentStripeAccountId ||
      marker.stripeAccountId !== currentStripeAccountId
    ) {
      throw new Error(
        'SEC-025 production startup blocked: Stripe orders predate the clean cutover marker or retain unknown mode; run the historical reconciliation workflow'
      );
    }
  } else {
    const since = new Date(marker?.since).getTime();
    const through = new Date(marker?.through).getTime();
    const scanStartedAt = new Date(marker?.scanStartedAt).getTime();
    const durableCutoverAt = new Date(marker?.durableCutoverAt).getTime();
    const earliest = history.earliest ? new Date(history.earliest).getTime() : NaN;
    const commonMarkerValid =
      marker?.version !== 1 ||
      marker?.mode !== 'live' ||
      marker?.providerAccount !== 'default' ||
      typeof marker?.stripeAccountId !== 'string' ||
      !marker.stripeAccountId.startsWith('acct_') ||
      marker.stripeAccountId !== currentStripeAccountId ||
      !Number.isFinite(since) ||
      !Number.isFinite(through) ||
      !Number.isFinite(scanStartedAt) ||
      !Number.isFinite(earliest) ||
      since > earliest ||
      through > scanStartedAt;
    const maintenanceAllowed =
      options.allowReconciliationMaintenance === true &&
      env.PAYMENT_RECONCILIATION_MAINTENANCE?.trim() === '1' &&
      marker?.status === 'scan_complete_pending_review';
    if (
      (foreignAccountCount > 0 || nonLiveCount > 0 || unknownModeCount > 0) &&
      !maintenanceAllowed
    ) {
      throw new Error(
        `SEC-025 production startup blocked: Stripe namespace quarantine remains (foreign=${foreignAccountCount}, nonLive=${nonLiveCount}, unknown=${unknownModeCount}); only the isolated ADMIN maintenance path may run`
      );
    }
    if (commonMarkerValid || (marker?.status !== 'complete' && !maintenanceAllowed)) {
      throw new Error(
        'SEC-025 production startup blocked: historical Stripe refund/dispute reconciliation is missing, pending, incomplete, or belongs to another live account/key. Run dry-run, --apply, resolve every review/hold, then --finalize.'
      );
    }
    if (
      marker?.status === 'complete' &&
      (!Number.isFinite(durableCutoverAt) ||
        durableCutoverAt < through ||
        durableCutoverAt - through > 5 * 60_000)
    ) {
      throw new Error(
        'SEC-025 production startup blocked: Stripe history marker has no fresh durable cutover proof'
      );
    }
    if (maintenanceAllowed) {
      logger.log(
        '[payment:preflight] MAINTENANCE: only the payment review API may run; normal user/payment APIs must remain blocked'
      );
    }
  }
  logger.log(
    result.status === 'live'
      ? '[payment:preflight] SEC-024 Stripe live-mode configuration verified'
      : '[payment:preflight] SEC-024 Stripe is not configured; nothing to verify'
  );
  logger.log(
    `[payment:preflight] SEC-025 Stripe history gate verified (${marker?.status ?? 'missing'})`
  );
  return result;
}
