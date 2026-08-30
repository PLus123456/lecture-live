import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
  logActionMock,
  getSiteSettingsMock,
  userFindManyMock,
  userFindUniqueMock,
  userCreateMock,
  userUpdateMock,
  userDeleteManyMock,
  sessionFindManyMock,
  sessionGroupByMock,
  sessionDeleteManyMock,
  folderFindManyMock,
  folderDeleteManyMock,
  folderSessionDeleteManyMock,
  folderKeywordDeleteManyMock,
  conversationFindManyMock,
  translationTaskFindManyMock,
  conversationDeleteManyMock,
  conversationMessageDeleteManyMock,
  conversationSessionDeleteManyMock,
  chatAttachmentFindManyMock,
  chatAttachmentDeleteManyMock,
  shareLinkDeleteManyMock,
  jobQueueUpdateManyMock,
  jobQueueDeleteManyMock,
  siteSettingFindUniqueMock,
  transactionMock,
  deleteCloudreveAttachmentFilesMock,
  releaseStorageBytesMock,
  settlePoolOnLimitChangeMock,
  settlePoolOnUsageResetMock,
  invalidateUserEmailTokensMock,
  trackJobMock,
  deleteTaskFilesMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
  logActionMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  userFindManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userCreateMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userDeleteManyMock: vi.fn(),
  sessionFindManyMock: vi.fn(),
  sessionGroupByMock: vi.fn(),
  sessionDeleteManyMock: vi.fn(),
  folderFindManyMock: vi.fn(),
  folderDeleteManyMock: vi.fn(),
  folderSessionDeleteManyMock: vi.fn(),
  folderKeywordDeleteManyMock: vi.fn(),
  conversationFindManyMock: vi.fn(),
  translationTaskFindManyMock: vi.fn(),
  conversationDeleteManyMock: vi.fn(),
  conversationMessageDeleteManyMock: vi.fn(),
  conversationSessionDeleteManyMock: vi.fn(),
  chatAttachmentFindManyMock: vi.fn(),
  chatAttachmentDeleteManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  jobQueueUpdateManyMock: vi.fn(),
  jobQueueDeleteManyMock: vi.fn(),
  siteSettingFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  deleteCloudreveAttachmentFilesMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  settlePoolOnLimitChangeMock: vi.fn(),
  settlePoolOnUsageResetMock: vi.fn(),
  invalidateUserEmailTokensMock: vi.fn(),
  trackJobMock: vi.fn(),
  deleteTaskFilesMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/securityAudit', () => ({
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
  writeSecurityAudit: writeSecurityAuditMock,
}));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/auth', () => ({ validatePassword: vi.fn().mockReturnValue(null) }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('SENSITIVE_PASSWORD_HASH') },
}));
vi.mock('@/lib/userRoles', () => ({
  normalizeUserRole: (role: string | undefined, fallback: string) => role ?? fallback,
  resolveRoleQuotas: vi.fn().mockResolvedValue({
    allowedModels: '',
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 5,
  }),
  resolveRoleStorageBytesLimit: vi.fn().mockResolvedValue(1024),
}));
vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: releaseStorageBytesMock,
  settlePoolOnLimitChange: settlePoolOnLimitChangeMock,
  settlePoolOnUsageReset: settlePoolOnUsageResetMock,
}));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  deleteCloudreveAttachmentFiles: deleteCloudreveAttachmentFilesMock,
}));
vi.mock('@/lib/email/tokens', () => ({
  invalidateUserEmailTokens: invalidateUserEmailTokensMock,
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  deleteTaskFiles: deleteTaskFilesMock,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_STATUS: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  JOB_TYPE: { ADMIN_MUTATION: 'admin_mutation' },
  trackJob: trackJobMock,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findMany: userFindManyMock,
      findUnique: userFindUniqueMock,
      create: userCreateMock,
      update: userUpdateMock,
      deleteMany: userDeleteManyMock,
    },
    session: {
      findMany: sessionFindManyMock,
      groupBy: sessionGroupByMock,
      deleteMany: sessionDeleteManyMock,
    },
    folder: { findMany: folderFindManyMock, deleteMany: folderDeleteManyMock },
    folderSession: { deleteMany: folderSessionDeleteManyMock },
    folderKeyword: { deleteMany: folderKeywordDeleteManyMock },
    conversation: {
      findMany: conversationFindManyMock,
      deleteMany: conversationDeleteManyMock,
    },
    translationTask: { findMany: translationTaskFindManyMock },
    conversationMessage: { deleteMany: conversationMessageDeleteManyMock },
    conversationSession: { deleteMany: conversationSessionDeleteManyMock },
    chatAttachment: {
      findMany: chatAttachmentFindManyMock,
      deleteMany: chatAttachmentDeleteManyMock,
    },
    shareLink: { deleteMany: shareLinkDeleteManyMock },
    jobQueue: {
      updateMany: jobQueueUpdateManyMock,
      deleteMany: jobQueueDeleteManyMock,
    },
    siteSetting: { findUnique: siteSettingFindUniqueMock },
    $transaction: transactionMock,
  },
}));

