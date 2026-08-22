// L23 / L24：翻译调度的「代次绑定」与「孤儿任务补入队」。
//
// L24：用户 retry 会把任务重置回 PENDING + 重新扣一次费 + 换一条新调度行。若上一代的
//      失败/对账才姗姗来迟，它会打死新一代的任务、退掉新一代的钱、甚至 rm -rf 掉源文件。
// L23：扣费与入队不在同一事务里，中间挂掉就留下「扣了费但没有调度行」的孤儿任务。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  taskUpdateManyMock,
  taskFindUniqueMock,
  taskFindManyMock,
  jobFindManyMock,
  jobUpdateManyMock,
  jobUpdateMock,
  jobFindUniqueMock,
  transactionMock,
  createJobMock,
  getTranslateFleetConfigMock,
  pingTranslateWorkerMock,
  uploadTranslateInputMock,
  startTranslateJobMock,
  getTranslateJobMock,
  readSourceFileMock,
  getSiteSettingsMock,
  resolveGroupBoundModelMock,
  deleteTaskFilesMock,
  downloadTranslateOutputMock,
  saveOutputFileMock,
  deleteOutputGenerationMock,
  deleteTranslateJobMock,
} = vi.hoisted(() => ({
  taskUpdateManyMock: vi.fn(),
  taskFindUniqueMock: vi.fn(),
  taskFindManyMock: vi.fn(),
  jobFindManyMock: vi.fn(),
  jobUpdateManyMock: vi.fn(),
  jobUpdateMock: vi.fn(),
  jobFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  createJobMock: vi.fn(),
  getTranslateFleetConfigMock: vi.fn(),
  pingTranslateWorkerMock: vi.fn(),
  uploadTranslateInputMock: vi.fn(),
  startTranslateJobMock: vi.fn(),
  getTranslateJobMock: vi.fn(),
  readSourceFileMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  resolveGroupBoundModelMock: vi.fn(),
  deleteTaskFilesMock: vi.fn(),
  downloadTranslateOutputMock: vi.fn(),
  saveOutputFileMock: vi.fn(),
  deleteOutputGenerationMock: vi.fn(),
  deleteTranslateJobMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: {
      updateMany: taskUpdateManyMock,
      findUnique: taskFindUniqueMock,
      findMany: taskFindManyMock,
      update: vi.fn(),
    },
    jobQueue: {
      findMany: jobFindManyMock,
      updateMany: jobUpdateManyMock,
      update: jobUpdateMock,
      findUnique: jobFindUniqueMock,
    },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/wallet', () => ({ refundWalletCents: vi.fn() }));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { DOC_TRANSLATE: 'doc_translate' },
  JOB_STATUS: {
    SUBMITTED: 'SUBMITTED',
    PROCESSING: 'PROCESSING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
  },
  createJob: createJobMock,
  retryJob: vi.fn(),
}));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/userRoles', () => ({ resolveUserTranslationModelId: vi.fn() }));
vi.mock('@/lib/llm/summaryModel', () => ({
  resolveGroupBoundModel: resolveGroupBoundModelMock,
}));
vi.mock('@/lib/translate/workerClient', () => ({
  getTranslateFleetConfig: getTranslateFleetConfigMock,
  pingTranslateWorker: pingTranslateWorkerMock,
  uploadTranslateInput: uploadTranslateInputMock,
  startTranslateJob: startTranslateJobMock,
  getTranslateJob: getTranslateJobMock,
  downloadTranslateOutput: downloadTranslateOutputMock,
  deleteTranslateJob: deleteTranslateJobMock,
  buildWorkerModelLabel: vi.fn(() => 'mock-model'),
  TranslateWorkerError: class TranslateWorkerError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  readSourceFile: readSourceFileMock,
  saveOutputFile: saveOutputFileMock,
  deleteOutputGeneration: deleteOutputGenerationMock,
  deleteTaskFiles: deleteTaskFilesMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (e: unknown) => e,
}));

import {
  enqueueDocTranslate,
  runDocTranslateTick,
  translationRemoteJobId,
} from '@/lib/translate/translateProcessor';
import { TranslateWorkerError } from '@/lib/translate/workerClient';

