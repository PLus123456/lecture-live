import {
  createCipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertProductionStripeKey,
  checkProductionPaymentConfiguration,
} from '../../scripts/payment-production-preflight-core.mjs';

function encrypt(plaintext: string, secret: string, legacy = false): string {
  const prefix = legacy ? 'enc:' : 'enc:v2:';
  const key = legacy
    ? createHash('sha256').update(secret).digest()
    : Buffer.from(
        hkdfSync(
          'sha256',
          secret,
          'lecturelive-salt',
          'lecturelive-encryption',
          32
        )
      );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encryptedHex = cipher.update(plaintext, 'utf8', 'hex');
  encryptedHex += cipher.final('hex');
  return `${prefix}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encryptedHex}`;
}

describe('SEC-024 production Stripe startup preflight', () => {
  it.each(['sk_live_secret', 'rk_live_restricted'])(
    'allows production live key %s',
    (key) => {
      expect(assertProductionStripeKey(key)).toEqual({ status: 'live' });
    }
  );

  it.each(['sk_test_secret', 'rk_test_restricted'])(
    'blocks stored test key %s with an explicit diagnostic',
    (key) => {
      expect(() => assertProductionStripeKey(key)).toThrow(/test-mode API key/);
    }
  );

  it('allows an unconfigured Stripe channel but blocks unknown key modes', () => {
    expect(assertProductionStripeKey('')).toEqual({ status: 'unconfigured' });
    expect(() => assertProductionStripeKey('proxy_secret')).toThrow(/unrecognized/);
  });

  it('decrypts current v2 data and blocks a historical encrypted test key', () => {
    const env = { ENCRYPTION_KEY: 'current-encryption-secret' };
    const stored = encrypt('sk_test_historical', env.ENCRYPTION_KEY);
    expect(() => assertProductionStripeKey(stored, env)).toThrow(/test-mode API key/);
  });

  it('accepts encrypted live keys using current, previous, and legacy key derivations', () => {
    const current = 'current-encryption-secret';
    const previous = 'previous-encryption-secret';
    const jwt = 'legacy-jwt-secret';
    expect(
      assertProductionStripeKey(encrypt('rk_live_current', current), {
        ENCRYPTION_KEY: current,
      })
    ).toEqual({ status: 'live' });
    expect(
      assertProductionStripeKey(encrypt('sk_live_previous', previous), {
        ENCRYPTION_KEY: current,
        ENCRYPTION_KEY_PREVIOUS: previous,
      })
    ).toEqual({ status: 'live' });
    expect(
      assertProductionStripeKey(encrypt('sk_live_legacy', jwt, true), {
        JWT_SECRET: jwt,
      })
    ).toEqual({ status: 'live' });
  });

  it('reads the production database value and never logs the secret', async () => {
    const prisma = {
      siteSetting: {
        findUnique: vi.fn().mockImplementation(({ where }: { where: { key: string } }) =>
          Promise.resolve(
            where.key === 'recharge_stripe_secret_key'
              ? { value: 'rk_live_database' }
              : null
          )
        ),
        upsert: vi.fn().mockResolvedValue({}),
      },
      $queryRawUnsafe: vi.fn().mockResolvedValue([{
        orderCount: 0, earliest: null, foreignAccountCount: 0,
        nonLiveCount: 0, unknownModeCount: 0,
      }]),
    };
    const logger = { log: vi.fn() };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'acct_database' }),
    });

    await expect(
      checkProductionPaymentConfiguration(prisma, logger, {}, { fetchImpl })
    ).resolves.toEqual({ status: 'live' });
    expect(prisma.siteSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'recharge_stripe_secret_key' } })
    );
    expect(prisma.siteSetting.upsert).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/account',
      expect.objectContaining({ headers: { Authorization: 'Bearer rk_live_database' } })
    );
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('rk_live_database');
  });

  it('blocks an existing Stripe account until a same-account complete history marker exists', async () => {
    const prisma = {
      siteSetting: {
        findUnique: vi.fn().mockImplementation(({ where }: { where: { key: string } }) =>
          Promise.resolve(
            where.key === 'recharge_stripe_secret_key'
              ? { value: 'sk_live_a' }
              : null
          )
        ),
      },
      $queryRawUnsafe: vi.fn().mockResolvedValue([{
        orderCount: 1, earliest: new Date('2025-01-01T00:00:00Z'),
        foreignAccountCount: 0, nonLiveCount: 0, unknownModeCount: 1,
      }]),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'acct_a' }),
    });
    await expect(
      checkProductionPaymentConfiguration(prisma, console, {}, { fetchImpl })
    ).rejects.toThrow(/namespace quarantine|historical Stripe refund\/dispute reconciliation/);
  });

  it('permits a pending same-account marker only through the explicit maintenance preflight', async () => {
    const marker = JSON.stringify({
      version: 1,
      status: 'scan_complete_pending_review',
      mode: 'live',
      providerAccount: 'default',
      stripeAccountId: 'acct_a',
      since: '2024-12-31T00:00:00.000Z',
      through: '2025-01-02T00:00:00.000Z',
      scanStartedAt: '2025-01-02T00:00:01.000Z',
    });
    const prisma = {
      siteSetting: {
        findUnique: vi.fn().mockImplementation(({ where }: { where: { key: string } }) =>
          Promise.resolve(
            where.key === 'recharge_stripe_secret_key'
              ? { value: 'sk_live_a' }
              : { value: marker }
          )
        ),
      },
      $queryRawUnsafe: vi.fn().mockResolvedValue([{
        orderCount: 1, earliest: new Date('2025-01-01T00:00:00Z'),
        foreignAccountCount: 0, nonLiveCount: 0, unknownModeCount: 1,
      }]),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'acct_a' }),
    });
    await expect(
      checkProductionPaymentConfiguration(
        prisma,
        { log: vi.fn() },
        { PAYMENT_RECONCILIATION_MAINTENANCE: '1' },
        { fetchImpl, allowReconciliationMaintenance: true }
      )
    ).resolves.toEqual({ status: 'live' });
    await expect(
      checkProductionPaymentConfiguration(prisma, { log: vi.fn() }, {}, { fetchImpl })
    ).rejects.toThrow(/pending|namespace quarantine/);
  });

  it('is wired only into runtime database orchestration, never build/dev scripts', () => {
    const root = process.cwd();
    const ensure = readFileSync(path.join(root, 'scripts/ensure-database.mjs'), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    expect(ensure).toContain("path.join(SCRIPT_DIR, 'check-production-payment-config.mjs')");
    expect(ensure.indexOf('check-production-payment-config.mjs')).toBeGreaterThan(
      ensure.indexOf("'db',\n  'push'")
    );
    expect(packageJson.scripts.dev).not.toContain('payment');
    expect(packageJson.scripts.prebuild).not.toContain('payment');
    expect(packageJson.scripts.build).not.toContain('payment');
  });

  it('runs fail-closed before every systemd start and ships the preflight scripts', () => {
    const root = process.cwd();
    const webUnit = readFileSync(
      path.join(root, 'deploy/lecturelive-web.service'),
      'utf8'
    );
    const wsUnit = readFileSync(
      path.join(root, 'deploy/lecturelive-ws.service'),
      'utf8'
    );
    const install = readFileSync(path.join(root, 'deploy/install.sh'), 'utf8');
    const upgrade = readFileSync(path.join(root, 'deploy/upgrade.sh'), 'utf8');
    const rollback = readFileSync(path.join(root, 'deploy/rollback.sh'), 'utf8');
    const managementCli = readFileSync(path.join(root, 'deploy/lecture-live'), 'utf8');
    const preflight =
      'ExecStartPre=/usr/bin/node --env-file=/opt/lecturelive/.env /opt/lecturelive/scripts/check-production-payment-config.mjs';

    expect(webUnit).toContain(preflight);
    expect(wsUnit).toContain(preflight);
    for (const script of [install, upgrade]) {
      expect(script).toContain(
        'install -m 0644 "$SRC_DIR/scripts/check-production-payment-config.mjs"'
      );
      expect(script).toContain(
        'install -m 0644 "$SRC_DIR/scripts/payment-production-preflight-core.mjs"'
      );
      expect(script).toContain('stripe-history-reconciliation-core.mjs');
      expect(script).toContain('reconcile-stripe-history.mjs');
      expect(script).toContain(
        'install -m 0644 "$SRC_DIR/scripts/stripe-key-mode.mjs"'
      );
    }

    expect(install).toContain('systemctl is-active --quiet lecturelive-web');
    expect(install).toContain('systemctl is-active --quiet lecturelive-ws');
    expect(
      install.indexOf(
        'install -m 0644 "$SCRIPT_DIR/lecturelive-web.service" /etc/systemd/system/'
      )
    ).toBeLessThan(
      install.indexOf('scripts/ensure-database.mjs --require-database')
    );

    // Once an operator starts an upgrade, an invalid stored payment key must leave
    // the old vulnerable service stopped rather than failing before isolation.
    expect(upgrade.indexOf('systemctl stop lecturelive-web')).toBeLessThan(
      upgrade.indexOf('\nnpm ci\n')
    );
    expect(
      upgrade.indexOf(
        'install -m 0644 "$SCRIPT_DIR/lecturelive-web.service" /etc/systemd/system/'
      )
    ).toBeLessThan(upgrade.indexOf('scripts/ensure-database.mjs --require-database'));
    expect(
      upgrade.indexOf(
        '"$SRC_DIR/scripts/check-production-payment-config.mjs" "$APP_DIR/scripts/"'
      )
    ).toBeLessThan(upgrade.indexOf('scripts/ensure-database.mjs --require-database'));
    expect(upgrade).toContain('systemctl is-active --quiet lecturelive-web');
    expect(upgrade).toContain('systemctl is-active --quiet lecturelive-ws');
    expect(rollback).toMatch(/! -name "scripts"/);
    expect(rollback).toContain('systemctl is-active --quiet lecturelive-web');
    expect(rollback).toContain('systemctl is-active --quiet lecturelive-ws');
    expect(rollback).toContain('runuser -u "$APP_USER" -- /usr/bin/node');
    expect(managementCli).toMatch(/! -name scripts/);
    expect(managementCli).toContain('assert_payment_startup_preflight');
    expect(managementCli).toContain(
      'runuser -u lecturelive -- /usr/bin/node --env-file=$APP_DIR/.env'
    );
    expect(managementCli).toContain(
      'if systemctl is-active --quiet $WEB_SERVICE || systemctl is-active --quiet $WS_SERVICE'
    );
  });
});
