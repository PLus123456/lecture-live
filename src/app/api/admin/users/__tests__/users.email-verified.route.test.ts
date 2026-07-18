import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../tests/utils/http';

/**
 * #17：管理员建号不写 emailVerifiedAt → email_verification 开着时这些账号一律 403 登不上，
 * 而 admin 侧连这个字段都查不到，谁都诊断不出来。
 */

const {
  requireAdminAccessMock,
  userFindUniqueMock,
  userCreateMock,
  userUpdateMock,
  emailTokenUpdateManyMock,
  transactionMock,
  getSiteSettingsMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userCreateMock: vi.fn(),
  userUpdateMock: vi.fn(),
  emailTokenUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/auth', () => ({ validatePassword: vi.fn().mockReturnValue(null) }));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hashed' } }));
vi.mock('@/lib/userRoles', () => ({
  normalizeUserRole: (r: string, fallback: string) => r ?? fallback,
  resolveRoleQuotas: vi.fn().mockResolvedValue({
    allowedModels: '',
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 5,
  }),
  resolveRoleStorageBytesLimit: vi.fn().mockResolvedValue(1024),
}));
vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: vi.fn(),
  settlePoolOnLimitChange: vi.fn(),
}));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: vi.fn(),
}));
vi.mock('@/lib/email/tokens', () => ({
  invalidateUserEmailTokens: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
      create: userCreateMock,
      update: userUpdateMock,
    },
    emailToken: { updateMany: emailTokenUpdateManyMock },
    siteSetting: { findUnique: vi.fn() },
    $transaction: transactionMock,
  },
}));

import { POST, PATCH } from '@/app/api/admin/users/route';

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
  emailVerifiedAt: null,
};

describe('admin 用户接口 — 邮箱验证状态（#17）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ bcrypt_rounds: 4, password_min_length: 8 });
    userFindUniqueMock.mockResolvedValue(null);
    userCreateMock.mockResolvedValue({ id: 'new1' });
    userUpdateMock.mockResolvedValue({ ...EXISTING });
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { update: userUpdateMock },
        emailToken: { updateMany: emailTokenUpdateManyMock },
      })
    );
  });

  const post = (body: unknown) =>
    POST(createJsonRequest('http://localhost/api/admin/users', { method: 'POST', body }));
  const patch = (body: unknown) =>
    PATCH(
      createJsonRequest('http://localhost/api/admin/users', { method: 'PATCH', body })
    );

  it('管理员建号即视为已验证（否则门禁开着时一律登不上）', async () => {
    const res = await post({
      email: 'new@example.com',
      displayName: '新用户',
      password: 'passw0rd',
      role: 'FREE',
    });

    expect(res.status).toBe(201);
    expect(userCreateMock.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  // 用户报「登不上」时，后台必须能看出是不是卡在未验证。
  it('用户列表返回 emailVerifiedAt 供诊断', async () => {
    await post({
      email: 'new@example.com',
      displayName: '新用户',
      password: 'passw0rd',
    });
    expect(userCreateMock.mock.calls[0][0].select.emailVerifiedAt).toBe(true);
  });

  it('markEmailVerified 可人工标记未验证用户（存量补救入口）', async () => {
    userFindUniqueMock.mockResolvedValue({ ...EXISTING, emailVerifiedAt: null });

    await patch({ userId: 'u1', markEmailVerified: true });

    const data = userUpdateMock.mock.calls[0][0].data;
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  // 每次保存都刷新时间戳会把「什么时候验证的」这条线索抹掉。
  // 与改名一起提交，确保 update 真的发生（只传本字段时全无改动，路由会 400）。
  it('已验证用户再次标记不刷新时间戳', async () => {
    const verifiedAt = new Date('2026-01-01T00:00:00.000Z');
    userFindUniqueMock.mockResolvedValue({ ...EXISTING, emailVerifiedAt: verifiedAt });

    await patch({ userId: 'u1', markEmailVerified: true, displayName: '改个名' });

    const data = userUpdateMock.mock.calls[0][0].data;
    expect(data.displayName).toBe('改个名');
    expect(data.emailVerifiedAt).toBeUndefined();
  });

  it('markEmailVerified=false 可撤销验证状态', async () => {
    userFindUniqueMock.mockResolvedValue({
      ...EXISTING,
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await patch({ userId: 'u1', markEmailVerified: false });

    expect(userUpdateMock.mock.calls[0][0].data.emailVerifiedAt).toBeNull();
  });

  // 不传该字段的普通编辑绝不能顺手改动验证状态。
  it('未传 markEmailVerified 时不碰该字段', async () => {
    userFindUniqueMock.mockResolvedValue({ ...EXISTING, emailVerifiedAt: null });

    await patch({ userId: 'u1', displayName: '改个名' });

    expect(userUpdateMock.mock.calls[0][0].data.emailVerifiedAt).toBeUndefined();
  });
});
