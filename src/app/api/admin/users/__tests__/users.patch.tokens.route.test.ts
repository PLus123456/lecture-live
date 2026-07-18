import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../tests/utils/http';

/**
 * 管理员代改密码同样要作废该用户未消费的邮件令牌：否则一封没用过的重置链接
 * 就能在 1h 内把管理员刚设的密码改掉。反面同样重要——不涉及密码的编辑
 * （改显示名/角色等）绝不能顺手把用户的验证/重置链接烧掉。
 */

const {
  requireAdminAccessMock,
  userFindUniqueMock,
  userUpdateMock,
  emailTokenUpdateManyMock,
  transactionMock,
  getSiteSettingsMock,
  logActionMock,
  settlePoolOnLimitChangeMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  emailTokenUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  logActionMock: vi.fn(),
  settlePoolOnLimitChangeMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/auth', () => ({ validatePassword: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/userRoles', () => ({
  normalizeUserRole: (r: string) => r,
  resolveRoleQuotas: vi.fn().mockResolvedValue({
    allowedModels: '',
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 5,
  }),
  resolveRoleStorageBytesLimit: vi.fn().mockResolvedValue(1024),
}));
vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: vi.fn(),
  settlePoolOnLimitChange: settlePoolOnLimitChangeMock,
}));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock, update: userUpdateMock },
    emailToken: { updateMany: emailTokenUpdateManyMock },
    siteSetting: { findUnique: vi.fn() },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/email/tokens', () => ({
  invalidateUserEmailTokens: async (
    userId: string,
    options?: { db?: { emailToken: { updateMany: typeof emailTokenUpdateManyMock } } }
  ) => {
    const db = options?.db ?? { emailToken: { updateMany: emailTokenUpdateManyMock } };
    const r = await db.emailToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return r.count;
  },
}));

import { PATCH } from '@/app/api/admin/users/route';

const EXISTING = {
  id: 'u1',
  email: 'user@example.com',
  displayName: '张三',
  role: 'FREE',
  status: 1,
  originalRole: null,
  customGroupId: null,
  purchasedMinutesBalance: 0,
  transcriptionMinutesLimit: 60,
};

describe('PATCH /api/admin/users — 改密作废邮件令牌', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ bcrypt_rounds: 4, password_min_length: 8 });
    userFindUniqueMock.mockResolvedValue(EXISTING);
    userUpdateMock.mockResolvedValue({ ...EXISTING });
    emailTokenUpdateManyMock.mockResolvedValue({ count: 1 });
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { update: userUpdateMock },
        emailToken: { updateMany: emailTokenUpdateManyMock },
      })
    );
  });

  const patch = (body: unknown) =>
    PATCH(
      createJsonRequest('http://localhost/api/admin/users', { method: 'PATCH', body })
    );

  it('设置新密码时作废该用户全部未消费邮件令牌', async () => {
    const res = await patch({ userId: 'u1', password: 'NewPassw0rd!' });

    expect(res.status).toBe(200);
    expect(emailTokenUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(emailTokenUpdateManyMock.mock.calls[0][0].where).toMatchObject({
      userId: 'u1',
      consumedAt: null,
    });
    expect(userUpdateMock.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
  });

  it('不改密码的编辑不得作废令牌', async () => {
    const res = await patch({ userId: 'u1', displayName: '李四' });

    expect(res.status).toBe(200);
    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    expect(emailTokenUpdateManyMock).not.toHaveBeenCalled();
  });

  it('空密码串（前端不改密时常传空）不触发作废', async () => {
    const res = await patch({ userId: 'u1', password: '', displayName: '李四' });

    expect(res.status).toBe(200);
    expect(emailTokenUpdateManyMock).not.toHaveBeenCalled();
  });

  it('作废与更新在同一事务内', async () => {
    await patch({ userId: 'u1', password: 'NewPassw0rd!' });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
