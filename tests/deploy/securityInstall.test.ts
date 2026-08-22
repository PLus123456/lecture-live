import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SECURITY_ENV_SCRIPT = path.join(ROOT, 'deploy/ensure-security-env.sh');
const tempDirs: string[] = [];

function makeEnv(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lecturelive-security-env-'));
  tempDirs.push(dir);
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, contents, { mode: 0o644 });
  chmodSync(envPath, 0o644);
  return envPath;
}

function parseEnv(file: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function runSecurityEnv(envPath: string) {
  return spawnSync('bash', [SECURITY_ENV_SCRIPT, envPath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function runRequiredDatabase(extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.DATABASE_URL;
  // Run from an EMPTY temp directory, not the repo root.
  //
  // ensure-database.mjs calls loadEnvFileIfNeeded(process.cwd()), so with cwd=ROOT it
  // re-read the developer's .env.local, recovered a real DATABASE_URL, sailed past the
  // gate this test is asserting, and went on to run `prisma db push` **against that
  // developer's actual database**. Only Prisma's data-loss guard stopped it — and the
  // test then failed on every machine that follows the repo's own .env.local convention,
  // which is why the suite is only green where no env file exists.
  //
  // The gate under test fires before any Prisma call, so an empty cwd is all it needs.
  const cwd = mkdtempSync(path.join(tmpdir(), 'lecturelive-db-gate-'));
  tempDirs.push(cwd);
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/ensure-database.mjs'), '--require-database'],
    { cwd, encoding: 'utf8', env }
  );
}

// LLM 出站白名单是必填项：为空时 parseLlmAllowedOrigins 抛异常，而它挂在每一次出站
// 调用上，聊天/摘要/关键词/报告/翻译会全部 500。升级闸在此拦下，不让它拖到运行时才炸。
const LLM_ORIGINS_LINE =
  'LLM_PROVIDER_ALLOWED_ORIGINS=https://api.vendor.example';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('deployment security environment initialization', () => {
  it('generates a non-logged bootstrap token, applies one-hop defaults and chmod 600 idempotently', () => {
    const envPath = makeEnv(
      'SETUP_BOOTSTRAP_TOKEN=\nTRUSTED_PROXY_HOPS=\nTRUSTED_PROXY_CIDRS=\n' +
        `${LLM_ORIGINS_LINE}\n`
    );

    const first = runSecurityEnv(envPath);
    expect(first.status, first.stderr).toBe(0);
    const firstValues = parseEnv(envPath);
    expect(firstValues.SETUP_BOOTSTRAP_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(firstValues.TRUSTED_PROXY_HOPS).toBe('1');
    expect(firstValues.TRUSTED_PROXY_CIDRS).toBe('127.0.0.1/32,::1/128');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(`${first.stdout}${first.stderr}`).not.toContain(
      firstValues.SETUP_BOOTSTRAP_TOKEN
    );

    const second = runSecurityEnv(envPath);
    expect(second.status, second.stderr).toBe(0);
    expect(parseEnv(envPath).SETUP_BOOTSTRAP_TOKEN).toBe(
      firstValues.SETUP_BOOTSTRAP_TOKEN
    );
  });

  it('fails closed instead of inventing a loopback-only CIDR for an undeclared multi-hop topology', () => {
    const envPath = makeEnv(
      [
        `SETUP_BOOTSTRAP_TOKEN=${'a'.repeat(64)}`,
        'TRUSTED_PROXY_HOPS=2',
        'TRUSTED_PROXY_CIDRS=',
        LLM_ORIGINS_LINE,
        '',
      ].join('\n')
    );

    const result = runSecurityEnv(envPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('TRUSTED_PROXY_CIDRS');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('refuses to upgrade with no LLM outbound allowlist instead of failing at runtime', () => {
    // 缺这一项不会让服务起不来，只会让每一次出站 LLM 调用 500：聊天、摘要、关键词、
    // 报告、embedding、翻译全灭，而且没有任何启动期提示。在升级闸拦下才有人看得见。
    const envPath = makeEnv(
      [
        `SETUP_BOOTSTRAP_TOKEN=${'a'.repeat(64)}`,
        'TRUSTED_PROXY_HOPS=1',
        'TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128',
        '',
      ].join('\n')
    );

    const result = runSecurityEnv(envPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('LLM_PROVIDER_ALLOWED_ORIGINS');
  });

  it('rejects the .env.example placeholder origin as if it were unset', () => {
    const envPath = makeEnv(
      [
        `SETUP_BOOTSTRAP_TOKEN=${'a'.repeat(64)}`,
        'TRUSTED_PROXY_HOPS=1',
        'TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128',
        'LLM_PROVIDER_ALLOWED_ORIGINS=https://replace-with-your-llm-provider.example',
        '',
      ].join('\n')
    );

    const result = runSecurityEnv(envPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('占位值');
  });
});

describe('all systemd deployment entrypoints share the security and DB gates', () => {
  it('formal install runs env initialization and database orchestration before service start', () => {
    const script = readFileSync(path.join(ROOT, 'deploy/install.sh'), 'utf8');
    const envGate = script.indexOf('bash "$SCRIPT_DIR/ensure-security-env.sh"');
    const databaseGate = script.indexOf(
      'node --env-file="$APP_DIR/.env" scripts/ensure-database.mjs --require-database'
    );
    const destructiveDeploy = script.indexOf('find "$APP_DIR"');
    const serviceStart = script.indexOf(
      'systemctl start lecturelive-web lecturelive-ws'
    );

    expect(envGate).toBeGreaterThan(0);
    expect(databaseGate).toBeGreaterThan(envGate);
    expect(destructiveDeploy).toBeGreaterThan(databaseGate);
    expect(serviceStart).toBeGreaterThan(databaseGate);
  });

  it('managed first install initializes and chmods the copied template before its early return', () => {
    const wholeScript = readFileSync(path.join(ROOT, 'deploy/lecture-live'), 'utf8');
    const install = wholeScript.slice(
      wholeScript.indexOf('cmd_install()'),
      wholeScript.indexOf('cmd_uninstall()')
    );
    const templateCopy = install.indexOf(
      'cp "$SRC_DIR/.env.example" "$APP_DIR/.env"'
    );
    const envGate = install.indexOf(
      'bash "$SRC_DIR/deploy/ensure-security-env.sh" "$APP_DIR/.env"'
    );
    const earlyReturn = install.indexOf('return', envGate);

    expect(templateCopy).toBeGreaterThan(0);
    expect(envGate).toBeGreaterThan(templateCopy);
    expect(earlyReturn).toBeGreaterThan(envGate);
  });

  it('upgrade reuses the same env gate and loads production env for DB orchestration', () => {
    const script = readFileSync(path.join(ROOT, 'deploy/upgrade.sh'), 'utf8');
    const envGate = script.indexOf('bash "$SCRIPT_DIR/ensure-security-env.sh"');
    const dependencyInstall = script.indexOf('\nnpm ci\n');
    const databaseGate = script.indexOf(
      'node --env-file="$APP_DIR/.env" scripts/ensure-database.mjs --require-database'
    );
    const serviceStart = script.indexOf(
      'systemctl start lecturelive-web lecturelive-ws'
    );

    expect(envGate).toBeGreaterThan(0);
    expect(dependencyInstall).toBeGreaterThan(envGate);
    expect(databaseGate).toBeGreaterThan(envGate);
    expect(serviceStart).toBeGreaterThan(databaseGate);
  });

  it('production DB gate rejects both a missing URL and AUTO_DB_PUSH=off', () => {
    const missingUrl = runRequiredDatabase();
    expect(missingUrl.status).not.toBe(0);
    expect(missingUrl.stderr).toContain('DATABASE_URL is required');
    // The gate must short-circuit before any schema work; reaching `db push` here would
    // mean the test is talking to a real database.
    expect(missingUrl.stdout).not.toContain('db push');

    const disabled = runRequiredDatabase({ AUTO_DB_PUSH: 'false' });
    expect(disabled.status).not.toBe(0);
    expect(disabled.stderr).toContain('AUTO_DB_PUSH cannot be disabled');
    expect(disabled.stdout).not.toContain('db push');
  });

  it('Docker uses the same required database gate before launching either server', () => {
    const script = readFileSync(path.join(ROOT, 'docker-entrypoint.sh'), 'utf8');
    const databaseGate = script.indexOf(
      'node scripts/ensure-database.mjs --require-database'
    );
    const wsStart = script.indexOf('node ws-server/websocket.js &');
    const webStart = script.indexOf('node server.js &');

    expect(databaseGate).toBeGreaterThan(0);
    expect(wsStart).toBeGreaterThan(databaseGate);
    expect(webStart).toBeGreaterThan(databaseGate);
  });
});
