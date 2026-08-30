import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main as checkReadiness } from '../../scripts/check-readiness.mjs';

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

  it('makes the CLI rollback fallback fail closed around both service states', () => {
    const cli = readFileSync(
      path.join(process.cwd(), 'deploy/lecture-live'),
      'utf8'
    );
    const fallback = cli.slice(
      cli.indexOf('|| bash -c "'),
      cli.indexOf('\n        "', cli.indexOf('|| bash -c "'))
    );

    expect(fallback).toContain(
      'systemctl start $WEB_SERVICE $WS_SERVICE || {'
    );
    expect(fallback).toContain(
      '回滚版本启动失败且无法确认服务已停止'
    );
    expect(fallback).toContain(
      'if ! systemctl is-active --quiet $WEB_SERVICE || ! systemctl is-active --quiet $WS_SERVICE; then'
    );
    expect(fallback).toContain(
      '回滚版本未全部进入 active，服务已保持停止'
    );
    expect(fallback.indexOf('未全部进入 active')).toBeLessThan(
      fallback.indexOf('check-readiness.mjs --wait')
    );
    expect(
      fallback.lastIndexOf(
        'if ! systemctl is-active --quiet $WEB_SERVICE || ! systemctl is-active --quiet $WS_SERVICE; then'
      )
    ).toBeGreaterThan(fallback.indexOf('check-readiness.mjs --wait'));
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
