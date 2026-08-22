import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  chatAttachmentCountMock,
  chatAttachmentFindManyMock,
  userFindManyMock,
  validateChatFileCleanupParamsMock,
  performChatFileCleanupMock,
  performChatFileDeleteMock,
  trackJobMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  chatAttachmentCountMock: vi.fn(),
  chatAttachmentFindManyMock: vi.fn(),
  userFindManyMock: vi.fn(),
  validateChatFileCleanupParamsMock: vi.fn(),
  performChatFileCleanupMock: vi.fn(),
  performChatFileDeleteMock: vi.fn(),
  trackJobMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      count: chatAttachmentCountMock,
      findMany: chatAttachmentFindManyMock,
    },
    user: { findMany: userFindManyMock },
  },
}));
vi.mock('@/lib/chatFileCleanup', () => ({
  olderThanDaysToCutoff: () => new Date('2026-01-01T00:00:00.000Z'),
  validateChatFileCleanupParams: validateChatFileCleanupParamsMock,
  performChatFileCleanup: performChatFileCleanupMock,
  performChatFileDelete: performChatFileDeleteMock,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { CHAT_FILES_CLEANUP: 'chat_files_cleanup' },
  JOB_STATUS: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  trackJob: trackJobMock,
}));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
}));

import {
  DELETE as DELETE_QUERY,
  GET,
} from '@/app/api/admin/chat-files/route';
import { POST as POST_CLEANUP } from '@/app/api/admin/chat-files/cleanup/route';
import { DELETE as DELETE_ONE } from '@/app/api/admin/chat-files/[id]/route';

const databaseTx = { auditLog: { name: 'database-audit-tx' } };
const artifactTx = { auditLog: { name: 'artifact-audit-tx' } };
const terminalTx = { auditLog: { name: 'job-terminal-tx' } };
const databaseSummary = {
  candidateCount: 1,
  deleted: 1,
  releasedBytes: 40,
  queuedArtifactCount: 1,
  deletedIds: ['attachment-1'],
  ownerIds: ['user-1'],
};
const artifactSummary = {
  artifactCount: 1,
  releasedArtifactCount: 1,
  releasedBytes: 60,
};
const cleanupResult = {
  deleted: 1,
  releasedBytes: 100,
  truncated: false,
  physicalDeleteComplete: true,
  pendingArtifactCount: 0,
};

function findAuditCall(event: string) {
  return writeSecurityAuditMock.mock.calls.find((call) => call[1]?.event === event);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminAccessMock.mockResolvedValue({
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    response: null,
  });
  getSecurityAuditRequestIdMock.mockReturnValue('server-request-id');
  writeSecurityAuditMock.mockResolvedValue({
    requestId: 'server-request-id',
    action: 'admin.security.chat_files',
  });
  validateChatFileCleanupParamsMock.mockImplementation((raw) => ({
    ok: true,
    olderThanDays: Number(raw.olderThanDays),
    sizeBytesGT: Number(raw.sizeBytesGT ?? 0),
    userId: raw.userId,
    kinds: raw.kinds ?? [],
    conversationId: raw.conversationId,
  }));
  chatAttachmentCountMock.mockResolvedValue(7);
  chatAttachmentFindManyMock.mockResolvedValue([
    {
      id: 'attachment-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      kind: 'document',
      fileName: 'sensitive-file-name.pdf',
      mimeType: 'application/pdf',
      bytes: BigInt(100),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastAccessedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  ]);
  userFindManyMock.mockResolvedValue([
    { id: 'user-1', email: 'user@example.com', displayName: 'User' },
  ]);
  performChatFileCleanupMock.mockImplementation(async (_input, options) => {
    await options.onDatabaseMutation(databaseTx, databaseSummary);
    await options.onArtifactReleaseMutation(artifactTx, artifactSummary);
    return cleanupResult;
  });
  performChatFileDeleteMock.mockImplementation(async (_id, options) => {
    await options.onDatabaseMutation(databaseTx, databaseSummary);
    await options.onArtifactReleaseMutation(artifactTx, artifactSummary);
    return {
      ...cleanupResult,
      found: true,
      ownerId: 'user-1',
    };
  });
  trackJobMock.mockImplementation(async (options, operation) => {
    try {
      const result = await operation();
      await options.terminalMutation?.(terminalTx, {
        status: 'SUCCESS',
        result,
      });
      return result;
    } catch (error) {
      await options.terminalMutation?.(terminalTx, {
        status: 'FAILED',
        error,
      });
      throw error;
    }
  });
});

