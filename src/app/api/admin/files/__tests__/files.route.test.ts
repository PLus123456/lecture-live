import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  sessionFindManyMock,
  sessionCountMock,
  folderSessionDeleteManyMock,
  shareLinkDeleteManyMock,
  sessionDeleteManyMock,
  chatAttachmentGroupByMock,
  transactionMock,
  releaseStorageBytesMock,
  logActionMock,
  invalidateSessionsApiCacheMock,
  invalidateFoldersApiCacheMock,
  invalidateShareLinksApiCacheMock,
  cancelAsyncUploadMock,
  settleAsyncReservationMock,
  settleFullReservationMock,
  deleteSessionArtifactsMock,
  deleteRecordingDraftMock,
  deleteTranscriptDraftMock,
  conversationFindManyMock,
  prepareConversationsCascadeMock,
  deletePreparedConversationsInTransactionMock,
  completePreparedConversationCascadeMock,
  findBillableStoredArtifactsByOwnersMock,
  markStoredArtifactsDeletePendingInTransactionMock,
  getSecurityAuditRequestIdMock,
  writeSecurityAuditMock,
  trackJobMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  sessionFindManyMock: vi.fn(),
  sessionCountMock: vi.fn(),
  folderSessionDeleteManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  sessionDeleteManyMock: vi.fn(),
  chatAttachmentGroupByMock: vi.fn(),
  transactionMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  logActionMock: vi.fn(),
  invalidateSessionsApiCacheMock: vi.fn(),
  invalidateFoldersApiCacheMock: vi.fn(),
  invalidateShareLinksApiCacheMock: vi.fn(),
  cancelAsyncUploadMock: vi.fn(),
  settleAsyncReservationMock: vi.fn(),
  settleFullReservationMock: vi.fn(),
  deleteSessionArtifactsMock: vi.fn(),
  deleteRecordingDraftMock: vi.fn(),
  deleteTranscriptDraftMock: vi.fn(),
  conversationFindManyMock: vi.fn(),
  prepareConversationsCascadeMock: vi.fn(),
  deletePreparedConversationsInTransactionMock: vi.fn(),
  completePreparedConversationCascadeMock: vi.fn(),
  findBillableStoredArtifactsByOwnersMock: vi.fn(),
  markStoredArtifactsDeletePendingInTransactionMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  trackJobMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: logActionMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
  writeSecurityAudit: writeSecurityAuditMock,
}));

vi.mock('@/lib/jobQueue', () => ({
  JOB_STATUS: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  JOB_TYPE: { ADMIN_MUTATION: 'admin_mutation' },
  trackJob: trackJobMock,
}));

vi.mock('@/lib/apiResponseCache', () => ({
  invalidateSessionsApiCache: invalidateSessionsApiCacheMock,
  invalidateFoldersApiCache: invalidateFoldersApiCacheMock,
  invalidateShareLinksApiCache: invalidateShareLinksApiCacheMock,
}));

vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: releaseStorageBytesMock,
  // B1/R4：批量删会话前用 settleAsyncReservation / settleFullReservation 原子结算在途预留。
  // P5-8：结算失败必须跳过该会话不删，故桩要能 reject。
  settleAsyncReservation: settleAsyncReservationMock,
  settleFullReservation: settleFullReservationMock,
}));

vi.mock('@/lib/audio/asyncUploadProcessor', () => ({
  cancelAsyncUpload: cancelAsyncUploadMock,
}));

// L4：admin 删录音也要物理删产物 + 录音草稿目录（对齐用户侧 DELETE）。
vi.mock('@/lib/sessionPersistence', () => ({
  deleteSessionArtifacts: deleteSessionArtifactsMock,
}));
vi.mock('@/lib/recordingDraftPersistence', () => ({
  deleteRecordingDraft: deleteRecordingDraftMock,
}));
vi.mock('@/lib/transcriptDraftPersistence', () => ({
  deleteTranscriptDraft: deleteTranscriptDraftMock,
}));
vi.mock('@/lib/conversationCascade', () => ({
  prepareConversationsCascade: prepareConversationsCascadeMock,
  deletePreparedConversationsInTransaction:
    deletePreparedConversationsInTransactionMock,
  completePreparedConversationCascade:
    completePreparedConversationCascadeMock,
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  findBillableStoredArtifactsByOwners: findBillableStoredArtifactsByOwnersMock,
  markStoredArtifactsDeletePendingInTransaction:
    markStoredArtifactsDeletePendingInTransactionMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findMany: sessionFindManyMock,
      count: sessionCountMock,
      deleteMany: sessionDeleteManyMock,
    },
    folderSession: {
      deleteMany: folderSessionDeleteManyMock,
    },
    shareLink: {
      deleteMany: shareLinkDeleteManyMock,
    },
    chatAttachment: {
      groupBy: chatAttachmentGroupByMock,
    },
    conversation: { findMany: conversationFindManyMock },
    $transaction: transactionMock,
  },
}));

