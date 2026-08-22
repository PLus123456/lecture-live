import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  rootUserGroupByMock,
  rootSiteSettingFindManyMock,
  rootSiteSettingFindUniqueMock,
  txSiteSettingFindUniqueMock,
  txSiteSettingUpsertMock,
  txUserFindManyMock,
  txUserUpdateManyMock,
  transactionMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
  resolveRoleQuotasMock,
  settlePoolOnLimitChangeMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  rootUserGroupByMock: vi.fn(),
  rootSiteSettingFindManyMock: vi.fn(),
  rootSiteSettingFindUniqueMock: vi.fn(),
  txSiteSettingFindUniqueMock: vi.fn(),
  txSiteSettingUpsertMock: vi.fn(),
  txUserFindManyMock: vi.fn(),
  txUserUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
  resolveRoleQuotasMock: vi.fn(),
  settlePoolOnLimitChangeMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
}));

vi.mock('@/lib/quota', () => ({
  settlePoolOnLimitChange: settlePoolOnLimitChangeMock,
}));

vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: resolveRoleQuotasMock,
  coerceThinkingDepthCap: (value: unknown, fallback: string) =>
    value === 'off' || value === 'low' || value === 'medium' || value === 'high'
      ? value
      : fallback,
  coerceSummaryModelId: (value: unknown) =>
    typeof value === 'string' ? value.trim() : '',
}));

const txClient = {
  siteSetting: {
    findUnique: txSiteSettingFindUniqueMock,
    upsert: txSiteSettingUpsertMock,
  },
  user: {
    findMany: txUserFindManyMock,
    updateMany: txUserUpdateManyMock,
  },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      groupBy: rootUserGroupByMock,
    },
    siteSetting: {
      findMany: rootSiteSettingFindManyMock,
      findUnique: rootSiteSettingFindUniqueMock,
    },
    $transaction: transactionMock,
  },
}));

import { DELETE, GET, POST, PUT } from '@/app/api/admin/groups/route';

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  displayName: 'Admin',
};

const permissions = {
  transcriptionMinutesLimit: 120,
  storageHoursLimit: 20,
  allowedModels: 'local,gpt-4o-mini',
  maxConcurrentSessions: 2,
  maxThinkingDepth: 'medium',
  allowRealtimeSummary: true,
  allowFinalSummary: true,
  allowAudioEnhance: false,
  allowTextTranslation: true,
  allowDocTranslation: false,
  realtimeSummaryModelId: '',
  finalSummaryModelId: '',
  chatModelId: '',
  translationModelId: '',
};

const existingCustomGroup = {
  id: 'custom_group_1',
  name: 'Researchers',
  description: 'Research team',
  color: 'blue',
  permissions: { ...permissions, transcriptionMinutesLimit: 90 },
};

function jsonRequest(method: 'POST' | 'PUT', body: unknown): Request {
  return new Request('http://localhost:3000/api/admin/groups', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireAdminAccessMock.mockReset().mockResolvedValue({
    user: adminUser,
    response: null,
  });
  rootUserGroupByMock.mockReset().mockResolvedValue([]);
  rootSiteSettingFindManyMock.mockReset().mockResolvedValue([]);
  rootSiteSettingFindUniqueMock.mockReset().mockResolvedValue(null);
  txSiteSettingFindUniqueMock.mockReset().mockResolvedValue(null);
  txSiteSettingUpsertMock.mockReset().mockResolvedValue({});
  txUserFindManyMock.mockReset().mockResolvedValue([]);
  txUserUpdateManyMock.mockReset().mockResolvedValue({ count: 0 });
  transactionMock.mockReset().mockImplementation(
    async (callback: (tx: typeof txClient) => Promise<unknown>) => callback(txClient)
  );
  writeSecurityAuditMock.mockReset().mockResolvedValue({
    requestId: 'server-request-id',
    action: 'admin.security.groups.test',
  });
  getSecurityAuditRequestIdMock.mockReset().mockReturnValue('server-request-id');
  resolveRoleQuotasMock.mockReset().mockResolvedValue({
    allowedModels: 'local',
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 10,
  });
  settlePoolOnLimitChangeMock.mockReset().mockResolvedValue(undefined);
});

/**
 * A tiny transaction model used to prove that throwing from required audit restores the
 * SiteSetting value instead of committing the preceding group mutation.
 */