import { DELETE, GET, PATCH, POST } from '@/app/api/admin/users/route';

const ADMIN = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };
const SAFE_USER = {
  id: 'user-1',
  email: 'user@example.com',
  displayName: '张三',
  role: 'FREE',
  status: 1,
  points: 7,
  originalRole: null,
  roleExpiresAt: null,
  avatarPath: null,
  createdAt: new Date('2026-08-20T00:00:00.000Z'),
  emailVerifiedAt: new Date('2026-08-20T00:00:00.000Z'),
  transcriptionMinutesUsed: 2,
  transcriptionMinutesLimit: 60,
  storageHoursUsed: 0,
  storageHoursLimit: 5,
  allowedModels: '',
  customGroupId: null,
  purchasedMinutesBalance: 0,
};

let transactionCommitted = false;
function createTxClient() {
  return {
    user: {
      create: userCreateMock,
      update: userUpdateMock,
      deleteMany: userDeleteManyMock,
    },
    emailToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-row' }) },
    shareLink: { deleteMany: shareLinkDeleteManyMock },
    chatAttachment: { deleteMany: chatAttachmentDeleteManyMock },
    conversationMessage: { deleteMany: conversationMessageDeleteManyMock },
    conversationSession: { deleteMany: conversationSessionDeleteManyMock },
    conversation: { deleteMany: conversationDeleteManyMock },
    folderSession: { deleteMany: folderSessionDeleteManyMock },
    folderKeyword: { deleteMany: folderKeywordDeleteManyMock },
    folder: { deleteMany: folderDeleteManyMock },
    session: { deleteMany: sessionDeleteManyMock },
    jobQueue: {
      updateMany: jobQueueUpdateManyMock,
      deleteMany: jobQueueDeleteManyMock,
    },
  };
}

let txClient: ReturnType<typeof createTxClient>;

function auditEvents() {
  return writeSecurityAuditMock.mock.calls.map((call) => call[1]);
}

function setupDeleteUser(attachments: unknown[] = []) {
  userFindManyMock
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([SAFE_USER]);
  chatAttachmentFindManyMock.mockResolvedValueOnce(attachments);
}

