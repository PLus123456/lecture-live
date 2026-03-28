import { existsSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function isAutoDbPushDisabled() {
  const value = process.env.AUTO_DB_PUSH?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

function resolvePrismaBin() {
  const binName = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  return path.join(process.cwd(), 'node_modules', '.bin', binName);
}

if (isAutoDbPushDisabled()) {
  console.log('[db:init] AUTO_DB_PUSH disabled, skipping schema sync.');
  process.exit(0);
}

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());
const hasEnvFile =
  existsSync(path.join(process.cwd(), '.env')) ||
  existsSync(path.join(process.cwd(), '.env.local'));

if (!hasDatabaseUrl && !hasEnvFile) {
  console.log('[db:init] No DATABASE_URL or env file found, skipping schema sync.');
  process.exit(0);
}

const prismaBin = resolvePrismaBin();
if (!existsSync(prismaBin)) {
  console.error('[db:init] Prisma CLI not found. Run npm ci before starting the app.');
  process.exit(1);
}

console.log('[db:init] Syncing Prisma schema to the configured database...');

const result = spawnSync(prismaBin, ['db', 'push', '--skip-generate'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error('[db:init] Failed to run Prisma:', result.error.message);
  process.exit(1);
}

if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status);
}

console.log('[db:init] Database schema is ready.');
