import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * changePassword 的安全不变量：改密必须同时作废该用户全部未消费的邮件令牌。
 * 只 tokenVersion++ 是不够的——它吊销的是已签发会话，拦不住一封没用过的重置链接
 * （1h 内可把刚改的密码再改回去）或验证链接（消费后直接签发新会话）。
 */

const { userFindUniqueMock, userUpdateMock, emailTokenUpdateManyMock, transactionMock } =
  vi.hoisted(() => ({
    userFindUniqueMock: vi.fn(),
    userUpdateMock: vi.fn(),
    emailTokenUpdateManyMock: vi.fn(),
    transactionMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock, update: userUpdateMock },
    emailToken: { updateMany: emailTokenUpdateManyMock },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/redis', () => ({ getRedisClient: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/serverSecrets', () => ({ JWT_SECRET: 'test-secret-value-for-unit-tests' }));

import bcrypt from 'bcryptjs';
import { changePassword } from '@/lib/auth';

const UPDATED = { id: 'u1', email: 'a@b.com', role: 'FREE', tokenVersion: 8 };

describe('changePassword', () => {
  /** 记录 tx 内调用顺序，用于断言作废与改密在同一事务、且作废先发生。 */
  let callOrder: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    callOrder = [];

    const passwordHash = await bcrypt.hash('OldPassw0rd!', 4);
    userFindUniqueMock.mockResolvedValue({ id: 'u1', passwordHash });

    emailTokenUpdateManyMock.mockImplementation(async () => {
      callOrder.push('invalidateTokens');
      return { count: 1 };
    });
    userUpdateMock.mockImplementation(async () => {
      callOrder.push('updateUser');
      return UPDATED;
    });

    // 真实 $transaction 的语义：把同一套 delegate 作为 tx 交给回调。
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { update: userUpdateMock },
        emailToken: { updateMany: emailTokenUpdateManyMock },
      })
    );
  });

  const change = () =>
    changePassword('u1', 'OldPassw0rd!', 'NewPassw0rd!', { bcryptRounds: 4 });

  it('改密成功时作废该用户全部未消费邮件令牌', async () => {
    await change();

    expect(emailTokenUpdateManyMock).toHaveBeenCalledTimes(1);
    const where = emailTokenUpdateManyMock.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: 'u1', consumedAt: null });
    // 不限类型：RESET_PASSWORD 和 VERIFY_EMAIL 都要作废
    expect(where.type).toBeUndefined();
  });

  it('作废与改密在同一事务内，且作废排在改密之前', async () => {
    await change();

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['invalidateTokens', 'updateUser']);
  });

  it('仍照常自增 tokenVersion 并返回更新后的用户', async () => {
    const result = await change();

    expect(userUpdateMock.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
    expect(result).toEqual(UPDATED);
  });

  it('当前密码错误时既不改密也不作废令牌', async () => {
    await expect(
      changePassword('u1', 'WrongPassword!', 'NewPassw0rd!', { bcryptRounds: 4 })
    ).rejects.toThrow('Current password is incorrect');

    expect(emailTokenUpdateManyMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });
});
