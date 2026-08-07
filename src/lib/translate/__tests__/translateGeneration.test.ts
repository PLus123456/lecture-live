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
  deleteTaskFilesMock,
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
  deleteTaskFilesMock: vi.fn(),
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
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: vi.fn() }));
vi.mock('@/lib/userRoles', () => ({ resolveUserTranslationModelId: vi.fn() }));
vi.mock('@/lib/llm/summaryModel', () => ({ resolveGroupBoundModel: vi.fn() }));
vi.mock('@/lib/translate/workerClient', () => ({
  getTranslateFleetConfig: getTranslateFleetConfigMock,
  pingTranslateWorker: vi.fn(),
  uploadTranslateInput: vi.fn(),
  startTranslateJob: vi.fn(),
  getTranslateJob: vi.fn(),
  downloadTranslateOutput: vi.fn(),
  deleteTranslateJob: deleteTranslateJobMock,
  buildWorkerModelLabel: vi.fn(() => 'mock-model'),
  TranslateWorkerError: class extends Error {},
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  readSourceFile: vi.fn(),
  saveOutputFile: vi.fn(),
  deleteTaskFiles: deleteTaskFilesMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (e: unknown) => e,
}));

import {
  enqueueDocTranslate,
  runDocTranslateTick,
} from '@/lib/translate/translateProcessor';

const FLEET = {
  workers: [{ id: 'w1', baseUrl: 'http://w1', concurrency: 2, weight: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__docTranslateTickRun = undefined;
  transactionMock.mockImplementation((cb: (tx: unknown) => unknown) =>
    typeof cb === 'function' ? cb({}) : undefined
  );
  getTranslateFleetConfigMock.mockResolvedValue(FLEET);
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

  it('任务已 CANCELED 且仍绑本代 → 清盘', async () => {
    arrangeProcessingJob();
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      status: 'CANCELED',
      jobQueueId: 'job-old',
      user: { role: 'PRO' },
    });

    await runDocTranslateTick();

    expect(deleteTaskFilesMock).toHaveBeenCalledWith('t1');
  });

  it('任务已被 retry 换代（jobQueueId 指向新行）→ 绝不 rm -rf 源文件目录', async () => {
    arrangeProcessingJob();
    taskFindUniqueMock.mockResolvedValue({
      id: 't1',
      // 用户「取消 → 重试」后本代读到的仍是 CANCELED 快照，但任务已绑到新一代
      status: 'CANCELED',
      jobQueueId: 'job-new',
      user: { role: 'PRO' },
    });

    await runDocTranslateTick();

    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
  });
});