const FLEET = {
  watermark: false,
  workers: [
    {
      id: 'w1',
      name: 'worker-1',
      baseUrl: 'http://w1',
      concurrency: 2,
      weight: 1,
      qps: 2,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__docTranslateTickRun = undefined;
  transactionMock.mockImplementation((cb: (tx: unknown) => unknown) =>
    typeof cb === 'function'
      ? cb({
          jobQueue: { updateMany: jobUpdateManyMock },
          translationTask: { updateMany: taskUpdateManyMock },
        })
      : undefined
  );
  getTranslateFleetConfigMock.mockResolvedValue(FLEET);
  pingTranslateWorkerMock.mockResolvedValue({
    ok: true,
    queue: { running: 0, queued: 0 },
  });
  uploadTranslateInputMock.mockResolvedValue(undefined);
  startTranslateJobMock.mockResolvedValue(undefined);
  getTranslateJobMock.mockRejectedValue(new Error('not found'));
  readSourceFileMock.mockResolvedValue(Buffer.from('pdf'));
  getSiteSettingsMock.mockResolvedValue({ site_url: 'https://app.example' });
  resolveGroupBoundModelMock.mockResolvedValue({
    routing: { purpose: 'TRANSLATION' },
    provider: {
      dbModelId: 'm1',
      purpose: 'TRANSLATION',
      name: 'mock',
      model: 'translate',
    },
  });
  jobFindManyMock.mockResolvedValue([]);
  jobUpdateManyMock.mockResolvedValue({ count: 1 });
  jobUpdateMock.mockResolvedValue({});
  taskFindManyMock.mockResolvedValue([]);
  taskUpdateManyMock.mockResolvedValue({ count: 1 });
  createJobMock.mockResolvedValue('job-new');
  // 被 `.catch(...)` 链式调用的 mock 必须返回 Promise，否则 undefined.catch 抛 TypeError
  // 并被对账的外层 catch 吞掉，测试会静默通过（假绿）。
  deleteTranslateJobMock.mockResolvedValue(undefined);
  deleteTaskFilesMock.mockResolvedValue(undefined);
  deleteOutputGenerationMock.mockResolvedValue(undefined);
});

describe('enqueueDocTranslate — 孤儿调度行回收 (L23)', () => {
  it('任务已不在 PENDING（并发取消/删除）→ 刚建的调度行就地终态，不留在 SUBMITTED 占派发槽', async () => {
    taskFindUniqueMock.mockResolvedValue({ id: 't1', jobQueueId: null });
    taskUpdateManyMock.mockResolvedValue({ count: 0 }); // 绑定失败

    const jobId = await enqueueDocTranslate('t1', 'u1');

    expect(jobId).toBeNull();
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-new', status: 'SUBMITTED' },
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );
  });

  it('绑定成功 → 返回 jobId，不终态化', async () => {
    taskFindUniqueMock.mockResolvedValue({ id: 't1', jobQueueId: null });
    taskUpdateManyMock.mockResolvedValue({ count: 1 });

    await expect(enqueueDocTranslate('t1', 'u1')).resolves.toBe('job-new');
    expect(jobUpdateManyMock).not.toHaveBeenCalled();
  });

  it('并发 orphan enqueuer 只允许一个绑定，loser 复用 winner job', async () => {
    taskFindUniqueMock
      .mockResolvedValueOnce({ id: 't1', jobQueueId: null })
      .mockResolvedValueOnce({
        id: 't1',
        status: 'PENDING',
        jobQueueId: 'job-winner',
      });
    taskUpdateManyMock.mockResolvedValue({ count: 0 });

    await expect(enqueueDocTranslate('t1', 'u1')).resolves.toBe('job-winner');
    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jobQueueId: null }),
      })
    );
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-new', status: 'SUBMITTED' },
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );
  });
});

describe('runDocTranslateTick — 孤儿任务补入队 (L23)', () => {
  it('PENDING 且 jobQueueId=null 且过了宽限期 → 补建调度行', async () => {
    taskFindManyMock.mockResolvedValue([{ id: 't-orphan', userId: 'u1' }]);
    taskFindUniqueMock.mockResolvedValue({ id: 't-orphan', jobQueueId: null });

    await runDocTranslateTick();

    expect(taskFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PENDING',
          jobQueueId: null,
          updatedAt: { lt: expect.any(Date) },
        }),
      })
    );
    expect(createJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'doc_translate', params: { taskId: 't-orphan' } })
    );
  });
});

