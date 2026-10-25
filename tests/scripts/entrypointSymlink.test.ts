import { spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveReadinessToken } from '../../scripts/check-readiness.mjs';

/**
 * 入口判断 `import.meta.url === pathToFileURL(process.argv[1]).href` 经软链路径启动时恒为 false：
 * Node 把 import.meta.url 解析成真实路径，argv[1] 却原样保留，脚本于是什么都不做就 exit 0。
 * /opt/lecturelive（或其上级）是软链的主机上，systemd 的支付预检闸门（ExecStartPre）与
 * 就绪探针（ExecStartPost、install/upgrade/rollback/lecture-live）都因此 fail-open。
 *
 * 这里复刻那种布局：真实发布目录 release/ + 指向它的软链 app/（≈ /opt/lecturelive），
 * 经两条路径分别以子进程启动每个脚本，要求 main() 都真的跑了。临时目录先取 realpath：
 * macOS 的 tmpdir 本身就在 /var → /private/var 软链下，不取的话「真实路径」那组也是软链。
 */

const ROOT = process.cwd();
const READINESS_SECRET = 'r'.repeat(64);

let base = '';
let closedPort = 0;

type RunResult = { status: number | null; output: string };

/** 最小环境起子进程：不继承 CI 的 DATABASE_URL 等变量，免得脚本连上真库。 */
function runNode(args: string[], env: Record<string, string>): Promise<RunResult> {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    ...env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(base, 'cwd'),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(killTimer);
      resolve({ status, output });
    });
  });
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const unreachableDatabase = () => ({
  DATABASE_URL: `mysql://lecturelive:lecturelive@127.0.0.1:${closedPort}/lecturelive`,
});

// marker 只会出现在各自 main() 的输出里：看到它（且退出码对）就说明脚本真的执行了。
const CASES: Array<{
  script: string;
  args: string[];
  env: () => Record<string, string>;
  status: number;
  marker: string;
}> = [
  {
    script: 'scripts/check-readiness.mjs',
    args: [],
    env: () => ({
      JWT_SECRET: READINESS_SECRET,
      HEALTH_READINESS_URL: `http://127.0.0.1:${closedPort}/api/health/ready`,
    }),
    status: 1,
    marker: '[health:ready] FATAL:',
  },
  {
    script: 'scripts/check-production-payment-config.mjs',
    args: [],
    env: unreachableDatabase,
    status: 1,
    marker: '[payment:preflight] FATAL:',
  },
  {
    script: 'scripts/backfill-conversation-user-id.mjs',
    args: [],
    env: unreachableDatabase,
    status: 1,
    marker: '回填 Conversation.userId 失败',
  },
  {
    script: 'scripts/reencrypt-llm-provider-keys.mjs',
    args: ['--dry-run'],
    env: () => ({ ...unreachableDatabase(), ENCRYPTION_KEY: 'k'.repeat(64) }),
    status: 1,
    marker: 'Failed to re-encrypt stored secrets:',
  },
  {
    script: 'scripts/reconcile-stripe-history.mjs',
    args: ['--help'],
    env: () => ({}),
    status: 0,
    marker: 'Usage:',
  },
  {
    // 不给 AUDIO_WORKER_TOKEN：main() 第一步就拒绝启动，不会真的监听端口
    script: 'worker/audio-enhance-worker.mjs',
    args: [],
    env: () => ({}),
    status: 1,
    marker: 'AUDIO_WORKER_TOKEN 未设置',
  },
];

beforeAll(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lecturelive-entrypoint-')));
  const release = path.join(base, 'release');
  cpSync(path.join(ROOT, 'scripts'), path.join(release, 'scripts'), { recursive: true });
  mkdirSync(path.join(release, 'worker'));
  copyFileSync(
    path.join(ROOT, 'worker', 'audio-enhance-worker.mjs'),
    path.join(release, 'worker', 'audio-enhance-worker.mjs')
  );
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(release, 'node_modules'), 'dir');
  symlinkSync(release, path.join(base, 'app'), 'dir');
  mkdirSync(path.join(base, 'cwd'));

  // 拿一个刚释放的端口当「不可达」的 DB / 就绪地址：连接立刻被拒，不必等超时
  const probe = createTcpServer();
  closedPort = await listen(probe);
  await close(probe);
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

for (const { script, args, env, status, marker } of CASES) {
  describe(script, () => {
    it.each([
      ['真实路径', 'release'],
      ['软链路径', 'app'],
    ])('经%s启动时 main() 确实执行', async (_label, dir) => {
      const result = await runNode([path.join(base, dir, script), ...args], env());
      expect(result.output).toContain(marker);
      expect(result.status).toBe(status);
    }, 30_000);
  });
}

describe('入口判断不误伤 import', () => {
  const importAll = () =>
    CASES.map(
      ({ script }) =>
        `await import(${JSON.stringify(pathToFileURL(path.join(base, 'app', script)).href)});`
    ).join('\n') + "\nconsole.log('imported');";
  const allEnv = () => Object.assign({}, ...CASES.map(({ env }) => env()));
  // 任一 main() 被误触发都会留下 marker 并以非零码退出（worker 直接 process.exit(1)）
  const expectImportedOnly = ({ status, output }: RunResult) => {
    expect(output).toContain('imported');
    for (const { marker } of CASES) expect(output).not.toContain(marker);
    expect(status).toBe(0);
  };

  it('经软链路径被另一个入口 import 时不执行 main()', async () => {
    const importer = path.join(base, 'cwd', 'import-all.mjs');
    writeFileSync(importer, importAll());
    expectImportedOnly(await runNode([importer], allEnv()));
  }, 30_000);

  it('argv[1] 无法解析时不抛错、不执行 main()', async () => {
    expectImportedOnly(
      await runNode(
        ['--input-type=module', '-e', importAll(), 'no-such-entrypoint.mjs'],
        allEnv()
      )
    );
  }, 30_000);
});

describe('check-readiness 经软链路径的 exit 0 是真的探过', () => {
  it('带派生 token 请求 /api/health/ready，拿到 200 才退出 0', async () => {
    const requests: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const port = await listen(server);
    try {
      const result = await runNode([path.join(base, 'app', 'scripts/check-readiness.mjs')], {
        JWT_SECRET: READINESS_SECRET,
        HEALTH_READINESS_URL: `http://127.0.0.1:${port}/api/health/ready`,
      });
      expect(result.status).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('/api/health/ready');
      expect(requests[0].headers.authorization).toBe(
        `Bearer ${deriveReadinessToken(READINESS_SECRET)}`
      );
    } finally {
      await close(server);
    }
  }, 30_000);
});