import { DELETE, GET } from '@/app/api/admin/files/route';

const terminalAuditTx = { auditLog: {} };

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  displayName: 'Admin',
};

beforeEach(() => {
  requireAdminAccessMock.mockReset().mockResolvedValue({ user: adminUser, response: null });
  sessionFindManyMock.mockReset();
  sessionCountMock.mockReset();
  folderSessionDeleteManyMock.mockReset().mockResolvedValue({ count: 0 });
  shareLinkDeleteManyMock.mockReset().mockResolvedValue({ count: 0 });
  sessionDeleteManyMock.mockReset().mockImplementation(async (args) => ({
    count: Array.isArray(args?.where?.id?.in) ? args.where.id.in.length : 0,
  }));
  chatAttachmentGroupByMock.mockReset().mockResolvedValue([]);
  transactionMock
    .mockReset()
    .mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        folderSession: { deleteMany: folderSessionDeleteManyMock },
        shareLink: { deleteMany: shareLinkDeleteManyMock },
        session: { deleteMany: sessionDeleteManyMock },
      })
    );
  releaseStorageBytesMock.mockReset().mockResolvedValue(null);
  cancelAsyncUploadMock.mockReset().mockResolvedValue(undefined);
  settleAsyncReservationMock.mockReset().mockResolvedValue(0);
  settleFullReservationMock.mockReset().mockResolvedValue(0);
  deleteSessionArtifactsMock.mockReset().mockResolvedValue(undefined);
  deleteRecordingDraftMock.mockReset().mockResolvedValue(undefined);
  deleteTranscriptDraftMock.mockReset().mockResolvedValue(undefined);
  conversationFindManyMock.mockReset().mockResolvedValue([]);
  prepareConversationsCascadeMock.mockReset().mockImplementation(async (ids) => ({
    ids,
    attachments: [],
    ledgerRows: [],
  }));
  deletePreparedConversationsInTransactionMock
    .mockReset()
    .mockResolvedValue(0);
  completePreparedConversationCascadeMock
    .mockReset()
    .mockResolvedValue(true);
  findBillableStoredArtifactsByOwnersMock.mockReset().mockResolvedValue([]);
  markStoredArtifactsDeletePendingInTransactionMock
    .mockReset()
    .mockResolvedValue([]);
  getSecurityAuditRequestIdMock.mockReset().mockReturnValue('audit-request-1');
  writeSecurityAuditMock.mockReset().mockResolvedValue({
    requestId: 'audit-request-1',
    action: 'admin.security.test',
  });
  trackJobMock.mockReset().mockImplementation(
    async (
      options: {
        terminalMutation?: (
          tx: typeof terminalAuditTx,
          terminal:
            | { status: 'SUCCESS'; result: unknown }
            | { status: 'FAILED'; error: unknown },
        ) => Promise<void>;
      },
      operation: () => Promise<unknown>,
    ) => {
      let result: unknown;
      try {
        result = await operation();
      } catch (error) {
        try {
          await options.terminalMutation?.(terminalAuditTx, {
            status: 'FAILED',
            error,
          });
        } catch (journalError) {
          throw new AggregateError([error, journalError]);
        }
        throw error;
      }
      await options.terminalMutation?.(terminalAuditTx, {
        status: 'SUCCESS',
        result,
      });
      return result;
    },
  );
  logActionMock.mockReset();
  invalidateSessionsApiCacheMock.mockReset().mockResolvedValue(undefined);
  invalidateFoldersApiCacheMock.mockReset().mockResolvedValue(undefined);
  invalidateShareLinksApiCacheMock.mockReset().mockResolvedValue(undefined);
});

function deleteReq(ids: string[]): Request {
  return createJsonRequest('http://localhost:3000/api/admin/files', {
    method: 'DELETE',
    body: { ids },
  });
}

