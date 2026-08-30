import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const PAYMENT_RUNTIME_SCRIPTS = [
  'check-production-payment-config.mjs',
  'payment-production-preflight-core.mjs',
  'reconcile-stripe-history.mjs',
  'stripe-history-reconciliation-core.mjs',
  'stripe-key-mode.mjs',
] as const;

describe('payment reconciliation maintenance runtime', () => {
  it('stages and resolves the self-contained CLI before the first production DB gate', () => {
    for (const relative of ['deploy/install.sh', 'deploy/upgrade.sh']) {
      const script = readFileSync(path.join(ROOT, relative), 'utf8');
      for (const filename of PAYMENT_RUNTIME_SCRIPTS) {
        expect(script).toContain(
          `"$SRC_DIR/scripts/${filename}" "$MAINTENANCE_DIR/scripts/"`,
        );
      }

      const runtimeCopy = script.indexOf(
        '"$SRC_DIR/scripts/reconcile-stripe-history.mjs" "$MAINTENANCE_DIR/scripts/"',
      );
      const moduleResolutionCheck = script.indexOf(
        '"$MAINTENANCE_DIR/scripts/reconcile-stripe-history.mjs" --help',
      );
      const databaseGate = script.indexOf(
        'scripts/ensure-database.mjs --require-database',
      );
      expect(runtimeCopy).toBeGreaterThan(-1);
      expect(moduleResolutionCheck).toBeGreaterThan(runtimeCopy);
      expect(databaseGate).toBeGreaterThan(moduleResolutionCheck);
    }
  });

  it('resolves @prisma/client when the CLI has dependencies only in its maintenance root', () => {
    const sandbox = mkdtempSync(
      path.join(tmpdir(), 'lecturelive-payment-runtime-'),
    );
    const runtime = path.join(sandbox, 'lecturelive-maintenance');
    const scripts = path.join(runtime, 'scripts');
    try {
      mkdirSync(scripts, { recursive: true });
      for (const filename of PAYMENT_RUNTIME_SCRIPTS) {
        copyFileSync(
          path.join(ROOT, 'scripts', filename),
          path.join(scripts, filename),
        );
      }
      symlinkSync(path.join(ROOT, 'node_modules'), path.join(runtime, 'node_modules'), 'dir');

      const output = execFileSync(
        process.execPath,
        [path.join(scripts, 'reconcile-stripe-history.mjs'), '--help'],
        { encoding: 'utf8' },
      );
      expect(output).toContain('Usage:');
      expect(output).toContain('reconcile-stripe-history.mjs');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('uses one runtime-backed helper for dry-run, apply, finalize, and review service', () => {
    const helper = readFileSync(
      path.join(ROOT, 'deploy/payment-reconciliation-maintenance.sh'),
      'utf8',
    );
    const docs = readFileSync(path.join(ROOT, 'deploy/INSTALL.md'), 'utf8');

    expect(helper).toContain('$RUNTIME_DIR/scripts/reconcile-stripe-history.mjs');
    expect(helper).toContain('$RUNTIME_DIR/scripts/check-production-payment-config.mjs');
    expect(helper).not.toContain('$APP_DIR/scripts/reconcile-stripe-history.mjs');
    expect(helper).not.toContain('$APP_DIR/scripts/check-production-payment-config.mjs');
    expect(docs.match(/lecturelive-payment-maintenance reconcile/g)).toHaveLength(3);
    expect(docs).not.toContain(
      'sudo -u lecturelive node --env-file=.env scripts/reconcile-stripe-history.mjs',
    );
  });

  it('keeps Docker publishing loopback-only while binding the container runtime interfaces', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const entrypoint = readFileSync(path.join(ROOT, 'docker-entrypoint.sh'), 'utf8');

    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).toContain('HOSTNAME: "0.0.0.0"');
    expect(compose).toContain('WS_HOST: "0.0.0.0"');
    expect(entrypoint).toContain('HOSTNAME=0.0.0.0 PORT=3000 node server.js');
  });
});
