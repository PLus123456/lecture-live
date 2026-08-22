import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L11：`resolvePublicAppOrigin` 原本是**请求头优先**
 * （x-forwarded-host → host → req.url），只要拼出来像公网地址就直接采用。
 * 这两个头都是调用方可控的，于是任意公网域名都能被当成本站 origin ——
 * 而这条链的产物是 Cloudreve OAuth 的 redirect_uri（授权回跳地址）。
 * 改成**配置优先**（site_url / NEXT_PUBLIC_APP_URL），配置缺失才回退请求头。
 */

vi.mock('server-only', () => ({}));

const { getSiteSettingsMock } = vi.hoisted(() => ({
  getSiteSettingsMock: vi.fn(),
}));

vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));

import { resolvePublicAppOrigin } from '@/lib/requestOrigin';

const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe('L11 resolvePublicAppOrigin —— 配置优先于可伪造的请求头', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
    getSiteSettingsMock.mockResolvedValue({ site_url: '' });
  });

  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
  });

  it('配置了 site_url 时，伪造的 x-forwarded-host 不再能改写 origin', async () => {
    getSiteSettingsMock.mockResolvedValue({ site_url: 'https://app.example.com' });

    const origin = await resolvePublicAppOrigin(
      req('http://127.0.0.1:3000/api/x', {
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
        host: 'attacker.example',
      })
    );

    expect(origin).toBe('https://app.example.com');
  });

  it('site_url 缺失时用 NEXT_PUBLIC_APP_URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://configured.example.com';

    const origin = await resolvePublicAppOrigin(
      req('http://127.0.0.1:3000/api/x', {
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      })
    );

    expect(origin).toBe('https://configured.example.com');
  });

  it('两者都没配时才回退请求头（本地开发 / 未配置站点地址）', async () => {
    const origin = await resolvePublicAppOrigin(
      req('http://127.0.0.1:3000/api/x', {
        'x-forwarded-host': 'app.example.com',
        'x-forwarded-proto': 'https',
      })
    );

    expect(origin).toBe('https://app.example.com');
  });

  it('配置成内网地址时不算数，仍回退请求头（保持既有行为）', async () => {
    getSiteSettingsMock.mockResolvedValue({ site_url: 'http://localhost:3000' });

    const origin = await resolvePublicAppOrigin(
      req('http://127.0.0.1:3000/api/x', {
        'x-forwarded-host': 'app.example.com',
        'x-forwarded-proto': 'https',
      })
    );

    expect(origin).toBe('https://app.example.com');
  });

  it('什么都没有时不抛，退回请求自身的 origin', async () => {
    const origin = await resolvePublicAppOrigin(req('http://localhost:3000/api/x'));
    expect(origin).toBe('http://localhost:3000');
  });
});
