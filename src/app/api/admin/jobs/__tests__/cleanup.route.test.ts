import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  jobQueueDeleteManyMock,
  jobQueueCountMock,
  jobQueueFindManyMock,
  jobQueueFindUniqueMock,
  jobQueueUpdateManyMock,
  transactionMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  jobQueueDeleteManyMock: vi.fn(),
  jobQueueCountMock: vi.fn(),
  jobQueueFindManyMock: vi.fn(),
  jobQueueFindUniqueMock: vi.fn(),
  jobQueueUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
}));

const txClient = {
  jobQueue: {
    deleteMany: jobQueueDeleteManyMock,
    findUnique: jobQueueFindUniqueMock,
    updateMany: jobQueueUpdateManyMock,
  },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    jobQueue: {
      deleteMany: jobQueueDeleteManyMock,
      count: jobQueueCountMock,
      findMany: jobQueueFindManyMock,
      findUnique: jobQueueFindUniqueMock,
      updateMany: jobQueueUpdateManyMock,
    },
    $transaction: transactionMock,
  },
}));

import { DELETE, GET, POST } from '@/app/api/admin/jobs/route';

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  displayName: 'Admin',
};

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  jobQueueDeleteManyMock.mockReset();
  jobQueueCountMock.mockReset();
  jobQueueFindManyMock.mockReset();
  jobQueueFindUniqueMock.mockReset();
  jobQueueUpdateManyMock.mockReset();
  transactionMock.mockReset().mockImplementation(
    async (callback: (tx: typeof txClient) => Promise<unknown>) => callback(txClient)
  );
  writeSecurityAuditMock.mockReset().mockResolvedValue({
    requestId: 'server-request-id',
    action: 'admin.security.jobs.test',
  });
  getSecurityAuditRequestIdMock.mockReset().mockReturnValue('server-request-id');
  requireAdminAccessMock.mockResolvedValue({ user: adminUser, response: null });
});

describe('GET /api/admin/jobs', () => {
  it('JobQueue 资源账本 bigint 以十进制字符串返回，不会让列表 JSON 500', async () => {
    jobQueueFindManyMock.mockResolvedValue([
      {
        id: 'job-1',
        type: 'report_generation',
        status: 'PROCESSING',
        params: null,
        result: null,
        error: null,
        sessionId: 'session-1',
        userId: 'user-1',
        triggeredBy: 'system',
        attempt: 1,
        maxAttempts: 1,
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
        startedAt: new Date('2026-08-20T00:00:01.000Z'),
        completedAt: null,
        activeKey: 'report:session-1:hash',
        resourceScope: 'llm_report_tokens',
        reservedUnits: BigInt(2_500_000),
        actualUnits: null,
      },
    ]);
    jobQueueCountMock.mockResolvedValue(1);

    const res = await GET(
      new Request('http://localhost:3000/api/admin/jobs?page=1&pageSize=20')
    );

    expect(res.status).toBe(200);
    const body = await readJson<{
      jobs: Array<{ reservedUnits: string; actualUnits: string | null }>;
    }>(res);
    expect(body.jobs[0]).toMatchObject({
      reservedUnits: '2500000',
      actualUnits: null,
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'jobs.read',
        operator: expect.objectContaining({ id: adminUser.id }),
        target: { type: 'job_queue_collection' },
        before: null,
        outcome: 'SUCCESS',
        requestId: 'server-request-id',
      })
    );
  });

  it('安全审计写入失败时不返回任务列表并以 500 关闭失败', async () => {
    jobQueueFindManyMock.mockResolvedValue([]);
    jobQueueCountMock.mockResolvedValue(0);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await GET(new Request('http://localhost:3000/api/admin/jobs'));

    expect(res.status).toBe(500);
  });
});

function deleteReq(params: Record<string, string | string[]>): Request {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, item);
    } else {
      sp.set(k, v);
    }
  }
  return new Request(`http://localhost:3000/api/admin/jobs?${sp.toString()}`, {
    method: 'DELETE',
  });
}

