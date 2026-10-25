import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 托管安装（deploy/lecture-live）的源码检出在 /opt/lecturelive/src，里面没有 .env.local；
 * 部署配置只在 /opt/lecturelive/.env。裸跑 `npm run build` 时 serverSecrets.ts 在收集页面数据
 * 阶段 import 即 FATAL（JWT_SECRET 缺失），即便侥幸过了，NEXT_PUBLIC_WS_URL 也会兜底成观众
 * 自己的 localhost:3001。所以部署入口必须用与运行时同一份 env、同一个解析器（node --env-file）
 * 跑 next build。这里抠出脚本里真实的构建命令，在临时目录里用假 next / 假 prisma 包装器 /
 * 假 npm 记录它们实际拿到的环境。
 */

const ROOT = process.cwd();
const BUILD_LINE =
  'NODE_ENV=production node --env-file="$APP_DIR/.env" node_modules/.bin/next build';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read(relative: string) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function write(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** 去掉注释行：注释里提到 npm run build 不算调用。 */
function commandsOnly(script: string) {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * 记录自身收到的参数与关键环境变量（以 node 直接执行，无需可执行位）。
 * getBuiltinModule 在 CJS（假 next）与 ESM（假 run-prisma.mjs）里都能用。
 */
function recorder(out: string) {
  return [
    "process.getBuiltinModule('node:fs').appendFileSync(",
    `  ${JSON.stringify(out)},`,
    '  JSON.stringify({',
    '    argv: process.argv.slice(2),',
    '    NODE_ENV: process.env.NODE_ENV,',
    '    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,',
    '    JWT_SECRET: process.env.JWT_SECRET,',
    '    DATABASE_URL: process.env.DATABASE_URL,',
    '    QUOTED: process.env.QUOTED,',
    "  }) + '\\n'",
    ');',
    '',
  ].join('\n');
}

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lecturelive-build-env-'));
  tempDirs.push(dir);
  const appDir = path.join(dir, 'opt/lecturelive');
  const srcDir = path.join(appDir, 'src');
  const out = path.join(dir, 'calls.jsonl');
  // 与 .env.example 一样写着 development；值带引号、带 # 与 $，验证解析器与运行时一致
  write(
    path.join(appDir, '.env'),
    [
      'NODE_ENV=development',
      'NEXT_PUBLIC_WS_URL="https://live.example.test"',
      `JWT_SECRET=${'j'.repeat(64)}`,
      'DATABASE_URL="mysql://u:p%40ss@127.0.0.1:3306/lecturelive"',
      'QUOTED="a $b # c"',
      '',
    ].join('\n')
  );
  write(path.join(srcDir, 'node_modules/.bin/next'), recorder(out));
  write(path.join(srcDir, 'scripts/run-prisma.mjs'), recorder(out));
  // 假 npm：只记录参数，证明 build:ws 仍走 npm 脚本
  const binDir = path.join(dir, 'bin');
  write(path.join(binDir, 'npm'), `#!/usr/bin/env bash\nprintf '%s\\n' "{\\"npm\\":\\"$*\\"}" >> '${out}'\n`);
  chmodSync(path.join(binDir, 'npm'), 0o755);
  return { appDir, srcDir, out, binDir };
}

/**
 * 最小环境执行（与 sudo 下的部署脚本一致）：vitest.setup 塞进 process.env 的密钥与
 * NODE_ENV 不能漏进来。Next 的类型把 NODE_ENV 声明成必填，这里刻意不给，只能双重断言。
 * --norc：没有 SHLVL、stdin 又是 socketpair（Linux 上 Node 的管道）时，bash 会当成被 rshd
 * 拉起，去 source /etc/bash.bashrc，在 -u 下报 PS1 未定义（CI 上实际出现过）。
 */
function run(command: string, env: Record<string, string>, cwd: string) {
  const result = spawnSync('bash', ['--norc', '-euo', 'pipefail', '-c', command], {
    cwd,
    env: {
      PATH: `${env.PATH_PREFIX}:${process.env.PATH}`,
      HOME: process.env.HOME ?? '',
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

function calls(out: string) {
  return readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const EXPECTED_BUILD_ENV = {
  argv: ['build'],
  NODE_ENV: 'production',
  NEXT_PUBLIC_WS_URL: 'https://live.example.test',
  JWT_SECRET: 'j'.repeat(64),
  DATABASE_URL: 'mysql://u:p%40ss@127.0.0.1:3306/lecturelive',
  QUOTED: 'a $b # c',
};

describe('deploy builds run next build against the deployment env', () => {
  it('upgrade.sh：next build 读 $APP_DIR/.env，NODE_ENV 钉成 production', () => {
    const upgrade = read('deploy/upgrade.sh');
    expect(upgrade).toContain(`\n${BUILD_LINE}\n`);
    // 不能再有不带 env 的 npm run build（build:ws 不内联任何 env，照旧）
    expect(commandsOnly(upgrade)).not.toMatch(/npm run build(?!:ws)/);

    const generate = upgrade.indexOf(
      'node --env-file="$APP_DIR/.env" scripts/run-prisma.mjs generate'
    );
    const build = upgrade.indexOf(BUILD_LINE);
    const standaloneCheck = upgrade.indexOf('[[ -d "$SRC_DIR/.next/standalone" ]]');
    expect(generate).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(generate);
    expect(standaloneCheck).toBeGreaterThan(build);

    const { appDir, srcDir, out, binDir } = sandbox();
    run(BUILD_LINE, { APP_DIR: appDir, PATH_PREFIX: binDir }, srcDir);
    expect(calls(out)).toEqual([EXPECTED_BUILD_ENV]);
  }, 30_000);

  it('托管 CLI 的 install：同一套构建命令，build:ws 照旧走 npm', () => {
    const cli = read('deploy/lecture-live');
    const install = cli.slice(cli.indexOf('cmd_install() {'), cli.indexOf('cmd_uninstall() {'));
    expect(commandsOnly(install)).not.toMatch(/npm run build(?!:ws)/);

    const lines = install.split('\n');
    const start = lines.findIndex((line) => line.trim() === '(cd "$SRC_DIR" \\');
    const end = lines.findIndex((line) => line.trim() === '&& npm run build:ws)');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const recipe = lines.slice(start, end + 1).join('\n');
    expect(recipe).toContain(BUILD_LINE);

    const { appDir, srcDir, out, binDir } = sandbox();
    run(recipe, { APP_DIR: appDir, SRC_DIR: srcDir, PATH_PREFIX: binDir }, appDir);
    const [generate, build, buildWs] = calls(out);
    // prisma generate 先带着部署 env 跑（原先靠 prebuild、且不带 env）
    expect(generate).toMatchObject({ argv: ['generate'], DATABASE_URL: EXPECTED_BUILD_ENV.DATABASE_URL });
    expect(build).toEqual(EXPECTED_BUILD_ENV);
    expect(buildWs).toEqual({ npm: 'run build:ws' });
  }, 30_000);

  it('package.json 的 build 就是 next build：部署脚本绕过 npm 直接调 next，不能漏掉任何步骤', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('next build');
    // prebuild 只做 prisma generate，部署脚本在 next build 之前已带 env 显式执行
    expect(pkg.scripts.prebuild).toBe('node scripts/run-prisma.mjs generate');
    expect(pkg.scripts.postbuild).toBeUndefined();
  });
});

/**
 * upgrade.sh 之外没有任何步骤会更新 /usr/local/bin/lecture-live，CLI 的修复（比如回滚入口）
 * 就到不了存量安装。upgrade.sh 只在已装过 CLI 时刷新它，并且必须换新 inode：
 * `lecture-live update` 正在执行旧文件，原地改写会让 bash 读到错位的内容。
 */
describe('upgrade.sh refreshes an installed management CLI', () => {
  const upgrade = read('deploy/upgrade.sh');

  function refreshBlock(binDir: string) {
    const lines = upgrade.split('\n');
    const start = lines.findIndex((line) => line === 'if [[ -f /usr/local/bin/lecture-live ]]; then');
    expect(start).toBeGreaterThan(0);
    const end = lines.indexOf('fi', start);
    return lines
      .slice(start, end + 1)
      .join('\n')
      .replaceAll('/usr/local/bin', binDir);
  }

  it('在任何可能失败的构建/迁移步骤之前刷新', () => {
    const refresh = upgrade.indexOf('if [[ -f /usr/local/bin/lecture-live ]]; then');
    expect(refresh).toBeGreaterThan(upgrade.indexOf('systemctl stop lecturelive-web'));
    expect(refresh).toBeLessThan(upgrade.indexOf('\nnpm ci\n'));
    expect(refresh).toBeLessThan(upgrade.indexOf('scripts/ensure-database.mjs --require-database'));
  });

  it('已安装时换成源码里的版本（新 inode，正在执行的旧文件内容不变）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lecturelive-cli-refresh-'));
    tempDirs.push(dir);
    const installed = path.join(dir, 'lecture-live');
    write(installed, 'old-cli\n');
    const before = statSync(installed).ino;
    // 模拟正在执行它的 bash：持有旧文件的打开句柄
    const running = openSync(installed, 'r');

    try {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', refreshBlock(dir)], {
        env: { ...process.env, SCRIPT_DIR: path.join(ROOT, 'deploy') },
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(readFileSync(installed, 'utf8')).toBe(read('deploy/lecture-live'));
      expect(statSync(installed).ino).not.toBe(before);
      expect(statSync(installed).mode & 0o777).toBe(0o755);
      expect(readFileSync(running, 'utf8')).toBe('old-cli\n');
    } finally {
      closeSync(running);
    }
  }, 30_000);

  it('没装过 CLI 的手工部署不会被装上', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lecturelive-cli-refresh-'));
    tempDirs.push(dir);
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', refreshBlock(dir)], {
      env: { ...process.env, SCRIPT_DIR: path.join(ROOT, 'deploy') },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);
});