describe('reconcileProcessingJob — 清盘绑定代次 (L24)', () => {
  /** 让 tick 第一步（PROCESSING 对账）拿到一条绑在 job-old 上的调度行。 */
  function arrangeProcessingJob() {
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string } }) =>
        args?.where?.status === 'PROCESSING'
          ? [
              {
                id: 'job-old',
                startedAt: new Date(),
                attempt: 1,
                maxAttempts: 3,
                params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
              },
            ]
          : []
    );
  }

  it('任务已 CANCELED 且仍绑本代 → 停远端但保留 source 供正常 retry', async () => {
    arrangeProcessingJob();
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      status: 'CANCELED',
      jobQueueId: 'job-old',
      user: { role: 'PRO' },
    });

    await runDocTranslateTick();

    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      'job-old'
    );
  });

  it('任务已被 retry 换代（jobQueueId 指向新行）→ 绝不 rm -rf 源文件目录', async () => {
    arrangeProcessingJob();
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      // 用户「取消 → 重试」后本代读到的仍是 CANCELED 快照，但任务已绑到新一代
      status: 'CANCELED',
      jobQueueId: 'job-new',
      proxyGeneration: 'n'.repeat(64),
      workerId: 'w-new',
      user: { role: 'PRO' },
    });

    await runDocTranslateTick();

    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
    // legacy 旧行只能清它 params 中的旧 worker/job id，绝不借新任务绑定。
    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      'job-old'
    );
  });

  it('同一 JobQueue 行的旧 generation 对账只操作旧远端 id', async () => {
    const oldGeneration = '1'.repeat(64);
    const newGeneration = '2'.repeat(64);
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string } }) =>
        args.where?.status === 'PROCESSING'
          ? [
              {
                id: 'job-old',
                startedAt: new Date(Date.now() - 60_000),
                attempt: 1,
                maxAttempts: 3,
                params: JSON.stringify({
                  taskId: 't1',
                  workerId: 'w1',
                  proxyGeneration: oldGeneration,
                }),
              },
            ]
          : []
    );
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      status: 'TRANSLATING',
      jobQueueId: 'job-old',
      proxyGeneration: newGeneration,
      workerId: 'w1',
      user: { role: 'PRO' },
    });
    getTranslateJobMock.mockResolvedValue({
      status: 'failed',
      error: 'old generation failed',
    });

    await runDocTranslateTick();

    const oldRemoteId = translationRemoteJobId('job-old', oldGeneration);
    const newRemoteId = translationRemoteJobId('job-old', newGeneration);
    expect(getTranslateJobMock).not.toHaveBeenCalled();
    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      oldRemoteId
    );
    expect(deleteTranslateJobMock).not.toHaveBeenCalledWith(
      expect.anything(),
      newRemoteId
    );
  });

  it('Task 已发布但 JobQueue 尚 PROCESSING 的窗口只收敛 SUCCESS', async () => {
    const proxyGeneration = '3'.repeat(64);
    const params = JSON.stringify({
      taskId: 't1',
      workerId: 'w1',
      proxyGeneration,
    });
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string } }) =>
        args.where?.status === 'PROCESSING'
          ? [
              {
                id: 'job-old',
                startedAt: new Date(),
                attempt: 1,
                maxAttempts: 3,
                params,
              },
            ]
          : []
    );
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      status: 'COMPLETED',
      jobQueueId: 'job-old',
      proxyGeneration: null,
      workerId: 'w1',
      monoPath: 'translations/t1/outputs/winner/mono.pdf',
      dualPath: null,
      user: { role: 'PRO' },
    });

    await runDocTranslateTick();

    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'job-old',
          status: 'PROCESSING',
          params,
        },
        data: expect.objectContaining({ status: 'SUCCESS' }),
      })
    );
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'FAILED'
      )
    ).toBe(false);
    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      translationRemoteJobId('job-old', proxyGeneration)
    );
  });

  it('legacy progress 的 JobQueue 与 Task 写都绑定原 params/null generation', async () => {
    const params = JSON.stringify({ taskId: 't1', workerId: 'w1' });
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string } }) =>
        args.where?.status === 'PROCESSING'
          ? [
              {
                id: 'job-old',
                startedAt: new Date(),
                attempt: 1,
                maxAttempts: 3,
                params,
              },
            ]
          : []
    );
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      status: 'TRANSLATING',
      jobQueueId: 'job-old',
      proxyGeneration: null,
      workerId: 'w1',
      user: { role: 'PRO' },
    });
    getTranslateJobMock.mockResolvedValue({
      status: 'running',
      progress: 25,
      stage: 'translate',
    });

    await runDocTranslateTick();

    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-old', status: 'PROCESSING', params },
      })
    );
    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 't1',
          jobQueueId: 'job-old',
          proxyGeneration: null,
        }),
        data: { progress: 25 },
      })
    );
  });

  it('created 远端壳不会被当作 running，按精确 generation 删除并立即回炉', async () => {
    const proxyGeneration = '6'.repeat(64);
    const params = JSON.stringify({
      taskId: 't1',
      workerId: 'w1',
      proxyGeneration,
    });
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string } }) =>
        args.where?.status === 'PROCESSING'
          ? [{
              id: 'job-old',
              startedAt: new Date(),
              attempt: 1,
              maxAttempts: 3,
              params,
            }]
          : []
    );
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      status: 'TRANSLATING',
      jobQueueId: 'job-old',
      proxyGeneration,
      workerId: 'w1',
      user: { role: 'PRO' },
    });
    getTranslateJobMock.mockResolvedValue({ status: 'created' });

    await runDocTranslateTick();

    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      translationRemoteJobId('job-old', proxyGeneration)
    );
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-old',
          status: 'PROCESSING',
          params: { contains: `"proxyGeneration":"${proxyGeneration}"` },
        }),
        data: expect.objectContaining({ status: 'SUBMITTED' }),
      })
    );
  });

  it('legacy harvest 在原 params 已回炉后不得发布旧产物', async () => {
    const params = JSON.stringify({ taskId: 't1', workerId: 'w1' });
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string } }) =>
        args.where?.status === 'PROCESSING'
          ? [{
              id: 'job-old',
              startedAt: new Date(),
              attempt: 1,
              maxAttempts: 3,
              params,
            }]
          : []
    );
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      status: 'TRANSLATING',
      jobQueueId: 'job-old',
      proxyGeneration: null,
      workerId: 'w1',
      user: { role: 'PRO' },
    });
    getTranslateJobMock.mockResolvedValue({ status: 'succeeded' });
    downloadTranslateOutputMock.mockResolvedValue({ data: Buffer.from('old') });
    saveOutputFileMock.mockImplementation(
      async (taskId, variant, _data, attempt) =>
        `translations/${taskId}/outputs/${attempt}/${variant}.pdf`
    );
    jobUpdateManyMock.mockImplementation(async (args) =>
      args.where?.status === 'PROCESSING' &&
      args.where?.params === params &&
      args.data?.params === params
        ? { count: 0 }
        : { count: 1 }
    );

    await runDocTranslateTick();

    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'COMPLETED'
      )
    ).toBe(false);
    expect(deleteOutputGenerationMock).toHaveBeenCalledWith(
      't1',
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
  });
});

