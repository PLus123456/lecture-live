import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * scripts/ensure-database.mjs 的两处启动闸：
 *   ① AUTO_DB_PUSH 写在 env 文件里也必须生效（此前在载入 env 文件之前判定，.env.local
 *      里的 AUTO_DB_PUSH=false 永远被忽略）；
 *   ② 被信号杀掉的步骤必须中止编排（此前 status === null 被当成成功，后续步骤照跑）。
 * 全部在空临时目录里跑：绝不能读到开发机 .env.local 里的真实 DATABASE_URL。
 */

const ROOT = process.cwd();
const ENSURE_DATABASE = path.join(ROOT, 'scripts', 'ensure-database.mjs');
const tempDirs: string[] = [];

function makeProjectDir(files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lecturelive-ensure-db-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return dir;
}

function runEnsureDatabase(
  cwd: string,
  { args = [], env = {} }: { args?: string[]; env?: Record<string, string> } = {}
) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.AUTO_DB_PUSH;
  delete childEnv.NODE_OPTIONS;
  Object.assign(childEnv, { NODE_ENV: 'test' }, env);
  return spawnSync(process.execPath, [ENSURE_DATABASE, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ensure-database：AUTO_DB_PUSH 开关', () => {
  it('.env.local 里的 AUTO_DB_PUSH=false 生效（不再去找 Prisma CLI / 跑 db push）', () => {
    const dir = makeProjectDir({
      '.env.local': 'DATABASE_URL=mysql://u:p@127.0.0.1:1/db\nAUTO_DB_PUSH=false\n',
    });
    const result = runEnsureDatabase(dir);
    expect(result.stdout).toContain('AUTO_DB_PUSH disabled, skipping schema sync.');
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Prisma CLI not found');
  });

  it('DATABASE_URL 由环境注入时，env 文件里的 AUTO_DB_PUSH=off 同样生效', () => {
    const dir = makeProjectDir({ '.env': 'AUTO_DB_PUSH=off\n' });
    const result = runEnsureDatabase(dir, {
      env: { DATABASE_URL: 'mysql://u:p@127.0.0.1:1/db' },
    });
    expect(result.stdout).toContain('AUTO_DB_PUSH disabled, skipping schema sync.');
    expect(result.status).toBe(0);
  });

  it('--require-database 下 env 文件里关闭自动同步 → 非零退出（fail-closed 不变）', () => {
    const dir = makeProjectDir({
      '.env.local': 'DATABASE_URL=mysql://u:p@127.0.0.1:1/db\nAUTO_DB_PUSH=false\n',
    });
    const result = runEnsureDatabase(dir, { args: ['--require-database'] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AUTO_DB_PUSH cannot be disabled');
  });
});

describe('ensure-database：被信号终止的步骤', () => {
  it('第 ① 步被 SIGKILL 时立即中止，绝不继续跑 db push', () => {
    const marker = 'prisma-was-invoked';
    const dir = makeProjectDir({
      // 伪 prisma CLI：一旦被调用就留下标记（旧实现会在 ① 被杀后继续跑到 ②）
      'node_modules/.bin/prisma': `#!/bin/sh\ntouch "$(dirname "$0")/../../${marker}"\nexit 0\n`,
      // 预加载：只在 db-migrate-data.mjs 子进程里自杀，模拟 OOM killer
      'kill-migrate.cjs': [
        "const path = require('node:path');",
        "if (path.basename(process.argv[1] || '') === 'db-migrate-data.mjs') {",
        "  process.kill(process.pid, 'SIGKILL');",
        '}',
      ].join('\n'),
    });
    chmodSync(path.join(dir, 'node_modules/.bin/prisma'), 0o755);

    const result = runEnsureDatabase(dir, {
      env: {
        DATABASE_URL: 'mysql://u:p@127.0.0.1:1/db',
        NODE_OPTIONS: `--require ${path.join(dir, 'kill-migrate.cjs')}`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SIGKILL');
    expect(existsSync(path.join(dir, marker))).toBe(false);
    expect(result.stdout).not.toContain('Database schema is ready');
  });
});