describe('GET /api/admin/files — 敏感读取审计', () => {
  const sensitiveSession = {
    id: 's1',
    title: 'Lecture',
    titleEn: null,
    courseName: 'Security',
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    durationMs: 1000,
    status: 'COMPLETED',
    recordingPath: '/private/storage/secret-recording.mp3',
    transcriptPath: '/private/storage/secret-transcript.json',
    summaryPath: null,
    reportPath: null,
    sourceLang: 'en',
    targetLang: 'zh',
    audioSource: 'upload',
    user: {
      id: 'u1',
      email: 'user@example.com',
      displayName: 'User',
      role: 'USER',
    },
  };

  it('审计落盘后才返回文件列表，审计事件不包含物理路径', async () => {
    sessionFindManyMock.mockResolvedValue([sensitiveSession]);
    sessionCountMock.mockResolvedValue(1);

    const response = await GET(
      new Request('http://localhost:3000/api/admin/files?status=completed&keyword=Lecture'),
    );

    expect(response.status).toBe(200);
    const body = await readJson<{
      files: Array<{ recordingPath: string; transcriptPath: string }>;
    }>(response);
    expect(body.files[0]).toMatchObject({
      recordingPath: '/private/storage/secret-recording.mp3',
      transcriptPath: '/private/storage/secret-transcript.json',
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock.mock.calls[0][1]).toMatchObject({
      event: 'files.read',
      target: { type: 'session_file_collection', id: 'all' },
      reason: 'admin_list',
      outcome: 'SUCCESS',
      requestId: 'audit-request-1',
      metadata: {
        filters: {
          keywordApplied: true,
          status: 'completed',
          userIdApplied: false,
        },
        page: 1,
        count: 1,
        total: 1,
      },
    });
    const auditEvent = JSON.stringify(writeSecurityAuditMock.mock.calls[0][1]);
    expect(auditEvent).not.toContain('/private/storage/');
  });

  it('审计写入失败时返回 503，响应不泄露任何文件路径', async () => {
    sessionFindManyMock.mockResolvedValue([sensitiveSession]);
    sessionCountMock.mockResolvedValue(1);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await GET(new Request('http://localhost:3000/api/admin/files'));

    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(responseText).not.toContain('/private/storage/');
    expect(responseText).not.toContain('secret-recording');
  });
});

describe('DELETE /api/admin/files — owner/ledger 删除状态机', () => {
  it('legacy 对话走 cascade，会话账本在 owner 删除事务内先标 DELETE_PENDING', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 's1', userId: 'u1', title: 'A' },
      { id: 's2', userId: 'u2', title: 'B' },
    ]);
    conversationFindManyMock.mockResolvedValue([{ id: 'c1' }]);
    findBillableStoredArtifactsByOwnersMock.mockResolvedValue([
      { id: 'artifact-1', ownerId: 's1' },
    ]);

    const res = await DELETE(deleteReq(['s1', 's2']));

    expect(res.status).toBe(200);
    await expect(readJson<{ deleted: number }>(res)).resolves.toEqual({ deleted: 2 });

    expect(prepareConversationsCascadeMock).toHaveBeenCalledWith(['c1']);
    expect(deletePreparedConversationsInTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ids: ['c1'] })
    );
    expect(completePreparedConversationCascadeMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['c1'] })
    );
    expect(findBillableStoredArtifactsByOwnersMock).toHaveBeenCalledWith(
      'session',
      ['s1', 's2']
    );
    // 两个会话各自结算事务 + 一个 owner 删除事务。
    expect(transactionMock).toHaveBeenCalledTimes(3);
    expect(markStoredArtifactsDeletePendingInTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      ['artifact-1']
    );
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'SUCCESS',
      'SUCCESS',
      'SUCCESS',
    ]);
    expect(writeSecurityAuditMock.mock.invocationCallOrder[0]).toBeLessThan(
      settleAsyncReservationMock.mock.invocationCallOrder[0],
    );
    expect(trackJobMock.mock.invocationCallOrder[0]).toBeLessThan(
      settleAsyncReservationMock.mock.invocationCallOrder[0],
    );
    expect(writeSecurityAuditMock.mock.calls.at(-1)?.[2]).toBe(terminalAuditTx);
    expect(trackJobMock.mock.calls[0][0]).toMatchObject({
      type: 'admin_mutation',
      resultSummary: expect.any(Function),
      errorSummary: expect.any(Function),
      terminalMutation: expect.any(Function),
    });
  });

  it('P1-16：批量删进行中异步上传 → cancelAsyncUpload 拿到 region + transcriptionId 做区域感知清理', async () => {
    sessionFindManyMock.mockResolvedValue([
      {
        id: 's1',
        userId: 'u1',
        title: 'A',
        asyncTranscribeStatus: 'transcribing',
        sonioxFileId: 'sf-1',
        sonioxTranscriptionId: 'st-1',
        sonioxRegion: 'eu',
      },
    ]);

    const res = await DELETE(deleteReq(['s1']));

    expect(res.status).toBe(200);
    // select 必须带 sonioxRegion + sonioxTranscriptionId，否则 cancelAsyncUpload 落回默认 region、
    // 跨 region 任务删错区资源致孤儿，且整段跳过删 transcription。
    const selectArg = sessionFindManyMock.mock.calls[0][0].select;
    expect(selectArg).toMatchObject({
      sonioxRegion: true,
      sonioxTranscriptionId: true,
    });
    expect(cancelAsyncUploadMock).toHaveBeenCalledTimes(1);
    expect(cancelAsyncUploadMock.mock.calls[0][0]).toMatchObject({
      id: 's1',
      sonioxFileId: 'sf-1',
      sonioxTranscriptionId: 'st-1',
      sonioxRegion: 'eu',
    });
    expect(writeSecurityAuditMock.mock.invocationCallOrder[0]).toBeLessThan(
      cancelAsyncUploadMock.mock.invocationCallOrder[0],
    );
  });

  it('无 legacy 附件时不调用 release', async () => {
    sessionFindManyMock.mockResolvedValue([{ id: 's1', userId: 'u1', title: 'A' }]);
    chatAttachmentGroupByMock.mockResolvedValue([]);

    const res = await DELETE(deleteReq(['s1']));

    expect(res.status).toBe(200);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('L4：先提交 owner/ledger 脱钩，再物理删除会话产物和草稿', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 's1', userId: 'u1', title: 'A', recordingPath: 'recordings/s1.mp3' },
      { id: 's2', userId: 'u2', title: 'B', recordingPath: null },
    ]);

    const res = await DELETE(deleteReq(['s1', 's2']));

    expect(res.status).toBe(200);
    // select 必须带各产物引用列，否则 deleteSessionArtifacts 拿不到路径、删不掉任何东西。
    const selectArg = sessionFindManyMock.mock.calls[0][0].select;
    expect(selectArg).toMatchObject({
      recordingPath: true,
      enhancedAudioPath: true,
      transcriptPath: true,
      summaryPath: true,
      reportPath: true,
      fullTranscriptPath: true,
    });
    expect(deleteSessionArtifactsMock).toHaveBeenCalledTimes(2);
    expect(deleteRecordingDraftMock).toHaveBeenCalledTimes(2);
    expect(deleteTranscriptDraftMock).toHaveBeenCalledTimes(2);
    // 物理删除只能发生在 owner + DELETE_PENDING 已持久提交之后。
    expect(sessionDeleteManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSessionArtifactsMock.mock.invocationCallOrder[0]
    );
    expect(JSON.stringify(writeSecurityAuditMock.mock.calls.map((call) => call[1]))).not.toContain(
      'recordings/s1.mp3',
    );
  });

  it('P5-8：某会话结算失败 → 跳过它不删，其余照常删（不再吞掉失败照删造孤儿预留）', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 's1', userId: 'u1', title: 'A' },
      { id: 's2', userId: 'u2', title: 'B' },
    ]);
    // s1 结算失败，s2 正常。
    settleAsyncReservationMock.mockRejectedValueOnce(new Error('db down'));

    const res = await DELETE(deleteReq(['s1', 's2']));

    expect(res.status).toBe(200);
    await expect(readJson<{ deleted: number; skipped?: number }>(res)).resolves.toEqual({
      deleted: 1,
      skipped: 1,
    });
    // 删除范围只含结算成功的 s2；s1 的行保留（预留还挂在它上面，重试即可结算）。
    expect(sessionDeleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ['s2'] } } });
    // s1 的产物也不能删（行还在，用户仍能访问）。
    expect(deleteSessionArtifactsMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'SUCCESS',
      'PARTIAL',
    ]);
  });

  it('并发导致实际少删时按 deleteMany.count 返回并记录 PARTIAL', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 's1', userId: 'u1', title: 'A' },
      { id: 's2', userId: 'u2', title: 'B' },
    ]);
    sessionDeleteManyMock.mockResolvedValueOnce({ count: 1 });

    const res = await DELETE(deleteReq(['s1', 's2']));

    expect(res.status).toBe(200);
    await expect(readJson<{ deleted: number }>(res)).resolves.toMatchObject({
      deleted: 1,
    });
    const completion = writeSecurityAuditMock.mock.calls.at(-1)?.[1];
    expect(completion).toMatchObject({
      outcome: 'PARTIAL',
      after: expect.objectContaining({
        deleted: 1,
        databaseRaceMissing: 1,
      }),
    });
  });

  it('P5-8：全部结算失败 → 500，一行都不删', async () => {
    sessionFindManyMock.mockResolvedValue([{ id: 's1', userId: 'u1', title: 'A' }]);
    settleFullReservationMock.mockRejectedValue(new Error('db down'));

    const res = await DELETE(deleteReq(['s1']));

    expect(res.status).toBe(500);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(sessionDeleteManyMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'PARTIAL',
    ]);
  });

  it('某用户聚合字节为 0/null 时跳过该用户的 release', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 's1', userId: 'u1', title: 'A' },
      { id: 's2', userId: 'u2', title: 'B' },
    ]);
    chatAttachmentGroupByMock.mockResolvedValue([
      { userId: 'u1', _sum: { bytes: BigInt(0) } },
      { userId: 'u2', _sum: { bytes: null } },
    ]);

    const res = await DELETE(deleteReq(['s1', 's2']));

    expect(res.status).toBe(200);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('目标查询失败时记录 FAILED，不伪造 SUCCESS', async () => {
    sessionFindManyMock.mockRejectedValueOnce(new Error('db down'));

    const response = await DELETE(deleteReq(['/private/storage/injected.mp3']));

    expect(response.status).toBe(500);
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'FAILED',
    ]);
    expect(JSON.stringify(writeSecurityAuditMock.mock.calls)).not.toContain(
      '/private/storage/injected.mp3',
    );
  });

  it('业务失败后的结果审计也失败时返回 503', async () => {
    sessionFindManyMock.mockRejectedValueOnce(new Error('db down'));
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await DELETE(deleteReq(['s1']));

    expect(response.status).toBe(503);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ outcome: 'FAILED' }),
    );
  });

  it('多阶段删除中 DB 事务失败时记录 PARTIAL，不伪造 SUCCESS', async () => {
    sessionFindManyMock.mockResolvedValue([{ id: 's1', userId: 'u1', title: 'A' }]);
    sessionDeleteManyMock.mockRejectedValueOnce(new Error('transaction failed'));

    const response = await DELETE(deleteReq(['s1']));

    expect(response.status).toBe(500);
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'PARTIAL',
    ]);
    expect(writeSecurityAuditMock.mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: 'PARTIAL',
      metadata: expect.objectContaining({
        stage: 'delete_database',
        journaled: true,
      }),
    });
    expect(completePreparedConversationCascadeMock).not.toHaveBeenCalled();
    expect(deleteSessionArtifactsMock).not.toHaveBeenCalled();
  });

  it('ATTEMPTED 审计无法落盘时 fail closed，不启动配额或文件删除', async () => {
    sessionFindManyMock.mockResolvedValue([{ id: 's1', userId: 'u1', title: 'A' }]);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await DELETE(deleteReq(['s1']));

    expect(response.status).toBe(503);
    expect(settleAsyncReservationMock).not.toHaveBeenCalled();
    expect(settleFullReservationMock).not.toHaveBeenCalled();
    expect(deleteSessionArtifactsMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('删除完成但结果审计失败时返回 503，初始 ATTEMPTED 仍已落盘', async () => {
    sessionFindManyMock.mockResolvedValue([{ id: 's1', userId: 'u1', title: 'A' }]);
    writeSecurityAuditMock.mockImplementation(
      async (_request: Request, event: { metadata?: { journaled?: boolean } }) => {
        if (event.metadata?.journaled) {
          throw new Error('audit unavailable');
        }
        return {
          requestId: 'audit-request-1',
          action: 'admin.security.files.delete',
        };
      },
    );

    const response = await DELETE(deleteReq(['s1']));

    expect(response.status).toBe(503);
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(writeSecurityAuditMock.mock.calls[0][1].outcome).toBe('ATTEMPTED');
  });
});
