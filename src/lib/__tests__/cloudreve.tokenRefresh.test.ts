import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteSettings } from '@/lib/siteSettings';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  clearCachedTokens,
  invalidateCloudreveConfigCache,
  loadTokensIntoCache,
  refreshCloudreveTokenProactively,
} from '@/lib/storage/cloudreve';

// 覆盖 v3-B4：C17（主动刷新无条件重读 DB）、C18（瞬时错误保留 token / 确定性拒绝才删）。
// 均通过导出的 refreshCloudreveTokenProactively 驱动内部 refreshAccessToken + 条件清 token。

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: vi.fn(),
}));

// crypto：用可预测的桩，encrypt(x)='ENC('+x+')'，decrypt 逆运算，避免依赖 ENCRYPTION_KEY。
vi.mock('@/lib/crypto', () => ({
  encrypt: (plain: string) => `ENC(${plain})`,
  decrypt: (cipher: string) =>
    cipher.startsWith('ENC(') ? cipher.slice(4, -1) : cipher,
  isEncrypted: (v: string) => v.startsWith('ENC('),
}));

vi.mock('@/lib/auditLog', () => ({
  logSystemEvent: vi.fn(),
}));

const findManyMock = vi.fn();
const deleteManyMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      deleteMany: (...a: unknown[]) => deleteManyMock(...a),
      upsert: vi.fn(),
    },
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));

const mockedGetSiteSettings = vi.mocked(getSiteSettings);

function createSiteSettings(): SiteSettings {
  // 本测试只用到 storage_mode + cloudreve_* 四个字段，其余用 as 收敛类型。
  return {
    storage_mode: 'cloudreve',
    cloudreve_url: 'https://cloud.example.com/',
    cloudreve_client_id: 'cid',
    cloudreve_client_secret: 'csecret',
  } as SiteSettings;
}

/** DB 里存有一份已过期的 refresh_token（触发刷新路径） */
function seedExpiredDbToken(refreshToken = 'db-refresh-token') {
  findManyMock.mockResolvedValue([
    { key: 'cloudreve_access_token', value: `ENC(old-access)` },
    { key: 'cloudreve_refresh_token', value: `ENC(${refreshToken})` },
    { key: 'cloudreve_token_expires_at', value: String(Date.now() - 60_000) },
  ]);
}

describe('Cloudreve 主动刷新 · 错误分类 & DB 重读 (v3-B4)', () => {
  beforeEach(() => {
    delete process.env.CLOUDREVE_BASE_URL;
    delete process.env.CLOUDREVE_CLIENT_ID;
    delete process.env.CLOUDREVE_CLIENT_SECRET;
    delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
    mockedGetSiteSettings.mockReset();
    mockedGetSiteSettings.mockResolvedValue(createSiteSettings());
    findManyMock.mockReset();
    deleteManyMock.mockReset().mockResolvedValue({ count: 3 });
    transactionMock.mockReset().mockResolvedValue([]);
    clearCachedTokens();
    invalidateCloudreveConfigCache();
  });

  it('C18：refresh 返回 5xx（瞬时错误）时保留 token，绝不 clearPersistedTokens', async () => {
    seedExpiredDbToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream boom', { status: 502 })
    );

    await expect(
      refreshCloudreveTokenProactively({ source: 'scheduler' })
    ).rejects.toThrow(/502/);

    // 瞬时错误：不能删 token
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('C18：refresh 超时（AbortError）时保留 token', async () => {
    seedExpiredDbToken();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      })
    );

    await expect(
      refreshCloudreveTokenProactively({ source: 'scheduler' })
    ).rejects.toThrow();

    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('C18：refresh 返回 401（确定性拒绝）时清除 token', async () => {
    seedExpiredDbToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })
    );

    await expect(
      refreshCloudreveTokenProactively({ source: 'scheduler' })
    ).rejects.toThrow();

    // 确定性拒绝：应删 token
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });

  it('C18：200 响应体含 invalid_grant 时视为确定性拒绝并清除 token', async () => {
    seedExpiredDbToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ code: 40001, msg: 'invalid_grant: token revoked' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      refreshCloudreveTokenProactively({ source: 'scheduler' })
    ).rejects.toThrow();

    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });

  it('C18：200 响应体为未知业务码时当瞬时错误，保留 token', async () => {
    seedExpiredDbToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ code: 50000, msg: 'internal server error' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      refreshCloudreveTokenProactively({ source: 'scheduler' })
    ).rejects.toThrow();

    // 未知业务码：不删 token
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('C17：即使内存缓存里已有 token，也无条件以 DB 的 refresh_token 为准刷新', async () => {
    // 内存缓存持有一份"陈旧"的 refresh_token（模拟 Next 已 rotate、WS 内存未更新）
    loadTokensIntoCache({
      accessToken: 'stale-access',
      refreshToken: 'STALE-memory-refresh',
      expiresAt: Date.now() - 60_000,
    });
    // DB 里是较新的 refresh_token
    seedExpiredDbToken('FRESH-db-refresh');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 7200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await refreshCloudreveTokenProactively({
      source: 'scheduler',
    });
    expect(result.action).toBe('refreshed');

    // 关键断言：刷新请求体里带的是 DB 的 refresh_token，而非内存里的陈旧值
    const body = fetchMock.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain('FRESH-db-refresh');
    expect(body).not.toContain('STALE-memory-refresh');
  });
});