describe('admin chat-files structured security audit', () => {
  it('列表读取在返回敏感文件元数据前写入 server requestId 审计', async () => {
    const req = new Request(
      'http://localhost/api/admin/chat-files?cursor=attacker-value%3Ftoken%3Dsecret',
      { headers: { 'x-request-id': 'attacker-controlled-id' } }
    );

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(findAuditCall('chat_files.read')?.[1]).toEqual(
      expect.objectContaining({
        requestId: 'server-request-id',
        outcome: 'SUCCESS',
        before: expect.objectContaining({
          filters: expect.objectContaining({ cursorPresent: true }),
        }),
      })
    );
    const persisted = JSON.stringify(findAuditCall('chat_files.read')?.[1]);
    expect(persisted).not.toContain('attacker-controlled-id');
    expect(persisted).not.toContain('attacker-value');
    expect(persisted).not.toContain('token=secret');
    expect(persisted).not.toContain('sensitive-file-name.pdf');
  });

  it('列表读取审计失败返回 500，且不泄露已查询出的文件列表', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await GET(new Request('http://localhost/api/admin/chat-files'));
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('sensitive-file-name.pdf');
    expect(body.items).toBeUndefined();
  });

  it('cleanup preview 审计失败返回 500，且不泄露 eligible count', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await GET(
      new Request(
        'http://localhost/api/admin/chat-files?cleanup_preview=1&olderThanDays=30'
      )
    );
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(500);
    expect(body.count).toBeUndefined();
  });

  it('DELETE cleanup 的 owner mutation、artifact release、job 终态分别与审计同事务', async () => {
    const res = await DELETE_QUERY(
      new Request(
        'http://localhost/api/admin/chat-files?olderThanDays=30&conversationId=conversation-1',
        { method: 'DELETE' }
      )
    );

    expect(res.status).toBe(200);
    expect(findAuditCall('chat_files.cleanup_database')?.[2]).toBe(databaseTx);
    expect(findAuditCall('chat_files.cleanup_artifacts')?.[2]).toBe(artifactTx);
    expect(findAuditCall('chat_files.cleanup')?.[2]).toBe(terminalTx);
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat_files_cleanup',
        params: expect.objectContaining({
          operation: 'admin_chat_files_cleanup',
          requestId: 'server-request-id',
        }),
        errorSummary: expect.any(Function),
        terminalMutation: expect.any(Function),
      }),
      expect.any(Function)
    );
    expect(
      trackJobMock.mock.calls[0]?.[0].errorSummary(
        new Error('/cloud/path?access_token=secret')
      )
    ).toBe('ChatFileCleanupError');
  });

  it('owner mutation 审计失败时 route 返回 500，不返回成功计数', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await DELETE_QUERY(
      new Request(
        'http://localhost/api/admin/chat-files?olderThanDays=30',
        { method: 'DELETE' }
      )
    );
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(500);
    expect(body.deleted).toBeUndefined();
    expect(findAuditCall('chat_files.cleanup')?.[1]).toEqual(
      expect.objectContaining({ outcome: 'PARTIAL' })
    );
  });

  it('POST cleanup 走同一 durable journal 与事务审计边界', async () => {
    const res = await POST_CLEANUP(
      createJsonRequest('http://localhost/api/admin/chat-files/cleanup', {
        method: 'POST',
        body: { olderThanDays: 30, kinds: ['document'] },
      })
    );

    expect(res.status).toBe(200);
    expect(findAuditCall('chat_files.cleanup_database')?.[2]).toBe(databaseTx);
    expect(findAuditCall('chat_files.cleanup_artifacts')?.[2]).toBe(artifactTx);
    expect(findAuditCall('chat_files.cleanup')?.[2]).toBe(terminalTx);
  });

  it('单条删除的 DB、artifact 与 journal 终态审计均绑定对应事务', async () => {
    const res = await DELETE_ONE(
      new Request('http://localhost/api/admin/chat-files/attachment-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'attachment-1' }) }
    );

    expect(res.status).toBe(200);
    expect(findAuditCall('chat_files.delete_database')?.[2]).toBe(databaseTx);
    expect(findAuditCall('chat_files.delete_artifact')?.[2]).toBe(artifactTx);
    expect(findAuditCall('chat_files.delete')?.[2]).toBe(terminalTx);
  });

  it('单条不存在仍产生 DENIED 审计并返回 404', async () => {
    performChatFileDeleteMock.mockImplementationOnce(async (_id, options) => {
      await options.onDatabaseMutation(databaseTx, {
        ...databaseSummary,
        candidateCount: 0,
        deleted: 0,
        releasedBytes: 0,
        queuedArtifactCount: 0,
        deletedIds: [],
        ownerIds: [],
      });
      return {
        ...cleanupResult,
        found: false,
        ownerId: null,
        deleted: 0,
        releasedBytes: 0,
      };
    });

    const res = await DELETE_ONE(
      new Request('http://localhost/api/admin/chat-files/missing', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'missing' }) }
    );

    expect(res.status).toBe(404);
    expect(findAuditCall('chat_files.delete_database')?.[1]).toEqual(
      expect.objectContaining({ outcome: 'DENIED' })
    );
    expect(findAuditCall('chat_files.delete')?.[1]).toEqual(
      expect.objectContaining({ outcome: 'DENIED' })
    );
  });
});
