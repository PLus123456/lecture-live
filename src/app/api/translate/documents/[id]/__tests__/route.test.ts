import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  taskFindUniqueMock,
  taskUpdateManyMock,
  taskDeleteManyMock,
  jobUpdateManyMock,
  transactionMock,
  deleteTaskFilesMock,
  getTranslateFleetConfigMock,
  deleteTranslateJobMock,
  refundTaskChargeMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  taskFindUniqueMock: vi.fn(),
  taskUpdateManyMock: vi.fn(),
  taskDeleteManyMock: vi.fn(),
  jobUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  deleteTaskFilesMock: vi.fn(),
  getTranslateFleetConfigMock: vi.fn(),
  deleteTranslateJobMock: vi.fn(),
  refundTaskChargeMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: {
      findUnique: taskFindUniqueMock,
      updateMany: taskUpdateManyMock,
    },
    jobQueue: { updateMany: jobUpdateManyMock },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_STATUS: { SUBMITTED: 'SUBMITTED', FAILED: 'FAILED' },
  JOB_TYPE: { DOC_TRANSLATE: 'doc_translate' },
}));
vi.mock('@/lib/translate/taskApi', () => ({
  TASK_VIEW_SELECT: {},
  toTaskView: (value: unknown) => value,
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  deleteTaskFiles: deleteTaskFilesMock,
}));
vi.mock('@/lib/translate/translateProcessor', () => ({
  runDocTranslateTick: vi.fn(),
  refundTaskCharge: refundTaskChargeMock,
  translationRemoteJobId: (jobId: string, generation: string) =>
    `remote:${jobId}:${generation}`,
}));
vi.mock('@/lib/translate/workerClient', () => ({
  getTranslateFleetConfig: getTranslateFleetConfigMock,
  deleteTranslateJob: deleteTranslateJobMock,
}));

import { DELETE } from '../route';

