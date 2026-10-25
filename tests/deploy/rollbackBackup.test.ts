import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 回滚/备份对托管安装布局（$APP_DIR/src 是源码 git 检出）的处理：
 *   ① 回滚不得删除 $APP_DIR/src，也不得让旧备份里的 ./src 覆盖保留下来的检出；
 *   ② 备份排除项锚定到顶层：不再误丢 node_modules/*\/data 之类的运行产物，也不再把
 *      数 GB 的 src 打进每一份备份。
 * 直接从脚本里抠出真实命令在临时目录执行，而不是复刻一份逻辑。
 */

const ROOT = process.cwd();
const tempDirs: string[] = [];
// 部署目标是 Linux，脚本刻意依赖 GNU tar 的 --anchored；macOS 自带的 bsdtar 不认这个选项，
// 在那上面跑测的是另一个 tar。CI（ubuntu）照常执行这些用例。
const GNU_TAR =
  spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar') ?? false;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTemp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lecturelive-rollback-'));
  tempDirs.push(dir);
  return dir;
}

/** 抠出以 prefix 开头、以反斜杠续行的完整 shell 命令。 */
function extractCommand(script: string, prefix: string): string {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(prefix));
  if (start === -1) throw new Error(`command not found: ${prefix}`);
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    out.push(lines[i]);
    if (!lines[i].trimEnd().endsWith('\\')) break;
  }
  return out.join('\n');
}

