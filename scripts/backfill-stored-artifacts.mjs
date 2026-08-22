// Build the TypeScript backfill into an isolated temporary executable. This keeps
// the db-push path independent of a prebuilt Next bundle while still reusing the
// exact production Cloudreve validation/authentication implementation.

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadEnvFileIfNeeded } from './load-env.mjs';

const root = process.cwd();
loadEnvFileIfNeeded(root);

const esbuild = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
);
if (!existsSync(esbuild)) {
  console.error('[backfill-stored-artifacts] esbuild is required for the database backfill');
  process.exit(1);
}

const temp = mkdtempSync(path.join(tmpdir(), 'lecture-live-artifact-backfill-'));
const output = path.join(temp, 'backfill.mjs');
try {
  const build = spawnSync(
    esbuild,
    [
      path.join(root, 'scripts', 'backfill-stored-artifacts.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node24',
      `--outfile=${output}`,
      '--external:@prisma/client',
      `--alias:server-only=${path.join(root, 'deploy', 'shims', 'server-only.js')}`,
    ],
    { cwd: root, env: process.env, stdio: 'inherit' }
  );
  if (build.error || build.status !== 0) {
    console.error(
      '[backfill-stored-artifacts] build failed:',
      build.error?.message ?? `exit ${build.status}`
    );
    process.exit(build.status || 1);
  }

  const run = spawnSync(process.execPath, [output], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (run.error || run.status !== 0) {
    console.error(
      '[backfill-stored-artifacts] execution failed:',
      run.error?.message ?? `exit ${run.status}`
    );
    process.exit(run.status || 1);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
