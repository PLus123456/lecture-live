import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const INSTALL = path.join(ROOT, 'worker', 'install.sh');

describe('worker/install.sh 幂等重跑 = 升级并重启', () => {
  const script = readFileSync(INSTALL, 'utf8');

  it('语法有效', () => {
    const result = spawnSync('bash', ['-n', INSTALL], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('daemon-reload 之后无条件 restart（enable --now 对运行中的单元是空操作）', () => {
    // 旧写法：restart 挂在 `enable --now` 的 || 分支上，enable 成功（返回 0）时永远走不到
    expect(script).not.toMatch(/enable --now[^\n]*\|\|\s*systemctl restart/);

    const lines = script.split('\n');
    const reload = lines.findIndex((line) => line.trim() === 'systemctl daemon-reload');
    // restart 独占一条语句（不挂在任何 || 之后）
    const restart = lines.findIndex((line) =>
      line.startsWith('systemctl restart "$SERVICE_NAME"')
    );
    const health = lines.findIndex((line) => line.includes('/healthz'));
    expect(reload).toBeGreaterThan(0);
    expect(restart).toBeGreaterThan(reload);
    expect(health).toBeGreaterThan(restart);
  });
});