describe('DELETE /api/admin/jobs', () => {
  it.each(['SUBMITTED', 'PENDING', 'PROCESSING'])(
    '拒绝 in-flight 状态 %s — 返回 400 且不调用 deleteMany',
    async (status) => {
      const res = await DELETE(deleteReq({ statuses: status, olderThanDays: '30' }));
      expect(res.status).toBe(400);
      expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
      expect(writeSecurityAuditMock).not.toHaveBeenCalled();
    }
  );

  it('混入 SUBMITTED 也拒绝，即使有 SUCCESS', async () => {
    const res = await DELETE(
      deleteReq({ statuses: ['SUCCESS', 'SUBMITTED'], olderThanDays: '30' })
    );
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('空 statuses 返回 400', async () => {
    const res = await DELETE(deleteReq({ olderThanDays: '30' }));
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('olderThanDays 超界返回 400', async () => {
    const res = await DELETE(deleteReq({ statuses: 'SUCCESS', olderThanDays: '0' }));
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('未知 type 返回 400', async () => {
    const res = await DELETE(
      deleteReq({ statuses: 'SUCCESS', olderThanDays: '30', type: 'bogus_type' })
    );
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('合法入参 — 调用 deleteMany、写审计日志、返回 count', async () => {
    jobQueueDeleteManyMock.mockResolvedValue({ count: 12 });

    const res = await DELETE(
      deleteReq({ statuses: ['SUCCESS', 'FAILED'], olderThanDays: '30' })
    );
    expect(res.status).toBe(200);
    await expect(readJson<{ deletedCount: number }>(res)).resolves.toMatchObject({
      success: true,
      deletedCount: 12,
    });

    expect(jobQueueDeleteManyMock).toHaveBeenCalledTimes(1);
    const call = jobQueueDeleteManyMock.mock.calls[0]?.[0];
    expect(call.where.status).toEqual({ in: ['SUCCESS', 'FAILED'] });
    expect(call.where.completedAt.lt).toBeInstanceOf(Date);
    expect(call.where).not.toHaveProperty('createdAt');
    expect(call.where).not.toHaveProperty('type');
    expect(call.where.OR).toEqual([
      { resourceScope: null },
      { actualUnits: { not: null } },
    ]);

    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'jobs.cleanup',
        operator: expect.objectContaining({ id: adminUser.id }),
        before: { eligibleCount: 12 },
        after: { deletedCount: 12 },
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('指定 type 时，把 type 加入 where 子句', async () => {
    jobQueueDeleteManyMock.mockResolvedValue({ count: 3 });

    await DELETE(
      deleteReq({
        statuses: 'SUCCESS',
        olderThanDays: '7',
        type: 'report_generation',
      })
    );
    const call = jobQueueDeleteManyMock.mock.calls[0]?.[0];
    expect(call.where.type).toBe('report_generation');
  });

  it('非管理员被 requireAdminAccess 拦截 — deleteMany 不被调用', async () => {
    requireAdminAccessMock.mockResolvedValue({
      user: null,
      response: new Response('forbidden', { status: 403 }),
    });

    const res = await DELETE(deleteReq({ statuses: 'SUCCESS', olderThanDays: '30' }));
    expect(res.status).toBe(403);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('审计写失败时清理事务回滚并返回 500', async () => {
    let remainingRows = 4;
    transactionMock.mockImplementationOnce(
      async (callback: (tx: typeof txClient) => Promise<unknown>) => {
        const snapshot = remainingRows;
        const stagedTx = {
          jobQueue: {
            ...txClient.jobQueue,
            deleteMany: vi.fn(async () => {
              const count = remainingRows;
              remainingRows = 0;
              return { count };
            }),
          },
        };
        try {
          return await callback(stagedTx);
        } catch (error) {
          remainingRows = snapshot;
          throw error;
        }
      }
    );
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await DELETE(
      deleteReq({ statuses: 'SUCCESS', olderThanDays: '30' })
    );

    expect(res.status).toBe(500);
    expect(remainingRows).toBe(4);
  });
});

describe('GET /api/admin/jobs?cleanup_preview=1', () => {
  it('返回 count 而不删', async () => {
    jobQueueCountMock.mockResolvedValue(42);

    const req = new Request(
      'http://localhost:3000/api/admin/jobs?cleanup_preview=1&statuses=SUCCESS&olderThanDays=30'
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    await expect(readJson<{ count: number }>(res)).resolves.toEqual({ count: 42 });
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
    expect(jobQueueCountMock).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: { in: ['SUCCESS'] },
        completedAt: { lt: expect.any(Date) },
        OR: [
          { resourceScope: null },
          { actualUnits: { not: null } },
        ],
      }),
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'jobs.cleanup_preview',
        before: null,
        after: { eligibleCount: 42 },
        outcome: 'SUCCESS',
      })
    );
  });

  it('preview 也拒绝 in-flight 状态', async () => {
    const req = new Request(
      'http://localhost:3000/api/admin/jobs?cleanup_preview=1&statuses=PROCESSING&olderThanDays=30'
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(jobQueueCountMock).not.toHaveBeenCalled();
  });

  it('preview 审计失败时返回 500，不泄露 count', async () => {
    jobQueueCountMock.mockResolvedValue(42);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await GET(
      new Request(
        'http://localhost:3000/api/admin/jobs?cleanup_preview=1&statuses=SUCCESS&olderThanDays=30'
      )
    );

    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/jobs', () => {
  const retryableJob = {
    id: 'job-1',
    type: 'audio_enhance',
    status: 'FAILED',
    userId: 'user-1',
    sessionId: 'session-1',
    attempt: 1,
    maxAttempts: 3,
    activeKey: null,
  };

  function retryRequest() {
    return new Request('http://localhost:3000/api/admin/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'job-1' }),
    });
  }

  it('状态 CAS 与 SUCCESS 审计共用一个事务客户端', async () => {
    jobQueueFindUniqueMock
      .mockResolvedValueOnce(retryableJob)
      .mockResolvedValueOnce(retryableJob)
      .mockResolvedValueOnce({
        ...retryableJob,
        status: 'SUBMITTED',
        attempt: 2,
      });
    jobQueueUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(retryRequest());

    expect(res.status).toBe(200);
    expect(jobQueueUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          status: 'FAILED',
          attempt: 1,
        }),
      })
    );
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'jobs.retry',
        target: expect.objectContaining({ id: 'job-1', ownerId: 'user-1' }),
        before: expect.objectContaining({ status: 'FAILED', attempt: 1 }),
        after: expect.objectContaining({ status: 'SUBMITTED', attempt: 2 }),
        reason: 'admin_retry',
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('SUCCESS 审计失败时 CAS 变更回滚且 route 返回 500', async () => {
    let state = { ...retryableJob };
    transactionMock.mockImplementationOnce(
      async (callback: (tx: typeof txClient) => Promise<unknown>) => {
        const snapshot = { ...state };
        const stagedTx = {
          jobQueue: {
            deleteMany: jobQueueDeleteManyMock,
            findUnique: vi.fn(async () => ({ ...state })),
            updateMany: vi.fn(async () => {
              if (state.status !== 'FAILED') return { count: 0 };
              state = {
                ...state,
                status: 'SUBMITTED',
                attempt: state.attempt + 1,
              };
              return { count: 1 };
            }),
          },
        };
        try {
          return await callback(stagedTx);
        } catch (error) {
          state = snapshot;
          throw error;
        }
      }
    );
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await POST(retryRequest());

    expect(res.status).toBe(500);
    expect(state).toMatchObject({ status: 'FAILED', attempt: 1 });
  });

  it('不可重试任务记录 DENIED 并保持 409 语义', async () => {
    const job = { ...retryableJob, type: 'report_generation' };
    jobQueueFindUniqueMock.mockResolvedValue(job);

    const res = await POST(retryRequest());

    expect(res.status).toBe(409);
    expect(jobQueueUpdateManyMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'jobs.retry',
        before: expect.objectContaining({ type: 'report_generation' }),
        outcome: 'DENIED',
      }),
      txClient
    );
  });
});