describe('DELETE /api/translate/documents/[id] resource ledger redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1' });
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'COMPLETED',
      jobQueueId: 'schedule-1',
      workerId: null,
      proxyGeneration: null,
      chargedCents: 0,
      refundedAt: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    taskDeleteManyMock.mockResolvedValue({ count: 1 });
    jobUpdateManyMock.mockResolvedValue({ count: 2 });
    deleteTaskFilesMock.mockResolvedValue(undefined);
    taskUpdateManyMock.mockResolvedValue({ count: 1 });
    getTranslateFleetConfigMock.mockResolvedValue({
      workers: [{ id: 'worker-1' }],
    });
    deleteTranslateJobMock.mockResolvedValue(undefined);
    refundTaskChargeMock.mockResolvedValue({
      claimed: true,
      updatedAt: new Date('2026-08-20T12:00:00.001Z'),
    });
    transactionMock.mockImplementation(
      async (
        callback: (tx: {
          translationTask: { deleteMany: typeof taskDeleteManyMock };
          jobQueue: { updateMany: typeof jobUpdateManyMock };
        }) => Promise<unknown>
      ) =>
        callback({
          translationTask: { deleteMany: taskDeleteManyMock },
          jobQueue: { updateMany: jobUpdateManyMock },
        })
    );
  });

  it('同事务保留 token 数值账本但抹除可恢复的翻译 cache 和关联标识', async () => {
    const response = await DELETE(
      new Request('http://localhost/api/translate/documents/task-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(jobUpdateManyMock).toHaveBeenCalledWith({
      where: {
        resourceScope: { not: null },
        sessionId: 'task-1',
        userId: 'user-1',
      },
      data: {
        sessionId: null,
        params: null,
        result: null,
        error: null,
        activeKey: null,
        triggeredBy: 'translation-task-deleted',
      },
    });
    expect(jobUpdateManyMock).toHaveBeenCalledWith({
      where: {
        resourceScope: null,
        type: 'doc_translate',
        userId: 'user-1',
        OR: [
          { id: 'schedule-1' },
          { params: { contains: '"taskId":"task-1"' } },
        ],
      },
      data: {
        sessionId: null,
        userId: null,
        params: null,
        result: null,
        error: null,
        activeKey: null,
        triggeredBy: 'translation-task-deleted',
      },
    });
    expect(deleteTaskFilesMock).toHaveBeenCalledWith('task-1');
  });

  it('并发删除未抢到 task 行时不误抹另一代账本', async () => {
    taskDeleteManyMock.mockResolvedValue({ count: 0 });
    taskFindUniqueMock
      .mockResolvedValueOnce({
        id: 'task-1',
        userId: 'user-1',
        status: 'COMPLETED',
        jobQueueId: 'schedule-1',
        workerId: null,
        proxyGeneration: null,
        chargedCents: 0,
        refundedAt: null,
        updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      })
      .mockResolvedValueOnce(null);

    const response = await DELETE(
      new Request('http://localhost/api/translate/documents/task-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(jobUpdateManyMock).not.toHaveBeenCalled();
  });

  it('取消按 task generation CAS，并只删除该代派生的远端 job', async () => {
    const generation = 'a'.repeat(64);
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'TRANSLATING',
      jobQueueId: 'schedule-1',
      workerId: 'worker-1',
      proxyGeneration: generation,
      chargedCents: 125,
      refundedAt: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });

    const response = await DELETE(
      new Request('http://localhost/api/translate/documents/task-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'task-1',
          jobQueueId: 'schedule-1',
          proxyGeneration: generation,
        }),
      })
    );
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'schedule-1',
          params: {
            contains: `\"proxyGeneration\":\"${generation}\"`,
          },
        }),
      })
    );
    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'worker-1' }),
      `remote:schedule-1:${generation}`
    );
    expect(deleteTranslateJobMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'schedule-1'
    );
    expect(refundTaskChargeMock).toHaveBeenCalledWith(
      'task-1',
      '用户取消退款',
      {
        status: 'CANCELED',
        jobQueueId: 'schedule-1',
        proxyGeneration: null,
        chargedCents: 125,
        updatedAt: expect.any(Date),
      }
    );
  });

  it('取消 CAS 输给新 generation 时返回409，不用旧快照假报成功', async () => {
    const generation = 'b'.repeat(64);
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'TRANSLATING',
      jobQueueId: 'schedule-1',
      workerId: 'worker-1',
      proxyGeneration: generation,
      chargedCents: 125,
      refundedAt: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    taskUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(
      new Request('http://localhost/api/translate/documents/task-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'task_generation_changed',
    });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteTranslateJobMock).not.toHaveBeenCalled();
  });

  it('零元任务取消不要求退款 winner，仍完成队列和远端清理', async () => {
    const generation = '0'.repeat(64);
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'TRANSLATING',
      jobQueueId: 'schedule-1',
      workerId: 'worker-1',
      proxyGeneration: generation,
      chargedCents: 0,
      refundedAt: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    refundTaskChargeMock.mockResolvedValue({ claimed: false });

    const response = await DELETE(
      new Request('http://localhost/api/translate/documents/task-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(refundTaskChargeMock).not.toHaveBeenCalled();
    expect(deleteTranslateJobMock).toHaveBeenCalled();
  });

  it('终态删除补退款绑定旧任务快照，迟到请求不能退新代费用', async () => {
    taskFindUniqueMock
      .mockResolvedValueOnce({
        id: 'task-1',
        userId: 'user-1',
        status: 'FAILED',
        jobQueueId: 'schedule-old',
        workerId: null,
        proxyGeneration: null,
        chargedCents: 125,
        refundedAt: null,
        updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'task-1',
        userId: 'user-1',
        status: 'FAILED',
        jobQueueId: 'schedule-old',
        workerId: null,
        proxyGeneration: null,
        chargedCents: 125,
        refundedAt: new Date('2026-08-20T12:00:00.001Z'),
        updatedAt: new Date('2026-08-20T12:00:00.001Z'),
      });

    const response = await DELETE(
      new Request('http://localhost/api/translate/documents/task-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(refundTaskChargeMock).toHaveBeenCalledWith(
      'task-1',
      '删除任务前补退款',
      {
        status: 'FAILED',
        jobQueueId: 'schedule-old',
        proxyGeneration: null,
        chargedCents: 125,
        updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      }
    );
  });

  it('旧删除请求补退款输掉快照后不得接管后来终态', async () => {
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'FAILED',
      jobQueueId: null,
      workerId: null,
      proxyGeneration: null,
      chargedCents: 125,
      refundedAt: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    refundTaskChargeMock.mockResolvedValue({ claimed: false });

    const response = await DELETE(
      new Request('http://localhost/api/translate/documents/task-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(409);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
  });
});
