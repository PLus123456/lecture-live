import { beforeEach, describe, expect, it, vi } from 'vitest';

// 会员到期降级回归测试：roleExpiresAt 已过 + originalRole 非空的用户应回落原始角色、
// 清空到期字段、按目标角色同步配额、自增 tokenVersion 踢下线。

const {
  userFindManyMock,
  userUpdateManyMock,
  transactionMock,
  settlePoolOnLimitChangeMock,
} = vi.hoisted(() => ({
  userFindManyMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  settlePoolOnLimitChangeMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findMany: userFindManyMock,
      updateMany: userUpdateManyMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/quota', () => ({
  resetExpiredTranscriptionQuotas: vi.fn(),
  reconcileStorageBytes: vi.fn(),
  settleAsyncReservation: vi.fn(),
  settleFullReservation: vi.fn(),
  settlePoolOnLimitChange: settlePoolOnLimitChangeMock,
}));

vi.mock('@/lib/userRoles', () => ({
  // U46：billingMaintenance 现从 resolveRoleQuotas 读取（原 getDefaultQuotasForRole）。
  // 未配置 group_config_<role> 时该 resolver 回落硬编码默认，等价于旧行为，故此处沿用相同返回值。
  resolveRoleQuotas: async (role: string) =>
    role === 'PRO'
      ? { transcriptionMinutesLimit: 600, storageHoursLimit: 100, allowedModels: 'local,gpt,deepseek' }
      : { transcriptionMinutesLimit: 60, storageHoursLimit: 10, allowedModels: 'local' },
  resolveRoleStorageBytesLimit: async (role: string) =>
    role === 'PRO' ? BigInt(1024) * BigInt(1024 * 1024) : BigInt(100) * BigInt(1024 * 1024),
}));

import { expireRoleDowngrades } from '@/lib/billingMaintenance';

const NOW = new Date('2026-06-01T00:00:00.000Z');

/** 事务替身：把回调跑在同一批 spy 上（tx.user.updateMany 即 userUpdateManyMock）。 */
const txClient = { user: { updateMany: userUpdateManyMock } };

describe('expireRoleDowngrades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userUpdateManyMock.mockResolvedValue({ count: 1 });
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(txClient)
    );
  });

  it('把到期的 PRO（originalRole=FREE）降级回 FREE 并同步配额、自增 tokenVersion', async () => {
    userFindManyMock.mockResolvedValue([
      { id: 'u1', role: 'PRO', originalRole: 'FREE' },
    ]);

    const count = await expireRoleDowngrades(NOW);

    expect(count).toBe(1);
    expect(userUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'u1',
          roleExpiresAt: { lte: NOW },
          originalRole: { not: null },
        }),
        data: expect.objectContaining({
          role: 'FREE',
          originalRole: null,
          roleExpiresAt: null,
          // 到期同时清掉自定义组绑定，避免配额回落系统角色而 customGroupId 仍指向旧组的漂移
          customGroupId: null,
          transcriptionMinutesLimit: 60,
          storageHoursLimit: 10,
          allowedModels: 'local',
          storageBytesLimit: BigInt(100) * BigInt(1024 * 1024),
          tokenVersion: { increment: 1 },
        }),
      })
    );
  });

  it('只扫描 roleExpiresAt<=now 且 originalRole 非空的候选', async () => {
    userFindManyMock.mockResolvedValue([]);

    const count = await expireRoleDowngrades(NOW);

    expect(count).toBe(0);
    expect(userFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          roleExpiresAt: { lte: NOW },
          originalRole: { not: null },
        },
      })
    );
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it('条件原子 update 命中 0 行（被并发续费）时不计入降级数', async () => {
    userFindManyMock.mockResolvedValue([
      { id: 'u2', role: 'PRO', originalRole: 'FREE' },
    ]);
    userUpdateManyMock.mockResolvedValue({ count: 0 });

    const count = await expireRoleDowngrades(NOW);

    expect(count).toBe(0);
  });

  it('originalRole 为 null 的候选被跳过（防御性，不应进 update）', async () => {
    userFindManyMock.mockResolvedValue([
      { id: 'u3', role: 'PRO', originalRole: null },
    ]);

    const count = await expireRoleDowngrades(NOW);

    expect(count).toBe(0);
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });
});