/** 抠出 `name() {` 到其后第一行顶格 `}` 的完整 shell 函数。 */
function extractFunction(script: string, name: string): string {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  if (start === -1) throw new Error(`function not found: ${name}`);
  const end = lines.indexOf('}', start);
  if (end === -1) throw new Error(`function not terminated: ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

function write(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function bash(command: string, env: Record<string, string>) {
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result;
}

function listArchive(file: string): string[] {
  const result = spawnSync('tar', ['tzf', file], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout.split('\n').filter(Boolean);
}

describe('deploy/upgrade.sh 备份', () => {
  it.skipIf(!GNU_TAR)('只排除顶层 data/backups/.env/src，嵌套的同名目录照常备份', () => {
    const upgrade = readFileSync(path.join(ROOT, 'deploy/upgrade.sh'), 'utf8');
    const command = extractCommand(upgrade, 'tar czf "$BACKUP_DIR/app-');

    const appDir = path.join(makeTemp(), 'app');
    const backupDir = path.join(path.dirname(appDir), 'backups-out');
    mkdirSync(backupDir);
    write(path.join(appDir, 'server.js'), 'srv');
    write(path.join(appDir, 'node_modules/pkg/data/table.json'), '{}');
    write(path.join(appDir, 'data/transcripts/t.json'), '{}');
    write(path.join(appDir, 'backups/app-old.tar.gz'), 'x');
    write(path.join(appDir, '.env'), 'SECRET=1');
    write(path.join(appDir, 'src/.git/HEAD'), 'ref');
    write(path.join(appDir, 'src/node_modules/huge/index.js'), 'x');
    mkdirSync(path.join(appDir, 'ws-server'));
    symlinkSync(path.join(appDir, 'data'), path.join(appDir, 'ws-server/data'));

    bash(command, { APP_DIR: appDir, BACKUP_DIR: backupDir, TIMESTAMP: 'test' });
    const members = listArchive(path.join(backupDir, 'app-test.tar.gz'));

    expect(members).toContain('./server.js');
    // 旧写法 --exclude=data 会把它一起丢掉
    expect(members).toContain('./node_modules/pkg/data/table.json');
    expect(members).toContain('./ws-server/data');
    for (const excluded of ['./data/', './backups/', './.env', './src/']) {
      expect(members.some((member) => member.startsWith(excluded))).toBe(false);
    }
  });
});

describe('回滚保留源码检出', () => {
  function legacyBackupWithSrc(workDir: string) {
    // 旧版 upgrade.sh 产出的备份：./src 也在里面
    const staging = path.join(workDir, 'staging');
    write(path.join(staging, 'server.js'), 'old-server');
    write(path.join(staging, 'src/a.ts'), 'old-source');
    write(path.join(staging, 'src/.git/HEAD'), 'old-ref');
    const backup = path.join(workDir, 'app-legacy.tar.gz');
    const tar = spawnSync('tar', ['czf', backup, '-C', staging, '.'], { encoding: 'utf8' });
    expect(tar.status).toBe(0);
    return backup;
  }

  function liveAppDir(workDir: string) {
    const appDir = path.join(workDir, 'app');
    write(path.join(appDir, 'server.js'), 'new-server');
    write(path.join(appDir, 'src/a.ts'), 'current-source');
    write(path.join(appDir, 'src/.git/HEAD'), 'current-ref');
    write(path.join(appDir, 'src/local-only.txt'), 'untracked');
    write(path.join(appDir, 'data/keep.json'), '{}');
    write(path.join(appDir, 'scripts/check-production-payment-config.mjs'), '');
    write(path.join(appDir, 'stale-artifact.js'), 'stale');
    return appDir;
  }

  function assertSourcePreserved(appDir: string) {
    expect(readFileSync(path.join(appDir, 'server.js'), 'utf8')).toBe('old-server');
    expect(existsSync(path.join(appDir, 'stale-artifact.js'))).toBe(false);
    expect(readFileSync(path.join(appDir, 'src/a.ts'), 'utf8')).toBe('current-source');
    expect(readFileSync(path.join(appDir, 'src/.git/HEAD'), 'utf8')).toBe('current-ref');
    expect(readFileSync(path.join(appDir, 'src/local-only.txt'), 'utf8')).toBe('untracked');
    expect(existsSync(path.join(appDir, 'data/keep.json'))).toBe(true);
  }

  it.skipIf(!GNU_TAR)('deploy/rollback.sh：清理与解包都不碰 $APP_DIR/src', () => {
    const rollback = readFileSync(path.join(ROOT, 'deploy/rollback.sh'), 'utf8');
    const workDir = makeTemp();
    const backup = legacyBackupWithSrc(workDir);
    const appDir = liveAppDir(workDir);

    const commands = [
      extractCommand(rollback, 'find "$APP_DIR" -mindepth 1 -maxdepth 1'),
      extractCommand(rollback, 'tar xzf "$BACKUP_FILE"'),
    ].join('\n');
    bash(commands, { APP_DIR: appDir, BACKUP_FILE: backup });
    assertSourcePreserved(appDir);
  });

});

/**
 * `lecture-live rollback` 只负责选备份，真正的回滚交给 deploy/rollback.sh。旧实现调用一个
 * 从未存在过的 rollback-wrapper.sh，于是每次都落到一段内联脚本：它一律拒绝早于
 * health-ready-v1 的备份、也不成对退回 systemd unit，和 rollback.sh 早已分叉。
 * 这里把 CLI 里的真实函数抠出来，在临时目录里跑：root 检查换成空操作，备份目录与源码
 * 检出指向临时目录，rollback.sh 换成只记录参数的桩。
 */
describe('deploy/lecture-live rollback 委托 deploy/rollback.sh', () => {
  const cli = readFileSync(path.join(ROOT, 'deploy/lecture-live'), 'utf8');
  const cmdRollback = extractFunction(cli, 'cmd_rollback');
  const findRollbackScript = extractFunction(cli, 'find_rollback_script');

  function layout() {
    const dir = makeTemp();
    const backups = path.join(dir, 'backups');
    // ls -t 按 mtime 排序：较新的排第 1 项
    const newer = path.join(backups, 'app-20261020_100000.tar.gz');
    const older = path.join(backups, 'app-20261001_100000.tar.gz');
    write(newer, 'new');
    write(older, 'old');
    utimesSync(older, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));
    utimesSync(newer, new Date('2026-10-20T10:00:00Z'), new Date('2026-10-20T10:00:00Z'));
    // 已安装的 CLI 在 bin 目录里，旁边放一个无关的 rollback.sh：绝不能被当成回滚脚本
    const installedCli = path.join(dir, 'usr/local/bin/lecture-live');
    write(installedCli, '#!/usr/bin/env bash\n');
    const record = path.join(dir, 'called.txt');
    write(
      path.join(dir, 'usr/local/bin/rollback.sh'),
      `printf 'stray:%s\\n' "$1" >> '${record}'\n`
    );
    return { dir, backups, installedCli, record, older, newer };
  }

  function addRollbackScript(srcDir: string, record: string) {
    write(
      path.join(srcDir, 'deploy/rollback.sh'),
      `printf '%s|%s\\n' "$(basename "$(dirname "$(dirname "$0")")")" "$1" >> '${record}'\n`
    );
  }

  /** 以 argv0 = 已安装的 CLI 路径执行 cmd_rollback；/root 候选换成临时目录里不存在的位置。 */
  function runCmdRollback(
    env: { dir: string; backups: string; installedCli: string; srcDir: string },
    stdin: string
  ) {
    const rootCheckout = '/root/lecture-live;';
    expect(findRollbackScript).toContain(rootCheckout);
    const finder = findRollbackScript.replace(rootCheckout, `'${env.dir}/root-checkout';`);
    const script = [
      'RED= GREEN= YELLOW= BLUE= CYAN= BOLD= DIM= NC=',
      'error() { echo "$*" >&2; }',
      'fatal() { error "$*"; exit 1; }',
      'need_root() { :; }',
      'divider() { :; }',
      `BACKUP_DIR='${env.backups}'`,
      `SRC_DIR='${env.srcDir}'`,
      finder,
      cmdRollback,
      'cmd_rollback',
    ].join('\n');
    return spawnSync('bash', ['-euo', 'pipefail', '-c', script, env.installedCli], {
      input: stdin,
      encoding: 'utf8',
    });
  }

  it('CLI 里不再有内联回滚，也不再引用不存在的 wrapper', () => {
    // 只看命令行：注释里会提到旧写法
    const commands = cli
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(commands).not.toContain('rollback-wrapper.sh');
    expect(existsSync(path.join(ROOT, 'deploy/rollback-wrapper.sh'))).toBe(false);
    for (const inline of ['bash -c', 'tar xzf', 'systemctl', 'check-readiness']) {
      expect(cmdRollback).not.toContain(inline);
    }
    expect(cmdRollback).toContain('bash "$rollback_script" "$(basename "$selected")"');
  });

  it('不去 /home/* 里找回滚脚本：那里任何本地用户都能放文件，而找到的脚本以 root 执行', () => {
    const candidates = findRollbackScript
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(candidates).not.toContain('/home/');
  });

  it('把所选备份的文件名交给托管检出 $SRC_DIR 里的 rollback.sh', () => {
    const env = layout();
    const srcDir = path.join(env.dir, 'opt/lecturelive/src');
    addRollbackScript(srcDir, env.record);

    const result = runCmdRollback({ ...env, srcDir }, '2\n');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // 第 2 项是较旧的备份；rollback.sh 只收 $BACKUP_DIR 下的文件名
    expect(readFileSync(env.record, 'utf8')).toBe(`src|${path.basename(env.older)}\n`);
  }, 30_000);

  it('直接回车默认回滚到最新备份', () => {
    const env = layout();
    const srcDir = path.join(env.dir, 'opt/lecturelive/src');
    addRollbackScript(srcDir, env.record);

    const result = runCmdRollback({ ...env, srcDir }, '\n');
    expect(result.status).toBe(0);
    expect(readFileSync(env.record, 'utf8')).toBe(`src|${path.basename(env.newer)}\n`);
  }, 30_000);

  it('找不到 rollback.sh 时在列出备份、读取选择之前就失败，也不会误用 bin 目录里的同名脚本', () => {
    const env = layout();
    const result = runCmdRollback({ ...env, srcDir: path.join(env.dir, 'missing') }, '1\n');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('未找到 deploy/rollback.sh');
    expect(result.stdout).not.toContain('可用备份');
    expect(existsSync(env.record)).toBe(false);
  }, 30_000);

  it('从源码检出直接运行时优先用该检出自己的 rollback.sh', () => {
    const env = layout();
    const checkout = path.join(env.dir, 'home/ops/lecture-live');
    const ownCli = path.join(checkout, 'deploy/lecture-live');
    write(ownCli, '#!/usr/bin/env bash\n');
    addRollbackScript(checkout, env.record);
    const srcDir = path.join(env.dir, 'opt/lecturelive/src');
    addRollbackScript(srcDir, env.record);

    const result = runCmdRollback({ ...env, installedCli: ownCli, srcDir }, '1\n');
    expect(result.status).toBe(0);
    expect(readFileSync(env.record, 'utf8')).toBe(
      `lecture-live|${path.basename(env.newer)}\n`
    );
  }, 30_000);
});
