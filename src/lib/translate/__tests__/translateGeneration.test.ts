// L23 / L24：翻译调度的「代次绑定」与「孤儿任务补入队」。
// 另含 #236 的任务级绝对死线、H5 断链任务自愈、以及生存期常量的跨模块不变量
//（这三块在 824e27f 合并 main 时曾被整段丢弃，此处按当前 harness 口径补回）。
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
  refundWalletCentsMock,
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
  refundWalletCentsMock: vi.fn(),
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
vi.mock('@/lib/wallet', () => ({ refundWalletCents: refundWalletCentsMock }));
// failJob 终态路径的 fire-and-forget 通知：mock 掉避免动态 import 真模块产生杂散 IO。
vi.mock('@/lib/translate/notify', () => ({
  sendDocTranslateNotification: vi.fn(async () => undefined),
}));
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
  jobFindUniqueMock.mockResolvedValue(null);
  taskFindManyMock.mockResolvedValue([]);
  taskUpdateManyMock.mockResolvedValue({ count: 1 });
  taskFindUniqueMock.mockResolvedValue(null);
  createJobMock.mockResolvedValue('job-new');
  refundWalletCentsMock.mockResolvedValue(undefined);
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

/**
 * executeTick 里有三条 translationTask.findMany，必须按 where 精确区分，否则一条 mock 会
 * 同时喂给三个扫描（死线扫描尤其会拿到没有 createdAt 的替身行而在内部抛错，
 * 被外层 catch 吞掉 → 用例照样绿，等于把新逻辑测没了）。
 *   死线扫描：where.createdAt 存在
 *   H5 断链：where.updatedAt 存在（且无 createdAt；本树的断链扫描带 ORPHAN_TASK_GRACE_MS 宽限）
 *   L23 孤儿：where.jobQueueId === null
 */
type TaskFindManyArgs = {
  where?: { jobQueueId?: unknown; createdAt?: unknown; updatedAt?: unknown };
};
const isDeadlineScan = (args: TaskFindManyArgs) => Boolean(args?.where?.createdAt);
const isStrandedScan = (args: TaskFindManyArgs) =>
  Boolean(args?.where?.updatedAt) && !args?.where?.createdAt;

/** 从 taskUpdateMany 的全部调用里挑出满足条件的那一次 */
function findTaskUpdate(
  predicate: (call: { where: Record<string, unknown>; data: Record<string, unknown> }) => boolean
) {
  return taskUpdateManyMock.mock.calls
    .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
    .find(predicate);
}

/** 从 jobQueue.updateMany 的全部调用里挑出终态 FAILED 那一次（failJob 的 job 行写走 updateMany） */
function findJobFailedWrite() {
  return jobUpdateManyMock.mock.calls
    .map(([args]) => args as { where: Record<string, unknown>; data: { status?: string; params?: string } })
    .find((a) => a.data?.status === 'FAILED');
}

/**
 * 给 refundTaskCharge 一个**能真正跑完**的事务替身。
 *
 * 全局 beforeEach 的替身没有 translationTask.findUnique —— 退款体第二步就 TypeError，
 * 被 refundTaskCharge 自己的 try/catch 吞掉。于是「断言 transactionMock 被调用过」这种写法
 * 看起来在测退款，其实退款一步都没执行。这里换成有内容的替身，让 refundWalletCents 真的
 * 被调到，并把认领谓词捞出来核对 L24 代次令牌。
 */
function arrangeRefundTx() {
  const claims: { where: Record<string, unknown> }[] = [];
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      translationTask: {
        updateMany: async (args: { where: Record<string, unknown> }) => {
          claims.push(args);
          return { count: 1 };
        },
        findUnique: async () => ({ userId: 'u1', chargedCents: 500 }),
      },
    })
  );
  return claims;
}

// H5 的跨模块不变式：僵尸回收阈值必须严格大于本模块承诺的最大运行时。
// 这两个常量当初就是各改各的漂移开的（jobQueue 2h < translateProcessor 3h）。
describe('僵尸回收阈值 vs 合法最大运行时 (H5)', () => {
  it('doc_translate 的回收阈值必须严格大于 MAX_WORKER_RUNTIME_MS', async () => {
    const jobQueue = await vi.importActual<typeof import('@/lib/jobQueue')>('@/lib/jobQueue');
    const processor = await import('@/lib/translate/translateProcessor');
    expect(
      jobQueue.STALE_PROCESSING_THRESHOLD_BY_TYPE[jobQueue.JOB_TYPE.DOC_TRANSLATE]
    ).toBeGreaterThan(processor.MAX_WORKER_RUNTIME_MS);
  });

  // 任务级死线同理：它必须是三者里最外层的那一圈，否则会在任务还合法在跑时
  // 把它打成终态 + 退款（比 H5 的误杀更糟 —— 那至少不退钱）。
  it('MAX_TASK_LIFETIME_MS > 僵尸回收阈值 > MAX_WORKER_RUNTIME_MS', async () => {
    const jobQueue = await vi.importActual<typeof import('@/lib/jobQueue')>('@/lib/jobQueue');
    const processor = await import('@/lib/translate/translateProcessor');
    const reclaim =
      jobQueue.STALE_PROCESSING_THRESHOLD_BY_TYPE[jobQueue.JOB_TYPE.DOC_TRANSLATE];

    expect(processor.MAX_TASK_LIFETIME_MS).toBeGreaterThan(reclaim);
    expect(reclaim).toBeGreaterThan(processor.MAX_WORKER_RUNTIME_MS);
    // 还要盖得住一条完整的合法重试链：3 次派发 × 3h + 退避 (5+20+45min)。
    const legalWorstCase = 3 * processor.MAX_WORKER_RUNTIME_MS + (5 + 20 + 45) * 60_000;
    expect(processor.MAX_TASK_LIFETIME_MS).toBeGreaterThan(legalWorstCase);
  });
});

