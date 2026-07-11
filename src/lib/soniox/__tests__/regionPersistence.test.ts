import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-16 回归：任务开始时按 session 选择的 region 解析并**持久化实际 region**，之后全链路读该字段。
 *
 * 旧代码全链路 resolveSonioxRuntimeConfigAsync({}) 忽略 session.sonioxRegion → EU/JP 用户仍走默认
 * region；且默认中途变更会让 poll/delete 去错 region。本测试锁死：
 *  - resolveAndPersistTaskRegion 把解析出的具体 region 写回 session（'auto' → 具体值）；
 *  - resolveSonioxConfigForSessionRegion 按传入的具体 region 解析（不落回默认）。
 */
const { sessionUpdateManyMock, siteSettingFindManyMock } = vi.hoisted(() => ({
  sessionUpdateManyMock: vi.fn(),
  siteSettingFindManyMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { updateMany: sessionUpdateManyMock },
    siteSetting: { findMany: siteSettingFindManyMock },
  },
}));
vi.mock('@/lib/crypto', () => ({ decrypt: (v: string) => v }));

import {
  resolveAndPersistTaskRegion,
  resolveSonioxConfigForSessionRegion,
  invalidateSonioxDbConfigCache,
} from '@/lib/soniox/env';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  siteSettingFindManyMock.mockResolvedValue([]);
  sessionUpdateManyMock.mockResolvedValue({ count: 1 });
  invalidateSonioxDbConfigCache();
  // 配置 us + eu 两个 region 的 key；不设默认 region（→ 'auto' 落到 DEFAULT_REGION 'us'）。
  delete process.env.SONIOX_DEFAULT_REGION;
  delete process.env.SONIOX_API_KEY;
  process.env.SONIOX_US_API_KEY = 'k-us';
  process.env.SONIOX_EU_API_KEY = 'k-eu';
  delete process.env.SONIOX_JP_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveAndPersistTaskRegion', () => {
  it("session 选 'eu' → 解析 eu 配置，且已是具体值不重复写库", async () => {
    const config = await resolveAndPersistTaskRegion('sess-1', 'eu');
    expect(config?.region).toBe('eu');
    // 传入已是具体 'eu' 且解析结果一致 → 不写库
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it("session 为 'auto' → 解析出具体 region 后**写回** session.sonioxRegion（固定本任务 region）", async () => {
    const config = await resolveAndPersistTaskRegion('sess-2', 'auto');
    expect(config?.region).toBe('us'); // 无 headers / 无默认 → DEFAULT_REGION 'us'
    expect(sessionUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'sess-2' },
      data: { sonioxRegion: 'us' },
    });
  });

  it('凭据缺失 → 返回 null 且不写库', async () => {
    delete process.env.SONIOX_US_API_KEY;
    delete process.env.SONIOX_EU_API_KEY;
    const config = await resolveAndPersistTaskRegion('sess-3', 'jp');
    expect(config).toBeNull();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe('resolveSonioxConfigForSessionRegion', () => {
  it('按已固定的具体 region 解析，绝不落回默认', async () => {
    const config = await resolveSonioxConfigForSessionRegion('eu');
    expect(config?.region).toBe('eu');
  });
});
