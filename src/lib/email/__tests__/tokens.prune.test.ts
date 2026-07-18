import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #15：pruneExpiredEmailTokens 此前零调用（已接进维护循环的每日窗口）。
 * 它本身也一直零测试覆盖 —— 而它的危险方向不是"少删"，是"多删"：
 * 截止时间算错就会删掉尚未过期的验证/重置令牌，把正在流程中的用户链接打死。
 */

const { deleteManyMock } = vi.hoisted(() => ({ deleteManyMock: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: { emailToken: { deleteMany: deleteManyMock } },
}));

import { pruneExpiredEmailTokens } from '@/lib/email/tokens';

const NOW = new Date('2026-07-18T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** 取本次 deleteMany 的 where.OR 里两个字段的截止时间。 */
function cutoffs() {
  const where = deleteManyMock.mock.calls[0][0].where;
  const expires = where.OR.find((c: Record<string, unknown>) => 'expiresAt' in c);
  const consumed = where.OR.find((c: Record<string, unknown>) => 'consumedAt' in c);
  return {
    expiresAt: expires.expiresAt.lt as Date,
    consumedAt: consumed.consumedAt.lt as Date,
  };
}

describe('pruneExpiredEmailTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    deleteManyMock.mockResolvedValue({ count: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('缺省保留最近 7 天，只删更早的', async () => {
    await pruneExpiredEmailTokens();

    const { expiresAt, consumedAt } = cutoffs();
    const expected = new Date(NOW.getTime() - 7 * DAY_MS);
    expect(expiresAt).toEqual(expected);
    expect(consumedAt).toEqual(expected);
  });

  // 关键安全性质：截止时间必须严格早于"现在"。若误写成 new Date()，
  // 一次维护就会把所有已消费令牌连同刚发出去、还没点的链接一起清掉。
  it('截止时间在过去，不会波及当前有效期内的令牌', async () => {
    await pruneExpiredEmailTokens();

    const { expiresAt } = cutoffs();
    expect(expiresAt.getTime()).toBeLessThan(NOW.getTime());
    // 24h 有效的验证令牌（最长 TTL）必须落在保留窗口内
    expect(NOW.getTime() - expiresAt.getTime()).toBeGreaterThanOrEqual(DAY_MS);
  });

  it('尊重自定义保留时长', async () => {
    await pruneExpiredEmailTokens(30 * DAY_MS);

    const { expiresAt } = cutoffs();
    expect(expiresAt).toEqual(new Date(NOW.getTime() - 30 * DAY_MS));
  });

  it('只按 expiresAt / consumedAt 两个条件删，不会全表清空', async () => {
    await pruneExpiredEmailTokens();

    const where = deleteManyMock.mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(['OR']);
    expect(where.OR).toHaveLength(2);
  });

  it('返回删除条数', async () => {
    deleteManyMock.mockResolvedValue({ count: 42 });
    await expect(pruneExpiredEmailTokens()).resolves.toBe(42);
  });
});