describe('translation proxy credential generation lifecycle (SEC-021)', () => {
  function arrangeSubmittedDispatch() {
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string }; select?: unknown }) => {
        if (args.where?.status === 'SUBMITTED') {
          return [
            {
              id: 'job-1',
              startedAt: null,
              attempt: 1,
              maxAttempts: 3,
              params: JSON.stringify({ taskId: 't1' }),
            },
          ];
        }
        return [];
      }
    );
    taskFindUniqueMock.mockImplementation(async () => {
      const claim = [...jobUpdateManyMock.mock.calls]
        .reverse()
        .find((call) => call[0]?.data?.status === 'PROCESSING');
      const claimedParams =
        typeof claim?.[0]?.data?.params === 'string'
          ? (JSON.parse(claim[0].data.params) as {
              proxyGeneration?: string;
            })
          : null;
      return {
        id: 't1',
        userId: 'u1',
        status: 'PENDING',
        sourceLang: 'en',
        targetLang: 'zh',
        glossaryJson: null,
        chargedCents: 100,
        refundedAt: null,
        pageCount: 1,
        modelId: 'm1',
        proxyGeneration: claimedParams?.proxyGeneration ?? null,
        workerId: claimedParams ? null : 'w-old',
        jobQueueId: 'job-1',
        user: { role: 'PRO', customGroupId: null },
      };
    });
  }

  it('凭据签发+TRANSLATING 带 jobQueueId CAS，并在 worker start 前落库', async () => {
    arrangeSubmittedDispatch();

    await runDocTranslateTick();

    const issueCallIndex = taskUpdateManyMock.mock.calls.findIndex(
      (call) => typeof call[0]?.data?.proxyTokenHash === 'string'
    );
    const issueCall = taskUpdateManyMock.mock.calls[issueCallIndex];
    const claimCallIndex = jobUpdateManyMock.mock.calls.findIndex(
      (call) => call[0]?.data?.status === 'PROCESSING'
    );
    const generationRevokeIndex = taskUpdateManyMock.mock.calls.findIndex(
      (call) =>
        call[0]?.data?.proxyTokenHash === null &&
        call[0]?.where?.jobQueueId === 'job-1'
    );
    const claimedParams = JSON.parse(
      jobUpdateManyMock.mock.calls[claimCallIndex][0].data.params
    ) as { proxyGeneration: string; remoteJobId: string };
    expect(issueCall?.[0]).toMatchObject({
      where: {
        id: 't1',
        jobQueueId: 'job-1',
        proxyGeneration: claimedParams.proxyGeneration,
        status: { in: ['PENDING', 'TRANSLATING'] },
      },
      data: {
        status: 'TRANSLATING',
        workerId: 'w1',
        errorMessage: null,
      },
    });
    expect(issueCall?.[0].data.proxyTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(claimedParams.proxyGeneration).toMatch(/^[a-f0-9]{64}$/);
    expect(claimedParams.remoteJobId).toBe(
      translationRemoteJobId('job-1', claimedParams.proxyGeneration)
    );
    expect(taskUpdateManyMock.mock.calls[generationRevokeIndex][0]).toMatchObject({
      data: {
        proxyTokenHash: null,
        proxyGeneration: claimedParams.proxyGeneration,
        workerId: null,
      },
    });
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) =>
          call[0]?.where?.params?.contains ===
          `"proxyGeneration":"${claimedParams.proxyGeneration}"`
      )
    ).toBe(true);
    expect(
      jobUpdateManyMock.mock.invocationCallOrder[claimCallIndex]
    ).toBeLessThan(
      taskUpdateManyMock.mock.invocationCallOrder[generationRevokeIndex]
    );
    expect(
      taskUpdateManyMock.mock.invocationCallOrder[generationRevokeIndex]
    ).toBeLessThan(
      taskUpdateManyMock.mock.invocationCallOrder[issueCallIndex]
    );
    expect(startTranslateJobMock).toHaveBeenCalledWith(
      expect.anything(),
      claimedParams.remoteJobId,
      expect.objectContaining({
        llm: expect.objectContaining({ apiKey: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      })
    );
    expect(
      taskUpdateManyMock.mock.invocationCallOrder[issueCallIndex]
    ).toBeLessThan(
      startTranslateJobMock.mock.invocationCallOrder[0]
    );
  });

  it('worker 429 回炉时先让调度行离开 PROCESSING，再按代次吊销 token', async () => {
    arrangeSubmittedDispatch();
    startTranslateJobMock.mockRejectedValue(
      new TranslateWorkerError('queue full', 429)
    );

    await runDocTranslateTick();

    const requeueCallIndex = jobUpdateManyMock.mock.calls.findIndex(
      (call) => call[0]?.data?.status === 'SUBMITTED'
    );
    const requeueCall = jobUpdateManyMock.mock.calls[requeueCallIndex];
    const revokeCallIndex = taskUpdateManyMock.mock.calls.findIndex(
      (call) =>
        call[0]?.data?.proxyTokenHash === null &&
        call[0]?.data?.proxyGeneration === null &&
        typeof call[0]?.where?.proxyGeneration === 'string'
    );
    const revokeCall = taskUpdateManyMock.mock.calls[revokeCallIndex];
    expect(requeueCall?.[0]).toMatchObject({
      where: { id: 'job-1', status: 'PROCESSING' },
    });
    expect(revokeCall?.[0].where).toMatchObject({
      id: 't1',
      jobQueueId: 'job-1',
      proxyGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      jobUpdateManyMock.mock.invocationCallOrder[requeueCallIndex]
    ).toBeLessThan(
      taskUpdateManyMock.mock.invocationCallOrder[revokeCallIndex]
    );
  });

  it('同一 JobQueue 行不同 generation 使用不同且合法的远端 job id', () => {
    const first = translationRemoteJobId('job-1', 'a'.repeat(64));
    const second = translationRemoteJobId('job-1', 'b'.repeat(64));

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(translationRemoteJobId('job-1', 'a'.repeat(64))).toBe(first);
  });

  it('start 已被远端接受但响应丢失时保留本代 token 和 PROCESSING 等待对账', async () => {
    arrangeSubmittedDispatch();
    startTranslateJobMock.mockRejectedValue(new Error('response lost'));

    await runDocTranslateTick();

    const issueCall = taskUpdateManyMock.mock.calls.find(
      (call) => typeof call[0]?.data?.proxyTokenHash === 'string'
    );
    const retainedParams = jobUpdateManyMock.mock.calls.find(
      (call) => {
        if (typeof call[0]?.data?.params !== 'string') return false;
        const params = JSON.parse(call[0].data.params) as {
          workerId?: string;
          dispatchState?: string;
        };
        return params.workerId === 'w1' && params.dispatchState === 'started';
      }
    );

    expect(startTranslateJobMock).toHaveBeenCalledTimes(1);
    expect(issueCall).toBeDefined();
    expect(retainedParams).toBeDefined();
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'FAILED'
      )
    ).toBe(false);
    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) =>
          call[0]?.data?.proxyTokenHash === null &&
          call[0]?.data?.proxyGeneration === null
      )
    ).toBe(false);
  });

  it('start 响应未知且绑定 params 写瞬断时也不得进入 failJob 吊销 token', async () => {
    arrangeSubmittedDispatch();
    startTranslateJobMock.mockRejectedValue(new Error('response lost'));
    jobUpdateManyMock.mockImplementation(async (args) => {
      if (typeof args.data?.params === 'string') {
        const params = JSON.parse(args.data.params) as {
          dispatchState?: string;
        };
        if (params.dispatchState === 'started') {
          throw new Error('params database unavailable');
        }
      }
      return { count: 1 };
    });

    await runDocTranslateTick();

    expect(startTranslateJobMock).toHaveBeenCalledTimes(1);
    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) => typeof call[0]?.data?.proxyTokenHash === 'string'
      )
    ).toBe(true);
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'FAILED'
      )
    ).toBe(false);
    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) =>
          call[0]?.data?.proxyTokenHash === null &&
          call[0]?.data?.proxyGeneration === null
      )
    ).toBe(false);
  });

  it('start 成功后绑定 params 写瞬断同样保留 token，不反向终结远端', async () => {
    arrangeSubmittedDispatch();
    jobUpdateManyMock.mockImplementation(async (args) => {
      if (typeof args.data?.params === 'string') {
        const params = JSON.parse(args.data.params) as {
          dispatchState?: string;
        };
        if (params.dispatchState === 'started') {
          throw new Error('params commit response lost');
        }
      }
      return { count: 1 };
    });

    await runDocTranslateTick();

    expect(startTranslateJobMock).toHaveBeenCalledTimes(1);
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'FAILED'
      )
    ).toBe(false);
    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) => typeof call[0]?.data?.proxyTokenHash === 'string'
      )
    ).toBe(true);
  });

  it('模型快照写失败且 readback 未确认时 provider worker 零启动', async () => {
    arrangeSubmittedDispatch();
    const loadTask = taskFindUniqueMock.getMockImplementation();
    taskFindUniqueMock.mockImplementation(async (...args) => ({
      ...((await loadTask?.(...args)) as Record<string, unknown>),
      modelId: null,
    }));
    taskUpdateManyMock.mockImplementation(async (args) => {
      if (args.data?.modelId) {
        throw new Error('model snapshot database unavailable');
      }
      return { count: 1 };
    });

    await runDocTranslateTick();

    expect(uploadTranslateInputMock).not.toHaveBeenCalled();
    expect(startTranslateJobMock).not.toHaveBeenCalled();
    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.modelId === 'm1'
      )
    ).toBe(true);
  });

  it('新代已抢占时，旧 dispatch 找回结果不能覆盖新 params 或启动 provider worker', async () => {
    arrangeSubmittedDispatch();
    getTranslateJobMock.mockResolvedValue({
      status: 'running',
      progress: 1,
      stage: 'translate',
    });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-1',
      attempt: 2,
      maxAttempts: 3,
      params: JSON.stringify({
        taskId: 't1',
        proxyGeneration: 'f'.repeat(64),
      }),
    });
    jobUpdateManyMock.mockImplementation(async (args) => {
      if (args.where?.status === 'SUBMITTED') return { count: 1 };
      // 模拟旧 dispatch 在远端查询期间被回炉并由新代抢占；所有旧 generation CAS 都失败。
      if (args.where?.params?.contains) return { count: 0 };
      return { count: 1 };
    });

    await runDocTranslateTick();

    expect(startTranslateJobMock).not.toHaveBeenCalled();
    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) => typeof call[0]?.data?.proxyTokenHash === 'string'
      )
    ).toBe(false);
    expect(
      taskUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'FAILED'
      )
    ).toBe(false);
  });

  it('新鲜 PROCESSING 代次尚未写 workerId 时保持 claim，不被另一 tick 回炉', async () => {
    const proxyGeneration = 'a'.repeat(64);
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string }; select?: unknown }) => {
        if (args.where?.status === 'PROCESSING' && !args.select) {
          return [
            {
              id: 'job-1',
              startedAt: new Date(),
              attempt: 1,
              maxAttempts: 3,
              params: JSON.stringify({ taskId: 't1', proxyGeneration }),
            },
          ];
        }
        return [];
      }
    );
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      userId: 'u1',
      status: 'PENDING',
      sourceLang: 'en',
      targetLang: 'zh',
      glossaryJson: null,
      chargedCents: 100,
      refundedAt: null,
      pageCount: 1,
      modelId: 'm1',
      proxyGeneration,
      workerId: 'w1',
      jobQueueId: 'job-1',
      user: { role: 'PRO', customGroupId: null },
    });

    await runDocTranslateTick();

    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'SUBMITTED'
      )
    ).toBe(false);
    expect(getTranslateJobMock).not.toHaveBeenCalled();
    expect(startTranslateJobMock).not.toHaveBeenCalled();
  });

  it('JobQueue 绑定写丢失后下一 tick 用 task.workerId 找回远端而不回炉', async () => {
    const proxyGeneration = 'b'.repeat(64);
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string }; select?: unknown }) => {
        if (args.where?.status === 'PROCESSING' && !args.select) {
          return [
            {
              id: 'job-1',
              startedAt: new Date(Date.now() - 13 * 60_000),
              attempt: 1,
              maxAttempts: 3,
              params: JSON.stringify({ taskId: 't1', proxyGeneration }),
            },
          ];
        }
        return [];
      }
    );
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      userId: 'u1',
      status: 'TRANSLATING',
      sourceLang: 'en',
      targetLang: 'zh',
      glossaryJson: null,
      chargedCents: 100,
      refundedAt: null,
      pageCount: 1,
      modelId: 'm1',
      proxyGeneration,
      workerId: 'w1',
      jobQueueId: 'job-1',
      user: { role: 'PRO', customGroupId: null },
    });
    getTranslateJobMock.mockResolvedValue({
      status: 'running',
      progress: 25,
      stage: 'translate',
    });

    await runDocTranslateTick();

    expect(getTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      translationRemoteJobId('job-1', proxyGeneration)
    );
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'SUBMITTED'
      )
    ).toBe(false);
  });

  function arrangeSucceededReconcile(proxyGeneration: string) {
    jobFindManyMock.mockImplementation(
      async (args: { where?: { status?: string }; select?: unknown }) => {
        if (args.where?.status === 'PROCESSING' && !args.select) {
          return [
            {
              id: 'job-old',
              startedAt: new Date(),
              attempt: 1,
              maxAttempts: 3,
              params: JSON.stringify({
                taskId: 't1',
                workerId: 'w1',
                proxyGeneration,
              }),
            },
          ];
        }
        return [];
      }
    );
    getTranslateJobMock.mockResolvedValue({ status: 'succeeded' });
    downloadTranslateOutputMock.mockImplementation(
      async (_worker, _jobId, variant: 'mono' | 'dual') => ({
        data: Buffer.from(`${variant}-old`),
      })
    );
    saveOutputFileMock.mockImplementation(
      async (
        taskId: string,
        variant: 'mono' | 'dual',
        _data: Buffer,
        generation: string
      ) => `translations/${taskId}/outputs/${generation}/${variant}.pdf`
    );
    return {
      id: 't1',
      userId: 'u1',
      status: 'TRANSLATING',
      sourceLang: 'en',
      targetLang: 'zh',
      glossaryJson: null,
      chargedCents: 100,
      refundedAt: null,
      pageCount: 1,
      modelId: 'm1',
      proxyGeneration,
      workerId: 'w1',
      jobQueueId: 'job-old',
      user: { role: 'PRO', customGroupId: null },
    };
  }

  it('旧代下载迟到时只清自己的 generation，不能覆盖新代已发布路径', async () => {
    const oldGeneration = 'c'.repeat(64);
    const oldTask = arrangeSucceededReconcile(oldGeneration);
    taskFindUniqueMock
      .mockResolvedValueOnce(oldTask)
      .mockResolvedValueOnce({
        status: 'COMPLETED',
        jobQueueId: 'job-new',
        proxyGeneration: null,
        monoPath: `translations/t1/outputs/${'d'.repeat(64)}/mono.pdf`,
        dualPath: `translations/t1/outputs/${'d'.repeat(64)}/dual.pdf`,
      });
    taskUpdateManyMock.mockImplementation(async (args) =>
      args.data?.status === 'COMPLETED' ? { count: 0 } : { count: 1 }
    );

    await runDocTranslateTick();

    const outputAttempt = saveOutputFileMock.mock.calls[0]?.[3] as string;
    expect(outputAttempt).toMatch(/^[a-f0-9]{64}$/);
    expect(outputAttempt).not.toBe(oldGeneration);
    expect(saveOutputFileMock).toHaveBeenCalledWith(
      't1',
      'mono',
      expect.any(Buffer),
      outputAttempt
    );
    expect(deleteOutputGenerationMock).toHaveBeenCalledWith(
      't1',
      outputAttempt
    );
    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'FAILED'
      )
    ).toBe(true);
  });

  it('同一 generation 的并行式重复 harvest 使用不同 attempt，loser 只清自己', async () => {
    const proxyGeneration = '4'.repeat(64);
    const task = arrangeSucceededReconcile(proxyGeneration);
    const newer = {
      status: 'COMPLETED',
      jobQueueId: 'job-new',
      proxyGeneration: null,
      monoPath: 'translations/t1/outputs/newer/mono.pdf',
      dualPath: 'translations/t1/outputs/newer/dual.pdf',
    };
    taskFindUniqueMock
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(newer)
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(newer);
    taskUpdateManyMock.mockImplementation(async (args) =>
      args.data?.status === 'COMPLETED' ? { count: 0 } : { count: 1 }
    );

    await runDocTranslateTick();
    globalThis.__docTranslateTickRun = undefined;
    await runDocTranslateTick();

    const attempts = saveOutputFileMock.mock.calls
      .filter((call) => call[1] === 'mono')
      .map((call) => call[3] as string);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(2);
    for (const attempt of attempts) {
      expect(deleteOutputGenerationMock).toHaveBeenCalledWith('t1', attempt);
    }
  });

  it('同 generation winner 已发布时 loser 收敛 SUCCESS，绝不把队列改 FAILED', async () => {
    const proxyGeneration = '5'.repeat(64);
    const task = arrangeSucceededReconcile(proxyGeneration);
    taskFindUniqueMock
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce({
        status: 'COMPLETED',
        jobQueueId: 'job-old',
        proxyGeneration: null,
        monoPath: 'translations/t1/outputs/winner/mono.pdf',
        dualPath: 'translations/t1/outputs/winner/dual.pdf',
      });
    jobFindUniqueMock.mockResolvedValue({
      status: 'PROCESSING',
      params: JSON.stringify({
        taskId: 't1',
        workerId: 'w1',
        proxyGeneration,
      }),
    });
    taskUpdateManyMock.mockImplementation(async (args) =>
      args.data?.status === 'COMPLETED' ? { count: 0 } : { count: 1 }
    );

    await runDocTranslateTick();

    const loserAttempt = saveOutputFileMock.mock.calls[0]?.[3] as string;
    expect(deleteOutputGenerationMock).toHaveBeenCalledWith(
      't1',
      loserAttempt
    );
    expect(
      jobUpdateManyMock.mock.calls.some(
        (call) => call[0]?.data?.status === 'FAILED'
      )
    ).toBe(false);
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-old',
          status: 'PROCESSING',
        }),
        data: expect.objectContaining({ status: 'SUCCESS' }),
      })
    );
  });

  it('产物 CAS 已提交但响应丢失时以 exact-path readback 为准并保留已发布 generation', async () => {
    const proxyGeneration = 'e'.repeat(64);
    const task = arrangeSucceededReconcile(proxyGeneration);
    taskFindUniqueMock
      .mockResolvedValueOnce(task)
      .mockImplementationOnce(async () => {
        const outputAttempt = saveOutputFileMock.mock.calls[0]?.[3] as string;
        return {
          status: 'COMPLETED',
          jobQueueId: 'job-old',
          proxyGeneration: null,
          monoPath: `translations/t1/outputs/${outputAttempt}/mono.pdf`,
          dualPath: `translations/t1/outputs/${outputAttempt}/dual.pdf`,
        };
      });
    taskUpdateManyMock.mockRejectedValueOnce(new Error('commit response lost'));

    await runDocTranslateTick();

    expect(deleteOutputGenerationMock).not.toHaveBeenCalled();
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'job-old', status: 'PROCESSING' }),
        data: expect.objectContaining({ status: 'SUCCESS' }),
      })
    );
  });
});
