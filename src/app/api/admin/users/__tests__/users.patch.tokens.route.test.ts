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
vi.mock('@/lib/securityAudit', () => ({
  getSecurityAuditRequestId: vi.fn(() => 'audit-request-id'),
  writeSecurityAudit: vi.fn().mockResolvedValue({
    requestId: 'audit-request-id',
    action: 'admin.security.users.test',
  }),
}));
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

/**
 * 换绑邮箱：令牌绑的是 userId 而不是地址。只改 email 不作废令牌的话，旧地址收到的验证链接
 * （verify-email 消费后直接签发会话）与重置链接仍然有效——旧邮箱的持有者照样能登录/改密。
 * 新地址也从未被证明可达，emailVerifiedAt 不能沿用旧地址的验证状态。
 */
describe('PATCH /api/admin/users — 换绑邮箱作废邮件令牌并清空验证状态', () => {
  const VERIFIED_AT = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ bcrypt_rounds: 4, password_min_length: 8 });
    // 第一次 findUnique 取 existing；之后的唯一性检查查不到占用者
    userFindUniqueMock.mockReset();
    userFindUniqueMock
      .mockResolvedValueOnce({ ...EXISTING, emailVerifiedAt: VERIFIED_AT })
      .mockResolvedValue(null);
    userUpdateMock.mockResolvedValue({ ...EXISTING, email: 'new@example.com' });
    emailTokenUpdateManyMock.mockResolvedValue({ count: 2 });
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

  it('换绑邮箱时在同一事务内作废全部未消费邮件令牌，并清空 emailVerifiedAt', async () => {
    const res = await patch({ userId: 'u1', email: 'new@example.com' });

    expect(res.status).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(emailTokenUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(emailTokenUpdateManyMock.mock.calls[0][0].where).toMatchObject({
      userId: 'u1',
      consumedAt: null,
    });
    const data = userUpdateMock.mock.calls[0][0].data;
    expect(data.email).toBe('new@example.com');
    expect(data.emailVerifiedAt).toBeNull();
    // 换绑本身不吊销会话（只有改密/封禁才 tokenVersion++）
    expect(data.tokenVersion).toBeUndefined();
  });

  it('换绑同时显式 markEmailVerified=true：以新地址重新记验证时刻', async () => {
    const res = await patch({
      userId: 'u1',
      email: 'new@example.com',
      markEmailVerified: true,
    });

    expect(res.status).toBe(200);
    const data = userUpdateMock.mock.calls[0][0].data;
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    expect((data.emailVerifiedAt as Date).getTime()).toBeGreaterThan(VERIFIED_AT.getTime());
    expect(emailTokenUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it('email 与现值相同视为未换绑：不作废令牌、不碰验证状态', async () => {
    const res = await patch({ userId: 'u1', email: EXISTING.email, displayName: '李四' });

    expect(res.status).toBe(200);
    expect(emailTokenUpdateManyMock).not.toHaveBeenCalled();
    expect(userUpdateMock.mock.calls[0][0].data).not.toHaveProperty('emailVerifiedAt');
  });
});