// ─── 任务级绝对死线（#236） ──────────────────────────────────────────────────
// MAX_WORKER_RUNTIME_MS 是「每一次派发」的预算而非任务总预算：job.startedAt 在每次回炉
// SUBMITTED 时都被清空。整个机队长期不可达时任务就在 SUBMITTED ↔ PROCESSING 之间
// 无限弹跳、永不终态 —— 用户永远看到「翻译中」，chargedCents 一直押着不退。
describe('executeTick — 任务级绝对死线', () => {
  const DAY = 24 * 60 * 60_000;
  /** 让死线扫描（且只让它）拿到一行任务 */
  function arrangeDeadlineCandidate(row: Record<string, unknown>) {
    taskFindManyMock.mockImplementation(async (args: TaskFindManyArgs) =>
      isDeadlineScan(args) ? [row] : []
    );
  }

  it('★ 超过死线：走 failJob(retryable:false) → 任务终态 FAILED + 退款 + 不排自动重试', async () => {
    const old = new Date(Date.now() - 3 * DAY);
    arrangeDeadlineCandidate({ id: 't1', jobQueueId: 'job-stuck', createdAt: old });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-stuck',
      type: 'doc_translate',
      status: 'SUBMITTED', // 弹跳态：既不是 PROCESSING 也没排重试
      params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
      attempt: 1,
      maxAttempts: 3,
      createdAt: old,
    });
    const refundClaims = arrangeRefundTx();

    await runDocTranslateTick();

    // 任务被打成终态，且带 L24 代次谓词
    const failWrite = findTaskUpdate((c) => c.data?.status === 'FAILED');
    expect(failWrite).toBeDefined();
    expect(failWrite!.where).toEqual(
      expect.objectContaining({ id: 't1', jobQueueId: 'job-stuck' })
    );
    // ★ 退款 —— 释放押着的钱正是这条死线的全部意义
    expect(refundWalletCentsMock).toHaveBeenCalledTimes(1);
    expect(refundWalletCentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        amountCents: 500,
        type: 'translation_refund',
      }),
      expect.anything()
    );
    // 退款认领同样带 L24 代次谓词（幂等闸 refundedAt: null 也要在）
    expect(refundClaims[0]?.where).toEqual(
      expect.objectContaining({ id: 't1', jobQueueId: 'job-stuck', refundedAt: null })
    );
    // retryable:false ⇒ params 不写 nextRetryAt，到期重试那一圈捞不回它
    const jobWrite = findJobFailedWrite();
    expect(jobWrite).toBeDefined();
    expect(JSON.parse(jobWrite!.data.params ?? '{}')).not.toHaveProperty('nextRetryAt');
  });

  it('未到死线：一律不动（合法长跑任务绝不能被误杀退款）', async () => {
    const recent = new Date(Date.now() - 60 * 60_000); // 1h
    arrangeDeadlineCandidate({ id: 't1', jobQueueId: 'job-live', createdAt: recent });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-live',
      type: 'doc_translate',
      status: 'PROCESSING',
      params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
      attempt: 1,
      maxAttempts: 3,
      createdAt: recent,
    });

    await runDocTranslateTick();

    expect(findTaskUpdate((c) => c.data?.status === 'FAILED')).toBeUndefined();
    expect(refundWalletCentsMock).not.toHaveBeenCalled();
  });

  it('★ 用户刚重试过（任务行老、本代调度行新）：放行，不当场打死', async () => {
    // retry 复用同一个 TranslationTask（createdAt 不变）但换一条全新调度行。
    // 若锚点只看任务 createdAt，隔天来点一次重试会被当场终止 —— 钱虽退了，重试等于不可用。
    arrangeDeadlineCandidate({
      id: 't1',
      jobQueueId: 'job-fresh',
      createdAt: new Date(Date.now() - 3 * DAY),
    });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-fresh',
      type: 'doc_translate',
      status: 'SUBMITTED',
      params: JSON.stringify({ taskId: 't1' }),
      attempt: 1,
      maxAttempts: 3,
      createdAt: new Date(Date.now() - 60_000), // 一分钟前刚重试
    });

    await runDocTranslateTick();

    expect(findTaskUpdate((c) => c.data?.status === 'FAILED')).toBeUndefined();
    expect(refundWalletCentsMock).not.toHaveBeenCalled();
  });

  it('★ 机队被停用（getTranslateFleetConfig → null）时死线仍然生效', async () => {
    // 这是任务永久挂起最彻底的一种形态：executeTick 在 `if (!fleet)` 处直接早退。
    // 死线判定若排在早退之后就永远够不着它。
    getTranslateFleetConfigMock.mockResolvedValue(null);
    const old = new Date(Date.now() - 3 * DAY);
    arrangeDeadlineCandidate({ id: 't1', jobQueueId: 'job-stuck', createdAt: old });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-stuck',
      type: 'doc_translate',
      status: 'SUBMITTED',
      params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
      attempt: 1,
      maxAttempts: 3,
      createdAt: old,
    });
    arrangeRefundTx();

    await runDocTranslateTick();

    expect(findTaskUpdate((c) => c.data?.status === 'FAILED')).toBeDefined();
    expect(refundWalletCentsMock).toHaveBeenCalledTimes(1);
    // 机队没了自然连不上 worker，但不能因此卡住结算
    expect(deleteTranslateJobMock).not.toHaveBeenCalled();
  });

  it('扫描 where 必须同时带三个条件（非终态 + 过期 + 有代次令牌）', async () => {
    arrangeDeadlineCandidate({ id: 't1', jobQueueId: 'j', createdAt: new Date(0) });
    jobFindUniqueMock.mockResolvedValue(null);

    await runDocTranslateTick();

    const call = taskFindManyMock.mock.calls
      .map(([a]) => a as { where: Record<string, unknown> })
      .find((a) => isDeadlineScan(a));
    expect(call!.where).toEqual(
      expect.objectContaining({
        status: { in: ['PENDING', 'TRANSLATING'] },
        jobQueueId: { not: null },
        createdAt: { lt: expect.any(Date) },
      })
    );
  });
});

