import { spawnSync } from 'node:child_process';
import {
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
 * 回滚/备份对托管安装布局（$APP_DIR/src 是源码 git 检出）的处理：
 *   ① 回滚不得删除 $APP_DIR/src，也不得让旧备份里的 ./src 覆盖保留下来的检出；
 *   ② 备份排除项锚定到顶层：不再误丢 node_modules/*\/data 之类的运行产物，也不再把
 *      数 GB 的 src 打进每一份备份。
 * 直接从脚本里抠出真实命令在临时目录执行，而不是复刻一份逻辑。
 */

const ROOT = process.cwd();
const tempDirs: string[] = [];

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
  it('只排除顶层 data/backups/.env/src，嵌套的同名目录照常备份', () => {
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

  it('deploy/rollback.sh：清理与解包都不碰 $APP_DIR/src', () => {
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

  it('deploy/lecture-live 的内联回滚兜底与 rollback.sh 同口径', () => {
    const cli = readFileSync(path.join(ROOT, 'deploy/lecture-live'), 'utf8');
    const workDir = makeTemp();
    const backup = legacyBackupWithSrc(workDir);
    const appDir = liveAppDir(workDir);

    // 兜底脚本在 bash -c "…" 里，$APP_DIR / $selected 由外层展开；这里用同名变量还原
    const commands = [
      extractCommand(cli, 'find $APP_DIR -mindepth 1 -maxdepth 1'),
      extractCommand(cli, "tar xzf '$selected'").replace("'$selected'", '"$selected"'),
    ].join('\n');
    bash(commands, { APP_DIR: appDir, selected: backup });
    assertSourcePreserved(appDir);
  });
});
