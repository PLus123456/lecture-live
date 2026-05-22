import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCachedTokens,
  getCloudreveAuthStatus,
  invalidateCloudreveConfigCache,
  loadTokensIntoCache,
} from '@/lib/storage/cloudreve';

// 重点验证：getCloudreveAuthStatus 永远从 DB 读，不再受本进程内存缓存影响。
const siteSettingFindManyMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      findMany: (...args: unknown[]) => siteSettingFindManyMock(...args),
    },
  },
}));

describe('getCloudreveAuthStatus —— 跨进程一致性', () => {
  beforeEach(() => {
    siteSettingFindManyMock.mockReset();
    clearCachedTokens();
    invalidateCloudreveConfigCache();
  });

  afterEach(() => {
    clearCachedTokens();
    invalidateCloudreveConfigCache();
  });

  it('DB 里有有效 refresh_token 且未过期 → 返回 authorized=true + 未来 expiresAt', async () => {
    const future = Date.now() + 60 * 60_000; // 1 小时后
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_refresh_token', value: 'enc:v2:rt-cipher' },
      { key: 'cloudreve_access_token', value: 'enc:v2:at-cipher' },
      { key: 'cloudreve_token_expires_at', value: String(future) },
    ]);

    const status = await getCloudreveAuthStatus();

    expect(status.authorized).toBe(true);
    expect(status.expiresAt).toBe(future);
  });

  it('DB 里有 refresh_token 但 access_token 已过期 → 仍返回 authorized=true（认证还在，只是要刷下次刷新会处理）', async () => {
    const past = Date.now() - 10 * 60_000; // 10 分钟前
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_refresh_token', value: 'enc:v2:rt-cipher' },
      { key: 'cloudreve_token_expires_at', value: String(past) },
    ]);

    const status = await getCloudreveAuthStatus();

    expect(status.authorized).toBe(true);
    expect(status.expiresAt).toBe(past);
  });

  it('DB 里没有 token → 返回 authorized=false, expiresAt=null', async () => {
    siteSettingFindManyMock.mockResolvedValue([]);

    const status = await getCloudreveAuthStatus();

    expect(status.authorized).toBe(false);
    expect(status.expiresAt).toBeNull();
  });

  it('关键回归：即使本进程 tokenCache.expiresAt 是旧值（"看似已过期"），仍返回 DB 中的最新 expiresAt —— 修复 process-isolation bug', async () => {
    // 模拟本地缓存：本进程上次刷新时 expiresAt 在 2 小时前（已过期）
    const stalePast = Date.now() - 2 * 60 * 60_000;
    loadTokensIntoCache({
      accessToken: 'stale-at',
      refreshToken: 'stale-rt',
      expiresAt: stalePast,
    });

    // 但实际上 WS 进程刚刷新过，DB 里的 expires_at 是未来的
    const dbFuture = Date.now() + 50 * 60_000;
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_refresh_token', value: 'enc:v2:fresh-rt' },
      { key: 'cloudreve_access_token', value: 'enc:v2:fresh-at' },
      { key: 'cloudreve_token_expires_at', value: String(dbFuture) },
    ]);

    const status = await getCloudreveAuthStatus();

    // 必须返回 DB 中的新鲜值，而不是本地缓存里的过期值。
    expect(status.authorized).toBe(true);
    expect(status.expiresAt).toBe(dbFuture);
    // 必须真的去查了 DB
    expect(siteSettingFindManyMock).toHaveBeenCalledTimes(1);
  });

  it('DB 异常（findMany 抛错）时返回 unauthorized 兜底，不抛到调用方', async () => {
    siteSettingFindManyMock.mockRejectedValue(new Error('db down'));

    const status = await getCloudreveAuthStatus();

    expect(status).toEqual({ authorized: false, expiresAt: null });
  });

  it('DB 中 expires_at 是非数字字符串时回退为 null（防御性解析）', async () => {
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_refresh_token', value: 'enc:v2:rt' },
      { key: 'cloudreve_token_expires_at', value: 'not-a-number' },
    ]);

    const status = await getCloudreveAuthStatus();

    expect(status.authorized).toBe(true);
    expect(status.expiresAt).toBeNull();
  });

  it('DB 中 refresh_token 是空字符串 → 视为未授权', async () => {
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_refresh_token', value: '   ' },
    ]);

    const status = await getCloudreveAuthStatus();

    expect(status.authorized).toBe(false);
  });
});
