import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../tests/utils/http';

/**
 * P5-2：admin「一键重置本月已用转录时长」。
 * 裸把 transcriptionMinutesUsed 清零有两个后果：
 *  ① 对账仍按本周期全部 COMPLETED session 重算 expected → 该用户每轮都被虚报正向 drift，
 *    管理员一点「修复」就把刚清掉的用量原样写回，重置白做（而且喂给了 P5-1 那个按钮）；
 *  ② 持池用户本周期已动用的池分钟被一并抹掉 → 池子永久免费。
 * 故清零必须同写 transcriptionUsageReconcileFrom，并对持池用户先按旧上限结算池子。
 */

const {
  requireAdminAccessMock,
  userFindUniqueMock,
  userUpdateMock,
  transactionMock,
  getSiteSettingsMock,
  logActionMock,
  settlePoolOnLimitChangeMock,
  settlePoolOnUsageResetMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  transactionMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  logActionMock: vi.fn(),
  settlePoolOnLimitChangeMock: vi.fn(),
  settlePoolOnUsageResetMock: vi.fn(),
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
  settlePoolOnUsageReset: settlePoolOnUsageResetMock,
}));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: vi.fn(),
}));
vi.mock('@/lib/email/tokens', () => ({
  invalidateUserEmailTokens: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock, update: userUpdateMock },
    emailToken: { updateMany: vi.fn() },
    siteSetting: { findUnique: vi.fn() },
    $transaction: transactionMock,
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
  transcriptionMinutesUsed: 240,
};

const patch = (body: unknown) =>
  PATCH(createJsonRequest('http://localhost/api/admin/users', { method: 'PATCH', body }));

describe('PATCH /api/admin/users — resetTranscriptionUsage（P5-2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin1', email: 'admin@x.com', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ bcrypt_rounds: 4, password_min_length: 8 });
    userFindUniqueMock.mockResolvedValue(EXISTING);
    userUpdateMock.mockResolvedValue({ ...EXISTING });
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { update: userUpdateMock } })
    );
  });

  it('▶ 清零 used 的同时写入 transcriptionUsageReconcileFrom（截断对账窗口）', async () => {
    const res = await patch({ userId: 'u1', resetTranscriptionUsage: true });

    expect(res.status).toBe(200);
    const data = userUpdateMock.mock.calls[0][0].data;
    expect(data.transcriptionMinutesUsed).toBe(0);
    expect(data.transcriptionUsageReconcileFrom).toBeInstanceOf(Date);
  });

  it('不重置用量的普通编辑不得写 transcriptionUsageReconcileFrom', async () => {
    const res = await patch({ userId: 'u1', displayName: '李四' });

    expect(res.status).toBe(200);
    const data = userUpdateMock.mock.calls[0][0].data;
    expect(data.transcriptionUsageReconcileFrom).toBeUndefined();
    expect(settlePoolOnUsageResetMock).not.toHaveBeenCalled();
  });

  it('▶ 持池用户：先按旧上限结算池子，再清零（否则本周期已动用的池分钟永久免费）', async () => {
    userFindUniqueMock.mockResolvedValue({
      ...EXISTING,
      purchasedMinutesBalance: 500,
    });

    const res = await patch({ userId: 'u1', resetTranscriptionUsage: true });

    expect(res.status).toBe(200);
    expect(settlePoolOnUsageResetMock).toHaveBeenCalledWith('u1', 60);
    // 结算必须发生在写库之前（失败则整个 PATCH 500，状态一致）
    expect(
      settlePoolOnUsageResetMock.mock.invocationCallOrder[0]
    ).toBeLessThan(userUpdateMock.mock.invocationCallOrder[0]);
  });

  it('无池用户不触发池结算（owed 恒 0，省一次事务）', async () => {
    const res = await patch({ userId: 'u1', resetTranscriptionUsage: true });

    expect(res.status).toBe(200);
    expect(settlePoolOnUsageResetMock).not.toHaveBeenCalled();
  });

  it('同时下调上限 + 重置用量：两次结算都按旧上限 60（不用本次写入的新上限）', async () => {
    userFindUniqueMock.mockResolvedValue({
      ...EXISTING,
      purchasedMinutesBalance: 500,
    });

    const res = await patch({
      userId: 'u1',
      resetTranscriptionUsage: true,
      transcriptionMinutesLimit: 10,
    });

    expect(res.status).toBe(200);
    expect(settlePoolOnLimitChangeMock).toHaveBeenCalledWith('u1', 60, 10);
    expect(settlePoolOnUsageResetMock).toHaveBeenCalledWith('u1', 60);
  });
});