describe('executeTick — 断链任务自愈 (H5)', () => {
  /** 让断链扫描（且只让它）拿到一行任务 */
  function arrangeStrandedCandidate(row: Record<string, unknown>) {
    taskFindManyMock.mockImplementation(async (args: TaskFindManyArgs) =>
      isStrandedScan(args) ? [row] : []
    );
  }

  it('调度行被僵尸回收直改成 FAILED（绕过 failJob）→ 补做结算：任务终态 + 退款', async () => {
    arrangeStrandedCandidate({ id: 't1', jobQueueId: 'job-zombie' });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-zombie',
      type: 'doc_translate',
      status: 'FAILED',
      // 僵尸回收不写 nextRetryAt —— 这正是任务永久卡死的原因
      params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
      attempt: 3,
      maxAttempts: 3,
    });
    arrangeRefundTx();

    await runDocTranslateTick();

    const failWrite = findTaskUpdate((c) => c.data?.status === 'FAILED');
    expect(failWrite).toBeDefined();
    expect(failWrite!.where).toEqual(
      expect.objectContaining({ id: 't1', jobQueueId: 'job-zombie' })
    );
    // 退款必须真的跑到钱包入账，不能只看事务被调过
    expect(refundWalletCentsMock).toHaveBeenCalledTimes(1);
  });

  it('调度行还在途（SUBMITTED/PROCESSING）→ 不动它', async () => {
    arrangeStrandedCandidate({ id: 't1', jobQueueId: 'job-live' });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-live',
      type: 'doc_translate',
      status: 'SUBMITTED',
      params: JSON.stringify({ taskId: 't1' }),
      attempt: 1,
      maxAttempts: 3,
    });

    await runDocTranslateTick();

    expect(findTaskUpdate((c) => c.data?.status === 'FAILED')).toBeUndefined();
    // 在途的 job 行一个字也不许动（重复 failJob 会顺延退避、白烧 attempt）
    expect(findJobFailedWrite()).toBeUndefined();
  });

  it('已排定自动重试（nextRetryAt 在）→ 交给退避回炉，不重复结算', async () => {
    arrangeStrandedCandidate({ id: 't1', jobQueueId: 'job-retry' });
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-retry',
      type: 'doc_translate',
      status: 'FAILED',
      params: JSON.stringify({
        taskId: 't1',
        nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      attempt: 1,
      maxAttempts: 3,
    });

    await runDocTranslateTick();

    expect(findTaskUpdate((c) => c.data?.status === 'FAILED')).toBeUndefined();
    // 仅断言「task 没被打 FAILED」杀不死这条保护：attempt 未用光时重复 failJob 走的是
    // canRetry 分支，task 本来就不写 FAILED，但 job 行会被重写、nextRetryAt 被一 tick
    // 一次地顺延 —— 排定的重试永远到不了期。必须钉住 job 行零重写。
    expect(findJobFailedWrite()).toBeUndefined();
  });
});
