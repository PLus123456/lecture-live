/**
 * P6-9（provider 返回的 URL 未过校验，纵深防御）+ P4-3②（416 被当普通失败 → 整文件缓冲）
 * + P2-2（脱敏占位当凭据用）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteSettings } from '@/lib/siteSettings';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  assertSafeProviderUrl,
  clearCachedTokens,
  CloudreveRangeNotSatisfiableError,
  CloudreveStorage,
  invalidateCloudreveConfigCache,
  isCloudreveConfiguredAsync,
  loadTokensIntoCache,
} from '@/lib/storage/cloudreve';

vi.mock('@/lib/siteSettings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/siteSettings')>(
    '@/lib/siteSettings'
  );
  return { ...actual, getSiteSettings: vi.fn() };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/auditLog', () => ({ logSystemEvent: vi.fn() }));

const mockedGetSiteSettings = vi.mocked(getSiteSettings);

function siteSettings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    storage_mode: 'cloudreve',
    cloudreve_url: 'https://cloud.example.com/',
    cloudreve_client_id: 'cid',
    cloudreve_client_secret: 'csecret',
    ...overrides,
  } as SiteSettings;
}

describe('P6-9 provider 返回的 URL 复用同一套主机校验', () => {
  const originalAllowPrivate = process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;

  beforeEach(() => {
    delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
  });

  afterEach(() => {
    if (originalAllowPrivate === undefined) {
      delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
    } else {
      process.env.CLOUDREVE_ALLOW_PRIVATE_HOST = originalAllowPrivate;
    }
  });

  it.each([
    ['云元数据', 'http://169.254.169.254/latest/meta-data/'],
    ['回环', 'http://127.0.0.1:5212/f'],
    ['内网 10/8', 'http://10.1.2.3/f'],
    ['IPv6 回环', 'http://[::1]/f'],
    ['.internal 域', 'http://minio.internal/f'],
    ['非 HTTP 协议', 'file:///etc/passwd'],
  ])('拒绝 %s', (_label, url) => {
    expect(() => assertSafeProviderUrl(url, '下载直链')).toThrow();
  });

  it('放行公网直链', () => {
    expect(
      assertSafeProviderUrl('https://cdn.example.com/f?sign=x', '下载直链').hostname
    ).toBe('cdn.example.com');
  });
});

describe('CloudreveStorage.openDownloadStream', () => {
  beforeEach(() => {
    mockedGetSiteSettings.mockReset();
    mockedGetSiteSettings.mockResolvedValue(siteSettings());
    clearCachedTokens();
    invalidateCloudreveConfigCache();
    loadTokensIntoCache({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCachedTokens();
    invalidateCloudreveConfigCache();
  });

  function mockUpstream(downloadUrl: string, fileResponse: Response) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/v4/file/url')) {
          return new Response(
            JSON.stringify({ code: 0, msg: '', data: { urls: [{ url: downloadUrl }] } })
          );
        }
        return fileResponse;
      });
  }

  it('P4-3：上游 416 抛专用错误（路由据此直接回 416，不整文件缓冲）', async () => {
    mockUpstream(
      'https://cdn.example.com/f',
      new Response(null, { status: 416, headers: { 'content-range': 'bytes */2048' } })
    );

    const storage = new CloudreveStorage();
    await expect(
      storage.openDownloadStream('/user-1/recordings/a.webm', {
        expectedUserId: 'user-1',
        range: 'bytes=99999999-',
      })
    ).rejects.toBeInstanceOf(CloudreveRangeNotSatisfiableError);
  });

  it('P6-9：provider 返回内网直链时拒绝下载（不发起对该地址的 fetch）', async () => {
    const fetchMock = mockUpstream(
      'http://169.254.169.254/latest/meta-data/',
      new Response('secret')
    );

    const storage = new CloudreveStorage();
    await expect(
      storage.openDownloadStream('/user-1/recordings/a.webm', {
        expectedUserId: 'user-1',
      })
    ).rejects.toThrow(/私网|本地地址/);

    // 只应有那一次拿直链的 API 调用，绝不能真的去访问 169.254.169.254。
    const called = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : String(c[0])
    );
    expect(called.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });

  it('P6-9：跟随重定向会绕开主机校验 —— 必须 redirect:manual', async () => {
    const fetchMock = mockUpstream('https://cdn.example.com/f', new Response('ok'));

    const storage = new CloudreveStorage();
    await storage.openDownloadStream('/user-1/recordings/a.webm', {
      expectedUserId: 'user-1',
    });

    const fileCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('cdn.example.com')
    );
    expect(fileCall?.[1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('P2-2 脱敏占位不得当凭据用', () => {
  beforeEach(() => {
    mockedGetSiteSettings.mockReset();
    clearCachedTokens();
    invalidateCloudreveConfigCache();
    delete process.env.CLOUDREVE_BASE_URL;
    delete process.env.CLOUDREVE_CLIENT_ID;
    delete process.env.CLOUDREVE_CLIENT_SECRET;
  });

  it('client_secret 落库成 ******** 时视为未配置（fail-closed）', async () => {
    mockedGetSiteSettings.mockResolvedValue(
      siteSettings({ cloudreve_client_secret: '********' })
    );
    await expect(isCloudreveConfiguredAsync()).resolves.toBe(false);
  });

  it('真实密钥照常视为已配置', async () => {
    mockedGetSiteSettings.mockResolvedValue(siteSettings());
    await expect(isCloudreveConfiguredAsync()).resolves.toBe(true);
  });
});