/**
 * P5-3：降级路径把「结算池」与「降级 updateMany」拆成两次独立提交，且 settle 在后、外层只 log。
 * settle 一抛错 → originalRole 已被置 null，候选查询 `originalRole: { not: null }` 此后永远捞不到，
 * 于是下次月度重置用**已降下来的新 limit** 算 owed = used − inflight − newLimit，一次性超额扣池
 *（上限 = oldLimit − newLimit）。必须同事务、结算在前。
 */
describe('expireRoleDowngrades — P5-3 结算与降级的原子性', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks 不清实现：settle 的 mockRejectedValue 会漏到下一条用例，必须显式 reset。
    settlePoolOnLimitChangeMock.mockReset().mockResolvedValue(undefined);
    userUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(txClient)
    );
  });

  it('▶ 持池用户：结算与降级在同一个事务内，且结算在降级之前', async () => {
    userFindManyMock.mockResolvedValue([
      {
        id: 'u1',
        role: 'PRO',
        originalRole: 'FREE',
        transcriptionMinutesLimit: 600,
        purchasedMinutesBalance: 500,
      },
    ]);
    const order: string[] = [];
    let insideTx = false;
    transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      insideTx = true;
      try {
        return await fn(txClient);
      } finally {
        insideTx = false;
      }
    });
    settlePoolOnLimitChangeMock.mockImplementation(async () => {
      order.push(`settle:${insideTx ? 'in-tx' : 'out-of-tx'}`);
    });
    userUpdateManyMock.mockImplementation(async () => {
      order.push(`downgrade:${insideTx ? 'in-tx' : 'out-of-tx'}`);
      return { count: 1 };
    });

    const count = await expireRoleDowngrades(NOW);

    expect(count).toBe(1);
    expect(order).toEqual(['settle:in-tx', 'downgrade:in-tx']);
    // 用**旧**上限 600 结算（新上限 60 会把 owed 算小）
    expect(settlePoolOnLimitChangeMock).toHaveBeenCalledWith('u1', 600, 60, txClient);
  });

  it('▶ 结算抛错：整笔回滚且不计入降级数（用户下轮仍可被捞到，不会永久卡死）', async () => {
    userFindManyMock.mockResolvedValue([
      {
        id: 'u1',
        role: 'PRO',
        originalRole: 'FREE',
        transcriptionMinutesLimit: 600,
        purchasedMinutesBalance: 500,
      },
    ]);
    settlePoolOnLimitChangeMock.mockRejectedValue(new Error('settle boom'));

    await expect(expireRoleDowngrades(NOW)).rejects.toThrow('settle boom');
    // 关键：降级写没有先于结算独立提交 —— 旧实现里它已经提交了，用户从此再也捞不回来
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it('降级条件在事务内不再成立（admin 抢先续费）→ 抛 SkipDowngrade 回滚，不计数也不报错', async () => {
    userFindManyMock.mockResolvedValue([
      {
        id: 'u1',
        role: 'PRO',
        originalRole: 'FREE',
        transcriptionMinutesLimit: 600,
        purchasedMinutesBalance: 500,
      },
    ]);
    userUpdateManyMock.mockResolvedValue({ count: 0 });

    const count = await expireRoleDowngrades(NOW);

    expect(count).toBe(0);
  });

  it('无池用户：不调结算，降级照旧', async () => {
    userFindManyMock.mockResolvedValue([
      {
        id: 'u2',
        role: 'PRO',
        originalRole: 'FREE',
        transcriptionMinutesLimit: 600,
        purchasedMinutesBalance: 0,
      },
    ]);

    const count = await expireRoleDowngrades(NOW);

    expect(count).toBe(1);
    expect(settlePoolOnLimitChangeMock).not.toHaveBeenCalled();
  });
});
