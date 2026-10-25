import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  main as checkReadiness,
  deriveReadinessToken,
} from '../../scripts/check-readiness.mjs';

// 探针子进程要连本进程里的假运行时：必须异步执行，spawnSync 会卡住事件循环
const execFileAsync = promisify(execFile);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('SEC-032 readiness deployment wiring', () => {
  it('uses the authenticated deep probe for Docker and managed deploys', () => {
    const root = process.cwd();
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const install = readFileSync(path.join(root, 'deploy/install.sh'), 'utf8');
    const upgrade = readFileSync(path.join(root, 'deploy/upgrade.sh'), 'utf8');
    const rollback = readFileSync(path.join(root, 'deploy/rollback.sh'), 'utf8');
    const cli = readFileSync(path.join(root, 'deploy/lecture-live'), 'utf8');
    const webUnit = readFileSync(
      path.join(root, 'deploy/lecturelive-web.service'),
      'utf8'
    );
    const wsUnit = readFileSync(
      path.join(root, 'deploy/lecturelive-ws.service'),
      'utf8'
    );
    const marker = readFileSync(
      path.join(root, 'deploy/runtime-security-version'),
      'utf8'
    ).trim();

    expect(dockerfile).toContain(
      'CMD ["node", "scripts/check-readiness.mjs"]'
    );
    expect(compose).toContain('["CMD", "node", "scripts/check-readiness.mjs"]');
    for (const script of [install, upgrade]) {
      expect(script).toContain('"$SRC_DIR/scripts/check-readiness.mjs"');
    }
    for (const script of [install, upgrade, rollback, cli]) {
      expect(script).toContain('check-readiness.mjs');
      expect(script).toContain('systemctl stop');
    }
    expect(marker).toBe('health-ready-v1');
    expect(webUnit).toContain(
      'ExecStartPre=/usr/bin/grep -Fxq health-ready-v1 /opt/lecturelive/.runtime-security-version'
    );
    expect(wsUnit).toContain(
      'ExecStartPre=/usr/bin/grep -Fxq health-ready-v1 /opt/lecturelive/.runtime-security-version'
    );
    expect(webUnit).toContain('ExecStartPost=');
    expect(webUnit).toContain('check-readiness.mjs --wait');
    expect(webUnit).toContain('BindsTo=lecturelive-ws.service');
    expect(webUnit).toContain(
      'After=network.target mysql.service redis.service lecturelive-ws.service'
    );
    expect(wsUnit).toContain('BindsTo=lecturelive-web.service');
    for (const unit of [webUnit, wsUnit]) {
      expect(unit).toContain('Restart=no');
      expect(unit).not.toMatch(/^Restart=always$/m);
    }
    for (const script of [install, upgrade]) {
      expect(script).toContain(
        'runtime-security-version" "$APP_DIR/.runtime-security-version"'
      );
    }
    for (const script of [rollback, cli]) {
      expect(script).toContain('health-ready-v1');
    }
    for (const script of [install, upgrade, rollback]) {
      expect(
        script.lastIndexOf('systemctl is-active --quiet lecturelive-web')
      ).toBeGreaterThan(script.indexOf('check-readiness.mjs" --wait'));
      expect(
        script.lastIndexOf('systemctl is-active --quiet lecturelive-ws')
      ).toBeGreaterThan(script.indexOf('check-readiness.mjs" --wait'));
    }
  });

  it('never retries a reachable old runtime with no protected route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      checkReadiness(
        { JWT_SECRET: 'x'.repeat(64), NODE_ENV: 'test' },
        { attempts: 10, retryDelayMs: 0 }
      )
    ).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient startup failures before declaring readiness', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      checkReadiness(
        { JWT_SECRET: 'x'.repeat(64), NODE_ENV: 'test' },
        { attempts: 2, retryDelayMs: 0 }
      )
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * rollback.sh 允许把早于 health-ready-v1 的备份连同同一时间戳的旧 unit 一起退回——这是首次
 * 升级中途失败时唯一能上线的目标。可那一代运行时没有 /api/health/ready（中间件放行
 * /api/health* 后 404），探新路由只会让这条退路以「停服」收场；探针必须跟随被恢复运行时
 * 的 marker。这里把 rollback.sh 里真实的探测几行抠出来，对着本地假运行时真跑一遍
 * check-readiness.mjs：runuser 换成直接执行，/usr/bin/node 换成当前 node。
 */
