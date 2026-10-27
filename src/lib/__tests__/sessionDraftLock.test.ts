import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let directory: string;
let script: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-draft-lock-'));
  script = path.join(directory, 'worker.mjs');
  await build({
    stdin: {
      contents: `
        import fs from 'node:fs/promises';
        import { withSessionDraftLock } from ${JSON.stringify(path.resolve('src/lib/sessionDraftLock.ts'))};
        await withSessionDraftLock('shared-session', async () => {
          process.send?.('locked');
          if (process.argv[2] === 'hold') await new Promise(() => {});
          await fs.appendFile('events.txt', 'start:' + process.pid + '\\n');
          await withSessionDraftLock('shared-session', async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
          });
          await fs.appendFile('events.txt', 'end:' + process.pid + '\\n');
        });
      `,
      resolveDir: process.cwd(),
    },
    bundle: true, platform: 'node', format: 'esm', outfile: script,
  });
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function launch(mode = 'write') {
  const child = spawn(process.execPath, [script, mode], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (data) => { stderr += data; });
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGKILL') resolve();
      else reject(new Error(stderr || `worker exited ${code}`));
    });
  });
  return { child, finished };
}

describe('跨进程草稿锁', () => {
  it('多个真实进程的写入临界区互不交错，并允许同一调用链重入', async () => {
    await Promise.all(Array.from({ length: 4 }, () => launch().finished));
    const events = (await fs.readFile(path.join(directory, 'events.txt'), 'utf8')).trim().split('\n');
    expect(events).toHaveLength(8);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i + 1]).toBe(events[i].replace('start:', 'end:'));
    }
  }, 30_000);

  it.each([false, true])('持锁进程及回收者崩溃后可恢复（遗留回收锁：%s）', async (reaperCrashed) => {
    const holder = launch('hold');
    try {
      await new Promise<void>((resolve, reject) => {
        holder.child.once('message', () => resolve());
        holder.child.once('exit', () => reject(new Error('holder exited before lock')));
      });
      holder.child.kill('SIGKILL');
      await holder.finished;
      if (reaperCrashed) {
        const root = path.join(directory, 'data', 'draft-locks');
        const name = (await fs.readdir(root)).find((file) => /^[a-f0-9]{64}$/.test(file))!;
        await fs.copyFile(path.join(root, name), path.join(root, `${name}.reap`));
      }
      await launch().finished;
      expect(await fs.readFile(path.join(directory, 'events.txt'), 'utf8')).toContain('end:');
    } finally {
      holder.child.kill('SIGKILL');
    }
  }, 30_000);
});
