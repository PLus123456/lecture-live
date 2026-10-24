import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Docker runner 镜像不带 src/ 与 tsconfig.json，ensure-database 第 ⑦ 步现编
 * scripts/backfill-stored-artifacts.ts 必挂（Could not resolve "../src/lib/prisma"），
 * entrypoint 的 `set -e` 随即在 Web/WS 启动前打死容器——每次启动都失败。
 * 修法：builder 阶段 `--build-only` 预编译，launcher 在没有源码时执行预编译产物。
 */

const ROOT = process.cwd();
const LAUNCHER = path.join(ROOT, 'scripts', 'backfill-stored-artifacts.mjs');
const tempDirs: string[] = [];

function makeTemp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 复刻 runner 镜像布局：scripts/ 在、src/ 与 node_modules/.bin/esbuild 都不在。 */
function makeRunnerLayout() {
  const dir = makeTemp('lecturelive-runner-');
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(LAUNCHER, path.join(dir, 'scripts', 'backfill-stored-artifacts.mjs'));
  copyFileSync(
    path.join(ROOT, 'scripts', 'load-env.mjs'),
    path.join(dir, 'scripts', 'load-env.mjs')
  );
  copyFileSync(
    path.join(ROOT, 'scripts', 'backfill-stored-artifacts.ts'),
    path.join(dir, 'scripts', 'backfill-stored-artifacts.ts')
  );
  return dir;
}

function runLauncher(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.DATABASE_URL;
  return spawnSync(process.execPath, [path.join(cwd, 'scripts', 'backfill-stored-artifacts.mjs'), ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('backfill-stored-artifacts launcher', () => {
  it('runner 布局（无 src/）下执行预编译产物，并透传退出码', () => {
    const dir = makeRunnerLayout();
    mkdirSync(path.join(dir, 'dist'));
    const marker = path.join(dir, 'ran.txt');
    writeFileSync(
      path.join(dir, 'dist', 'backfill-stored-artifacts.mjs'),
      [
        "import fs from 'node:fs';",
        'fs.writeFileSync(process.env.BACKFILL_MARKER, process.cwd());',
        'process.exitCode = Number(process.env.BACKFILL_EXIT_CODE || 0);',
      ].join('\n')
    );

    const ok = runLauncher(dir, [], { BACKFILL_MARKER: marker });
    expect(ok.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe(dir);

    const failing = runLauncher(dir, [], { BACKFILL_MARKER: marker, BACKFILL_EXIT_CODE: '3' });
    expect(failing.status).toBe(3);
    expect(failing.stderr).toContain('execution failed');
  });

  it('既无源码也无预编译产物时明确失败（不静默跳过）', () => {
    const dir = makeRunnerLayout();
    const result = runLauncher(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/backfill-stored-artifacts.mjs');
  });

  it('--build-only 产出的自包含 bundle 在 runner 布局里能完成模块解析', () => {
    const outDir = makeTemp('lecturelive-backfill-build-');
    const outfile = path.join(outDir, 'backfill-stored-artifacts.mjs');
    const build = spawnSync(process.execPath, [LAUNCHER, '--build-only', outfile], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(build.status).toBe(0);
    const bundle = readFileSync(outfile, 'utf8');
    // 源码已全部打进 bundle，只剩 @prisma/client 一个外部依赖
    expect(bundle).not.toMatch(/from ["']\.\.\/src\//);
    expect(bundle).toMatch(/from ["']@prisma\/client["']/);

    // 放进 runner 布局执行：没有数据库可连，必然非零退出，但绝不能是模块解析失败
    const dir = makeRunnerLayout();
    mkdirSync(path.join(dir, 'dist'));
    copyFileSync(outfile, path.join(dir, 'dist', 'backfill-stored-artifacts.mjs'));
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    expect(existsSync(path.join(dir, 'src'))).toBe(false);
    const run = runLauncher(dir, [], {
      DATABASE_URL: '',
      JWT_SECRET: 'x'.repeat(64),
      ENCRYPTION_KEY: 'y'.repeat(64),
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|Could not resolve/);
    expect(output).not.toContain('esbuild is required');
  });
});
