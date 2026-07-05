import { beforeEach, describe, expect, it, vi } from 'vitest';

// 会员到期降级回归测试：roleExpiresAt 已过 + originalRole 非空的用户应回落原始角色、
// 清空到期字段、按目标角色同步配额、自增 tokenVersion 踢下线。

const { userFindManyMock, userUpdateManyMock } = vi.hoisted(() => ({
  userFindManyMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findMany: userFindManyMock,
      updateMany: userUpdateManyMock,
    },
  },
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

describe('expireRoleDowngrades', () => {
  beforeEach(() => {
    userUpdateManyMock.mockResolvedValue({ count: 1 });
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
