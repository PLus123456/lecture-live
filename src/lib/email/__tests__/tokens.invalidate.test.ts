import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

const { updateManyMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { emailToken: { updateMany: updateManyMock } },
}));

import { invalidateUserEmailTokens } from '@/lib/email/tokens';

describe('invalidateUserEmailTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManyMock.mockResolvedValue({ count: 2 });
  });

  it('默认作废该用户全部未消费令牌（不限类型）并返回条数', async () => {
    const count = await invalidateUserEmailTokens('u1');

    expect(count).toBe(2);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = updateManyMock.mock.calls[0][0];
    expect(arg.where).toMatchObject({ userId: 'u1', consumedAt: null });
    // 不传 types 时不得带类型过滤，否则 VERIFY_EMAIL 令牌会漏网——
    // verify-email 消费后直接签发会话，留着等于一枚免密登录链接。
    expect(arg.where.type).toBeUndefined();
    expect(arg.data.consumedAt).toBeInstanceOf(Date);
  });

  it('只作废未消费的令牌（consumedAt=null 守卫，不覆写历史消费时间）', async () => {
    await invalidateUserEmailTokens('u1');
    expect(updateManyMock.mock.calls[0][0].where.consumedAt).toBeNull();
  });

  it('传 types 时按类型过滤', async () => {
    await invalidateUserEmailTokens('u1', { types: ['RESET_PASSWORD'] });
    expect(updateManyMock.mock.calls[0][0].where.type).toEqual({ in: ['RESET_PASSWORD'] });
  });

  it('types 为空数组视为不过滤（避免 in:[] 匹配零行的静默失效）', async () => {
    await invalidateUserEmailTokens('u1', { types: [] });
    expect(updateManyMock.mock.calls[0][0].where.type).toBeUndefined();
  });

  it('传 db 时走该客户端（事务内），不碰全局 prisma', async () => {
    const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { emailToken: { updateMany: txUpdateMany } };

    const count = await invalidateUserEmailTokens('u1', {
      db: tx as unknown as Prisma.TransactionClient,
    });

    expect(count).toBe(1);
    expect(txUpdateMany).toHaveBeenCalledTimes(1);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