describe('rollback.sh readiness follows the restored runtime marker', () => {
  const root = process.cwd();
  const rollback = readFileSync(path.join(root, 'deploy/rollback.sh'), 'utf8');
  const servers: Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
    );
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** legacy：只有匿名 /api/health；current：受保护的 /api/health/ready。 */
  async function fakeRuntime(kind: 'legacy' | 'current', secret: string) {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? '');
      const authorized =
        req.headers.authorization === `Bearer ${deriveReadinessToken(secret)}`;
      const status =
        req.url === '/api/health'
          ? 200
          : req.url === '/api/health/ready' && kind === 'current'
            ? authorized
              ? 200
              : 401
            : 404;
      res.writeHead(status).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  function probeLines(port: number) {
    const lines = rollback.split('\n');
    const start = lines.findIndex((line) => line === 'READINESS_PROBE=(/usr/bin/node)');
    const end = lines.findIndex((line) => line.endsWith('--wait >/dev/null 2>&1 && HEALTH_OK=true'));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const legacyUrl = lines.find((line) => line.startsWith('LEGACY_HEALTH_URL='));
    expect(legacyUrl).toBe('LEGACY_HEALTH_URL="http://127.0.0.1:3000/api/health"');
    return [legacyUrl!.replace('127.0.0.1:3000', `127.0.0.1:${port}`), ...lines.slice(start, end + 1)]
      .join('\n')
      .replaceAll('/usr/bin/node', process.execPath);
  }

  async function runProbe(legacy: boolean, port: number, secret: string) {
    // 必须是真实路径：macOS 的 tmpdir 经过软链，check-readiness.mjs 的入口判断拿
    // import.meta.url（真实路径）比 argv[1]（软链路径），对不上就什么都不做、直接 exit 0。
    const appDir = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'lecturelive-rollback-ready-'))
    );
    tempDirs.push(appDir);
    mkdirSync(path.join(appDir, 'scripts'));
    copyFileSync(
      path.join(root, 'scripts/check-readiness.mjs'),
      path.join(appDir, 'scripts/check-readiness.mjs')
    );
    // 部署 .env 里的地址指向新路由；legacy 分支显式传入的 HEALTH_READINESS_URL 必须压过它
    writeFileSync(
      path.join(appDir, '.env'),
      `JWT_SECRET=${secret}\nHEALTH_READINESS_URL=http://127.0.0.1:${port}/api/health/ready\n`
    );
    const script = [
      'runuser() { [[ "$1" == "-u" && "$2" == "lecturelive" && "$3" == "--" ]] || exit 97; shift 3; "$@"; }',
      'systemctl() { return 0; }',
      'sleep() { :; }',
      `APP_DIR='${appDir}'`,
      'APP_USER=lecturelive',
      `LEGACY_RUNTIME=${legacy}`,
      probeLines(port),
      'printf "HEALTH_OK=%s\\n" "$HEALTH_OK"',
    ].join('\n');
    // 最小环境，与 sudo 下的部署脚本一致：vitest.setup 往 process.env 塞了 JWT_SECRET，
    // 继承下去会压过部署 .env（--env-file 不覆盖已有变量），探针就拿错密钥派生 token。
    // Next 的类型把 NODE_ENV 声明成必填，这里刻意不给，只能双重断言。
    const { stdout } = await execFileAsync('bash', ['-euo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv,
    });
    return stdout.trim();
  }

  it('probes the legacy runtime through its own /api/health after a paired unit rollback', async () => {
    const secret = 'r'.repeat(64);
    const runtime = await fakeRuntime('legacy', secret);
    await expect(runProbe(true, runtime.port, secret)).resolves.toBe('HEALTH_OK=true');
    expect(runtime.seen).toEqual(['/api/health']);
  }, 30_000);

  it('documents the dead end it replaces: the protected probe always fails on a legacy runtime', async () => {
    const secret = 'r'.repeat(64);
    const runtime = await fakeRuntime('legacy', secret);
    await expect(runProbe(false, runtime.port, secret)).resolves.toBe('HEALTH_OK=false');
    // 404 不重试：一次就判失败
    expect(runtime.seen).toEqual(['/api/health/ready']);
  }, 30_000);

  it('keeps the protected deep probe for every runtime that carries the marker', async () => {
    const secret = 'r'.repeat(64);
    const runtime = await fakeRuntime('current', secret);
    await expect(runProbe(false, runtime.port, secret)).resolves.toBe('HEALTH_OK=true');
    expect(runtime.seen).toEqual(['/api/health/ready']);
  }, 30_000);

  it('marks the runtime legacy only in the branch that restores the paired units', () => {
    const init = rollback.indexOf('LEGACY_RUNTIME=false');
    const markerCheck = rollback.indexOf(
      `! grep -Fxq 'health-ready-v1' "$RUNTIME_SECURITY_MARKER"`
    );
    const unitRestore = rollback.indexOf('tar xzf "$UNIT_BACKUP" -C /etc/systemd/system');
    const legacy = rollback.indexOf('LEGACY_RUNTIME=true');
    const refuse = rollback.indexOf('缺少配套的 systemd unit 备份');

    expect(init).toBeGreaterThan(0);
    expect(init).toBeLessThan(markerCheck);
    expect(legacy).toBeGreaterThan(unitRestore);
    expect(legacy).toBeLessThan(refuse);
    expect(rollback.match(/LEGACY_RUNTIME=true/g)).toHaveLength(1);
  });
});