function installStatefulCustomGroupsTransaction(initialGroups: unknown[]) {
  let persisted = JSON.stringify(initialGroups);
  let lastTx: typeof txClient | null = null;

  transactionMock.mockImplementationOnce(
    async (callback: (tx: typeof txClient) => Promise<unknown>) => {
      const snapshot = persisted;
      const statefulTx = {
        siteSetting: {
          findUnique: vi.fn(async () => ({ key: 'custom_groups', value: persisted })),
          upsert: vi.fn(async (args: { update: { value: string } }) => {
            persisted = args.update.value;
            return {};
          }),
        },
        user: {
          findMany: vi.fn(async () => []),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      };
      lastTx = statefulTx;
      try {
        return await callback(statefulTx);
      } catch (error) {
        persisted = snapshot;
        throw error;
      }
    }
  );

  return {
    groups: () => JSON.parse(persisted) as unknown[],
    tx: () => lastTx,
  };
}

describe('GET /api/admin/groups security audit', () => {
  it('成功读取后同步写结构化安全审计', async () => {
    rootUserGroupByMock
      .mockResolvedValueOnce([{ role: 'FREE', _count: { id: 2 } }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request('http://localhost:3000/api/admin/groups'));

    expect(res.status).toBe(200);
    const body = await readJson<{ groups: unknown[] }>(res);
    expect(body.groups).toHaveLength(3);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'groups.read',
        operator: expect.objectContaining({ id: 'admin-1' }),
        target: { type: 'user_group_collection' },
        before: null,
        after: expect.objectContaining({ resultCount: 3 }),
        reason: 'admin_list',
        outcome: 'SUCCESS',
        requestId: 'server-request-id',
      })
    );
  });

  it('读取审计失败时返回 500，不返回敏感组配置', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await GET(new Request('http://localhost:3000/api/admin/groups'));

    expect(res.status).toBe(500);
  });
});

describe('group mutations require an in-transaction SUCCESS audit', () => {
  it('POST 创建与 SUCCESS 审计使用同一事务客户端', async () => {
    const res = await POST(
      jsonRequest('POST', { name: 'Researchers', permissions })
    );

    expect(res.status).toBe(201);
    expect(txSiteSettingUpsertMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'groups.create',
        target: expect.objectContaining({ type: 'user_group' }),
        before: null,
        after: expect.objectContaining({ name: 'Researchers' }),
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('POST 审计失败时创建回滚并返回 500', async () => {
    const state = installStatefulCustomGroupsTransaction([]);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await POST(
      jsonRequest('POST', { name: 'Researchers', permissions })
    );

    expect(res.status).toBe(500);
    expect(state.groups()).toEqual([]);
    expect(writeSecurityAuditMock.mock.calls[0]?.[2]).toBe(state.tx());
  });

  it('PUT 系统组记录准确 before/after 与受影响用户数', async () => {
    txSiteSettingFindUniqueMock.mockResolvedValue({
      key: 'group_config_FREE',
      value: JSON.stringify({ ...permissions, transcriptionMinutesLimit: 60 }),
    });
    txUserUpdateManyMock.mockResolvedValue({ count: 2 });

    const res = await PUT(
      jsonRequest('PUT', { groupId: 'FREE', permissions })
    );

    expect(res.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'groups.update',
        target: { type: 'user_group', id: 'FREE' },
        before: {
          permissions: expect.objectContaining({ transcriptionMinutesLimit: 60 }),
        },
        after: {
          permissions: expect.objectContaining({ transcriptionMinutesLimit: 120 }),
        },
        metadata: { systemGroup: true, affectedUsers: 2 },
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('PUT 自定义组审计失败时配置更新回滚并返回 500', async () => {
    const state = installStatefulCustomGroupsTransaction([existingCustomGroup]);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await PUT(
      jsonRequest('PUT', {
        groupId: existingCustomGroup.id,
        name: 'Renamed',
        permissions,
      })
    );

    expect(res.status).toBe(500);
    expect(state.groups()).toEqual([existingCustomGroup]);
    expect(writeSecurityAuditMock.mock.calls[0]?.[1]).toMatchObject({
      event: 'groups.update',
      before: { name: 'Researchers' },
      after: { name: 'Renamed' },
      outcome: 'SUCCESS',
    });
  });

  it('DELETE 成功时删除与 SUCCESS 审计共用事务', async () => {
    txSiteSettingFindUniqueMock.mockResolvedValue({
      key: 'custom_groups',
      value: JSON.stringify([existingCustomGroup]),
    });

    const res = await DELETE(
      new Request(
        `http://localhost:3000/api/admin/groups?groupId=${existingCustomGroup.id}`,
        { method: 'DELETE' }
      )
    );

    expect(res.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'groups.delete',
        target: { type: 'user_group', id: existingCustomGroup.id },
        before: expect.objectContaining({ name: 'Researchers' }),
        after: null,
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('DELETE 审计失败时删除回滚并返回 500', async () => {
    const state = installStatefulCustomGroupsTransaction([existingCustomGroup]);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await DELETE(
      new Request(
        `http://localhost:3000/api/admin/groups?groupId=${existingCustomGroup.id}`,
        { method: 'DELETE' }
      )
    );

    expect(res.status).toBe(500);
    expect(state.groups()).toEqual([existingCustomGroup]);
  });
});