describe('admin users required security audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionCommitted = false;
    txClient = createTxClient();

    requireAdminAccessMock.mockResolvedValue({ user: ADMIN, response: null });
    getSecurityAuditRequestIdMock.mockReturnValue('security-request-1');
    writeSecurityAuditMock.mockResolvedValue({
      requestId: 'security-request-1',
      action: 'admin.security.users.test',
    });
    getSiteSettingsMock.mockResolvedValue({ bcrypt_rounds: 4, password_min_length: 8 });
    userFindManyMock.mockResolvedValue([SAFE_USER]);
    userFindUniqueMock.mockResolvedValue(SAFE_USER);
    userCreateMock.mockResolvedValue({ ...SAFE_USER, id: 'new-user' });
    userUpdateMock.mockResolvedValue({ ...SAFE_USER, displayName: '李四' });
    sessionFindManyMock.mockResolvedValue([]);
    sessionGroupByMock.mockResolvedValue([]);
    folderFindManyMock.mockResolvedValue([]);
    conversationFindManyMock.mockResolvedValue([]);
    translationTaskFindManyMock.mockResolvedValue([]);
    chatAttachmentFindManyMock.mockResolvedValue([]);
    siteSettingFindUniqueMock.mockResolvedValue(null);
    deleteCloudreveAttachmentFilesMock.mockResolvedValue(true);
    releaseStorageBytesMock.mockResolvedValue(undefined);
    settlePoolOnLimitChangeMock.mockResolvedValue(undefined);
    settlePoolOnUsageResetMock.mockResolvedValue(undefined);
    invalidateUserEmailTokensMock.mockResolvedValue(0);
    deleteTaskFilesMock.mockResolvedValue(undefined);
    trackJobMock.mockImplementation(
      async (
        options: {
          terminalMutation?: (
            tx: typeof txClient,
            terminal:
              | { status: 'SUCCESS'; result: unknown }
              | { status: 'FAILED'; error: unknown }
          ) => Promise<void>;
        },
        operation: () => Promise<unknown>
      ) => {
        let result: unknown;
        try {
          result = await operation();
        } catch (error) {
          try {
            await transactionMock((tx: typeof txClient) =>
              options.terminalMutation?.(tx, { status: 'FAILED', error })
            );
          } catch (journalError) {
            throw new AggregateError([error, journalError]);
          }
          throw error;
        }
        await transactionMock((tx: typeof txClient) =>
          options.terminalMutation?.(tx, { status: 'SUCCESS', result })
        );
        return result;
      }
    );

    for (const mock of [
      shareLinkDeleteManyMock,
      chatAttachmentDeleteManyMock,
      conversationMessageDeleteManyMock,
      conversationSessionDeleteManyMock,
      conversationDeleteManyMock,
      folderSessionDeleteManyMock,
      folderKeywordDeleteManyMock,
      folderDeleteManyMock,
      sessionDeleteManyMock,
      jobQueueUpdateManyMock,
      jobQueueDeleteManyMock,
    ]) {
      mock.mockResolvedValue({ count: 0 });
    }
    userDeleteManyMock.mockResolvedValue({ count: 1 });

    transactionMock.mockImplementation(async (input: unknown) => {
      if (typeof input === 'function') {
        const result = await (input as (tx: typeof txClient) => Promise<unknown>)(
          txClient
        );
        transactionCommitted = true;
        return result;
      }
      const result = await Promise.all(input as Promise<unknown>[]);
      transactionCommitted = true;
      return result;
    });
  });

  it('GET audits the assembled collection before returning it', async () => {
    const response = await GET(
      createJsonRequest(
        'http://localhost/api/admin/users?filter=user%40example.com&group=FREE'
      )
    );

    expect(response.status).toBe(200);
    expect(await readJson<{ users: unknown[] }>(response)).toMatchObject({
      users: [{ id: 'user-1' }],
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledTimes(1);
    expect(auditEvents()[0]).toMatchObject({
      event: 'users.read',
      target: { type: 'user_collection' },
      reason: 'admin_list',
      outcome: 'SUCCESS',
      metadata: {
        filterApplied: true,
        groupApplied: true,
        roleFilter: 'FREE',
        customGroupFilterApplied: false,
        count: 1,
      },
    });
    expect(JSON.stringify(auditEvents()[0])).not.toContain('user@example.com');
  });

  it('GET returns 503 and never releases the user list when audit persistence fails', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit database unavailable'));

    const response = await GET(createJsonRequest('http://localhost/api/admin/users'));
    const body = await readJson<Record<string, unknown>>(response);

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: '审计服务暂不可用，请稍后重试' });
    expect(body).not.toHaveProperty('users');
  });

  it('POST writes create and SUCCESS audit in the same transaction with a safe snapshot', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const response = await POST(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'POST',
        body: {
          email: 'new@example.com',
          displayName: '新用户',
          password: 'SuperSecret9!',
          role: 'FREE',
        },
      })
    );

    expect(response.status).toBe(201);
    expect(transactionCommitted).toBe(true);
    expect(writeSecurityAuditMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock.mock.calls[0][2]).toBe(txClient);
    expect(auditEvents()[0]).toMatchObject({
      event: 'users.create',
      before: null,
      reason: 'admin_create',
      outcome: 'SUCCESS',
      target: { type: 'user', id: 'new-user' },
    });
    const serialized = JSON.stringify(auditEvents()[0]);
    expect(serialized).not.toContain('SuperSecret9!');
    expect(serialized).not.toContain('SENSITIVE_PASSWORD_HASH');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenVersion');
  });

  it('POST audit failure aborts the transaction, returns 503, and skips legacy success logging', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit insert failed'));

    const response = await POST(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'POST',
        body: {
          email: 'new@example.com',
          displayName: '新用户',
          password: 'SuperSecret9!',
          role: 'FREE',
        },
      })
    );

    expect(response.status).toBe(503);
    expect(transactionCommitted).toBe(false);
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('PATCH records ATTEMPTED before mutation and SUCCESS inside its transaction without credentials', async () => {
    const response = await PATCH(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'PATCH',
        body: {
          userId: 'user-1',
          displayName: '李四',
          password: 'SuperSecret9!',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
    ]);
    expect(writeSecurityAuditMock.mock.calls[0][2]).toBeUndefined();
    expect(writeSecurityAuditMock.mock.calls[1][2]).toBe(txClient);
    expect(writeSecurityAuditMock.mock.invocationCallOrder[0]).toBeLessThan(
      userUpdateMock.mock.invocationCallOrder[0]
    );
    expect(auditEvents()[1]).toMatchObject({
      before: { id: 'user-1', email: 'user@example.com' },
      after: { id: 'user-1', passwordChanged: true },
      metadata: {
        changedFields: expect.arrayContaining(['displayName', 'passwordChanged']),
        passwordChanged: true,
      },
      reason: 'admin_update',
    });
    const serialized = JSON.stringify(auditEvents());
    expect(serialized).not.toContain('SuperSecret9!');
    expect(serialized).not.toContain('SENSITIVE_PASSWORD_HASH');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenVersion');
    const legacyDetail = logActionMock.mock.calls[0][2].detail as string;
    expect(legacyDetail).toContain('passwordChanged');
    expect(legacyDetail).not.toContain('passwordHash');
    expect(legacyDetail).not.toContain('tokenVersion');
  });

  it('PATCH SUCCESS audit failure aborts its transaction and cannot produce a fake legacy success', async () => {
    writeSecurityAuditMock.mockImplementation(
      async (_req: Request, event: { outcome: string }) => {
        if (event.outcome === 'SUCCESS') throw new Error('audit insert failed');
        return {
          requestId: 'security-request-1',
          action: 'admin.security.users.update',
        };
      }
    );

    const response = await PATCH(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'PATCH',
        body: { userId: 'user-1', displayName: '李四' },
      })
    );

    expect(response.status).toBe(503);
    expect(transactionCommitted).toBe(false);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
    ]);
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('PATCH records FAILED, never SUCCESS, when the business update fails after ATTEMPTED', async () => {
    userUpdateMock.mockRejectedValueOnce(new Error('user update failed'));

    const response = await PATCH(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'PATCH',
        body: { userId: 'user-1', displayName: '李四' },
      })
    );

    expect(response.status).toBe(500);
    expect(transactionCommitted).toBe(false);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'FAILED',
    ]);
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('PATCH records PARTIAL when settlement commits before the user update fails', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      ...SAFE_USER,
      purchasedMinutesBalance: 500,
      transcriptionMinutesLimit: 60,
    });
    userUpdateMock.mockRejectedValueOnce(new Error('user update failed'));

    const response = await PATCH(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'PATCH',
        body: { userId: 'user-1', transcriptionMinutesLimit: 10 },
      })
    );

    expect(response.status).toBe(500);
    expect(settlePoolOnLimitChangeMock).toHaveBeenCalledWith('user-1', 60, 10);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'PARTIAL',
    ]);
    expect(auditEvents().at(-1).metadata).toMatchObject({
      settlementCompleted: true,
    });
  });

  it('PATCH records PARTIAL when settlement commits before transactional SUCCESS audit fails', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      ...SAFE_USER,
      purchasedMinutesBalance: 500,
      transcriptionMinutesLimit: 60,
    });
    writeSecurityAuditMock.mockImplementation(
      async (_req: Request, event: { outcome: string }) => {
        if (event.outcome === 'SUCCESS') throw new Error('audit insert failed');
        return {
          requestId: 'security-request-1',
          action: 'admin.security.users.update',
        };
      }
    );

    const response = await PATCH(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'PATCH',
        body: { userId: 'user-1', transcriptionMinutesLimit: 10 },
      })
    );

    expect(response.status).toBe(503);
    expect(transactionCommitted).toBe(false);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'PARTIAL',
    ]);
  });

  it('DELETE persists ATTEMPTED before external deletion, then SUCCESS, with redacted user summaries', async () => {
    setupDeleteUser([
      {
        id: 'attachment-1',
        userId: 'user-1',
        bytes: BigInt(10),
        cloudrevePath: '/private/SENSITIVE_REMOTE_PATH',
        extractedTextPath: null,
      },
    ]);

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(200);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'SUCCESS',
    ]);
    expect(writeSecurityAuditMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCloudreveAttachmentFilesMock.mock.invocationCallOrder[0]
    );
    expect(trackJobMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCloudreveAttachmentFilesMock.mock.invocationCallOrder[0]
    );
    expect(auditEvents()[0]).toMatchObject({
      target: { type: 'user', ids: ['user-1'] },
      before: [{ id: 'user-1', email: 'user@example.com' }],
      reason: 'admin_delete',
      requestId: 'security-request-1',
    });
    expect(auditEvents()[1].requestId).toBe('security-request-1');
    const serialized = JSON.stringify(auditEvents());
    expect(serialized).not.toContain('SENSITIVE_REMOTE_PATH');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenVersion');
  });

  it('DELETE anonymizes durable resource ledgers and only removes non-resource jobs', async () => {
    setupDeleteUser();

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(200);
    expect(jobQueueUpdateManyMock).toHaveBeenCalledWith({
      where: {
        userId: { in: ['user-1'] },
        resourceScope: { not: null },
      },
      data: {
        userId: null,
        sessionId: null,
        triggeredBy: 'deleted-user',
        params: null,
        result: null,
        error: null,
        activeKey: null,
      },
    });
    expect(jobQueueDeleteManyMock).toHaveBeenCalledWith({
      where: {
        userId: { in: ['user-1'] },
        resourceScope: null,
      },
    });
  });

  it('DELETE rejects non-string or malformed IDs before DB queries and audit', async () => {
    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: [{ toString: 'user-1' }, 'bad/id'] },
      })
    );

    expect(response.status).toBe(400);
    expect(userFindManyMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditMock).not.toHaveBeenCalled();
  });

  it('DELETE reports a remote cleanup gap as PARTIAL', async () => {
    setupDeleteUser([
      {
        id: 'attachment-1',
        userId: 'user-1',
        bytes: BigInt(10),
        cloudrevePath: '/remote/file',
        extractedTextPath: null,
      },
    ]);
    deleteCloudreveAttachmentFilesMock.mockResolvedValueOnce(false);

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(200);
    expect(auditEvents().at(-1)).toMatchObject({
      outcome: 'PARTIAL',
      metadata: { remoteFilesComplete: false },
    });
  });

  it('DELETE clears translation task directories after DB commit', async () => {
    setupDeleteUser();
    translationTaskFindManyMock.mockResolvedValueOnce([
      { id: 'translation-task-1' },
      { id: 'translation-task-2' },
    ]);

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(200);
    expect(deleteTaskFilesMock).toHaveBeenCalledWith('translation-task-1');
    expect(deleteTaskFilesMock).toHaveBeenCalledWith('translation-task-2');
    expect(auditEvents().at(-1)).toMatchObject({
      outcome: 'SUCCESS',
      metadata: { localTranslationFilesComplete: true },
    });
  });

  it('DELETE reports local translation cleanup failure as PARTIAL', async () => {
    setupDeleteUser();
    translationTaskFindManyMock.mockResolvedValueOnce([
      { id: 'translation-task-1' },
    ]);
    deleteTaskFilesMock.mockRejectedValueOnce(new Error('disk unavailable'));

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(200);
    expect(auditEvents().at(-1)).toMatchObject({
      outcome: 'PARTIAL',
      metadata: { localTranslationFilesComplete: false },
    });
  });

  it('DELETE reports nonexistent or concurrently missing targets as PARTIAL, never fake SUCCESS', async () => {
    userFindManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    userDeleteManyMock.mockResolvedValueOnce({ count: 0 });

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['missing-user'] },
      })
    );

    expect(response.status).toBe(200);
    expect(auditEvents().at(-1)).toMatchObject({
      outcome: 'PARTIAL',
      after: { deleted: 0, missing: 1 },
      metadata: { deleted: 0, missing: 1, foundCount: 0 },
    });
  });

  it('DELETE completion-audit failure returns 503 after mutation while preserving ATTEMPTED', async () => {
    setupDeleteUser();
    writeSecurityAuditMock
      .mockResolvedValueOnce({
        requestId: 'security-request-1',
        action: 'admin.security.users.delete',
      })
      .mockResolvedValueOnce({
        requestId: 'security-request-1',
        action: 'admin.security.users.delete',
      })
      .mockRejectedValueOnce(new Error('completion audit insert failed'));

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(503);
    expect(userDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(auditEvents()[0].outcome).toBe('ATTEMPTED');
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('DELETE records FAILED when its DB transaction fails before any external file effect', async () => {
    setupDeleteUser();
    transactionMock.mockRejectedValueOnce(new Error('delete transaction failed'));

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(500);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'FAILED',
    ]);
  });

  it('DELETE records PARTIAL when DB rollback follows a possible external deletion', async () => {
    setupDeleteUser([
      {
        id: 'attachment-1',
        userId: 'user-1',
        bytes: BigInt(10),
        cloudrevePath: '/remote/file',
        extractedTextPath: null,
      },
    ]);
    transactionMock.mockRejectedValueOnce(new Error('delete transaction failed'));

    const response = await DELETE(
      createJsonRequest('http://localhost/api/admin/users', {
        method: 'DELETE',
        body: { userIds: ['user-1'] },
      })
    );

    expect(response.status).toBe(500);
    expect(auditEvents().map((event) => event.outcome)).toEqual([
      'ATTEMPTED',
      'PARTIAL',
    ]);
  });
});
