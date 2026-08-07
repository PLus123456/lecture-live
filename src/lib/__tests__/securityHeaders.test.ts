import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Y15/L9：next.config.js 的 Permissions-Policy 曾漏掉本站真正会用到的强权限。
 *
 * 注意口径：工单原文写「加 display-capture=()」，但 audioCapture.ts 的系统音频源
 * 走的就是 getDisplayMedia —— 关成 () 会直接打死这个录制源。正确写法是 (self)。
 */

const require = createRequire(import.meta.url);

interface HeaderEntry {
  key: string;
  value: string;
}

async function loadHeaders(): Promise<Map<string, string>> {
  const configPath = path.join(process.cwd(), 'next.config.js');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath) as {
    headers: () => Promise<Array<{ headers: HeaderEntry[] }>>;
  };
  const groups = await config.headers();
  const map = new Map<string, string>();
  for (const group of groups) {
    for (const entry of group.headers) {
      map.set(entry.key, entry.value);
    }
  }
  return map;
}

function parsePermissionsPolicy(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of value.split(',')) {
    const [feature, ...rest] = part.trim().split('=');
    map.set(feature.trim(), rest.join('=').trim());
  }
  return map;
}

describe('Permissions-Policy (Y15 / L9)', () => {
  it('显式声明 microphone=(self)', async () => {
    const policy = parsePermissionsPolicy(
      (await loadHeaders()).get('Permissions-Policy') as string
    );
    expect(policy.get('microphone')).toBe('(self)');
  });

  it('显式声明 display-capture=(self) —— 系统音频源要用，不能关成 ()', async () => {
    const policy = parsePermissionsPolicy(
      (await loadHeaders()).get('Permissions-Policy') as string
    );
    expect(policy.get('display-capture')).toBe('(self)');
  });

  it('用不到的强权限保持关闭', async () => {
    const policy = parsePermissionsPolicy(
      (await loadHeaders()).get('Permissions-Policy') as string
    );
    for (const feature of ['camera', 'geolocation', 'payment', 'usb', 'serial']) {
      expect(policy.get(feature)).toBe('()');
    }
  });

  it('CSP 基础指令未被削弱', async () => {
    const csp = (await loadHeaders()).get('Content-Security-Policy') as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });
});
