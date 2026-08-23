// L23 / L24 / H4 / H5 / H6 / M11 / M12 / M13 / L28：翻译调度的「代次谓词」与「回收链路」。
//
// 代次不变式（见 translateProcessor.ts 文件头）：TranslationTask.jobQueueId 指向当前这一代
// 调度行；调度器里所有对 task 的写、以及所有对任务目录的 rm -rf，都必须带
// `jobQueueId: <自己的 jobId>` 谓词。漏一处，上一代的迟到逻辑就会打死新一代。
//
// L24：用户 retry 会把任务重置回 PENDING + 重新扣一次费 + 换一条新调度行。
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
  getTranslateJobMock,
  downloadTranslateOutputMock,
  saveOutputFileMock,
  readSourceFileMock,
  uploadTranslateInputMock,
  startTranslateJobMock,
  pingTranslateWorkerMock,
  refundWalletCentsMock,
  MockWorkerError,
} = vi.hoisted(() => {
  class MockWorkerError extends Error {
    constructor(
      readonly status: number,
      message = `worker error ${status}`
    ) {
      super(message);
      this.name = 'TranslateWorkerError';
    }
  }
  return {
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
    getTranslateJobMock: vi.fn(),
    downloadTranslateOutputMock: vi.fn(),
    saveOutputFileMock: vi.fn(),
    readSourceFileMock: vi.fn(),
    uploadTranslateInputMock: vi.fn(),
    startTranslateJobMock: vi.fn(),
    pingTranslateWorkerMock: vi.fn(),
    refundWalletCentsMock: vi.fn(),
    MockWorkerError,
  };
});

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
vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: vi.fn(async () => ({ site_url: 'http://app.test' })),
}));
vi.mock('@/lib/userRoles', () => ({
  resolveUserTranslationModelId: vi.fn(async () => null),
}));
vi.mock('@/lib/llm/summaryModel', () => ({
  resolveGroupBoundModel: vi.fn(async () => null),
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
  TranslateWorkerError: MockWorkerError,
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  readSourceFile: readSourceFileMock,
  saveOutputFile: saveOutputFileMock,
  deleteTaskFiles: deleteTaskFilesMock,
}));
vi.mock('@/lib/translate/notify', () => ({
  sendDocTranslateNotification: vi.fn(async () => undefined),
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
  watermark: false,
  workers: [
    { id: 'w1', name: 'w1', baseUrl: 'http://w1', concurrency: 2, weight: 1, qps: 4 },
    { id: 'w2', name: 'w2', baseUrl: 'http://w2', concurrency: 2, weight: 1, qps: 4 },
  ],
};

/** loadTask 的 select 里有 sourceLang；stillOwnedByGeneration / enqueue 只 select jobQueueId */
function isFullTaskRead(args: { select?: Record<string, unknown> }): boolean {
  return Boolean(args?.select?.sourceLang);
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    userId: 'u1',
    status: 'TRANSLATING',
    sourceLang: 'en',
    targetLang: 'zh',
    glossaryJson: null,
    chargedCents: 500,
    refundedAt: null,
    pageCount: 10,
    modelId: 'm1',
    jobQueueId: 'job-old',
    user: { role: 'PRO', customGroupId: null },
    ...overrides,
  };
}

/**
 * 编排 taskFindUnique：完整读（loadTask）返回 `full`；
 * 只读代次的那些调用（stillOwnedByGeneration）按 `generationReads` 依次返回，用尽后取最后一个。
 */
function arrangeTaskReads(
  full: Record<string, unknown> | null,
  generationReads: (string | null)[] = []
) {
  let genIndex = 0;
  taskFindUniqueMock.mockImplementation(async (args: { select?: Record<string, unknown> }) => {
    if (isFullTaskRead(args)) return full;
    const value =
      generationReads.length === 0
        ? ((full?.jobQueueId as string | null) ?? null)
        : generationReads[Math.min(genIndex++, generationReads.length - 1)];
    return { jobQueueId: value };
  });
}

/** 让 tick 第一步（PROCESSING 对账）拿到一条调度行 */
function arrangeProcessingJob(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'job-old',
    startedAt: new Date(),
    attempt: 1,
    maxAttempts: 3,
    params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
    ...overrides,
  };
  jobFindManyMock.mockImplementation(
    async (args: { where?: { status?: string }; select?: unknown }) =>
      args?.where?.status === 'PROCESSING' && !args.select ? [row] : []
  );
  return row;
}

/** 让 tick 第三步（派发）拿到一条 SUBMITTED 行 */
function arrangeSubmittedJob(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'job-old',
    startedAt: null,
    attempt: 1,
    maxAttempts: 3,
    params: JSON.stringify({ taskId: 't1' }),
    ...overrides,
  };
  jobFindManyMock.mockImplementation(
    async (args: { where?: { status?: string } }) =>
      args?.where?.status === 'SUBMITTED' ? [row] : []
  );
  return row;
}

/**
 * executeTick 里有三条 translationTask.findMany，必须按 where 精确区分，否则一条 mock 会
 * 同时喂给三个扫描（新增的死线扫描尤其会拿到没有 createdAt 的替身行而在内部抛错，
 * 被外层 catch 吞掉 → 用例照样绿，等于把新逻辑测没了）。
 *   死线扫描：where.createdAt 存在
 *   H5 断链：where.jobQueueId = { not: null }（无 createdAt）
 *   L23 孤儿：where.jobQueueId === null
 */
type TaskFindManyArgs = { where?: { jobQueueId?: unknown; createdAt?: unknown } };
const isDeadlineScan = (args: TaskFindManyArgs) => Boolean(args?.where?.createdAt);
const isOrphanScan = (args: TaskFindManyArgs) => args?.where?.jobQueueId === null;

/** 从 taskUpdateMany 的全部调用里挑出满足条件的那一次 */
function findTaskUpdate(predicate: (call: { where: Record<string, unknown>; data: Record<string, unknown> }) => boolean) {
  return taskUpdateManyMock.mock.calls
    .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
    .find(predicate);
}

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
  jobFindUniqueMock.mockResolvedValue(null);
  taskFindManyMock.mockResolvedValue([]);
  taskUpdateManyMock.mockResolvedValue({ count: 1 });
  taskFindUniqueMock.mockResolvedValue(null);
  createJobMock.mockResolvedValue('job-new');
  // 被 `.catch(...)` 链式调用的 mock 必须返回 Promise，否则 undefined.catch 抛 TypeError
  // 并被对账的外层 catch 吞掉，测试会静默通过（假绿）。
  deleteTranslateJobMock.mockResolvedValue(undefined);
  deleteTaskFilesMock.mockResolvedValue(undefined);
  getTranslateJobMock.mockResolvedValue({ status: 'running', progress: 10, stage: 'translate' });
  downloadTranslateOutputMock.mockResolvedValue({ data: Buffer.from('pdf') });
  saveOutputFileMock.mockImplementation(async (_id: string, variant: string) => `translations/t1/${variant}.pdf`);
  readSourceFileMock.mockResolvedValue(Buffer.from('source'));
  uploadTranslateInputMock.mockResolvedValue(undefined);
  startTranslateJobMock.mockResolvedValue(undefined);
  pingTranslateWorkerMock.mockResolvedValue({ ok: true, queue: { running: 0, queued: 0 } });
  refundWalletCentsMock.mockResolvedValue(undefined);
});

describe('enqueueDocTranslate — 孤儿调度行回收 (L23) 与绑定 CAS (M11)', () => {
  it('任务已不在 PENDING（并发取消/删除）→ 刚建的调度行就地终态，不留在 SUBMITTED 占派发槽', async () => {
    arrangeTaskReads(null, [null]);
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

  // M11：两个进程的孤儿扫描可能同时捞到同一条 jobQueueId=null 的任务，各自 createJob。
  // 只按 status 绑定的话两次都会成功 → 同一份 PDF 翻两遍 + proxyToken 互相覆盖。
  it('绑定必须对读到的代次令牌做 CAS（jobQueueId 进 where），而不是只看 status', async () => {
    taskFindUniqueMock.mockResolvedValue({ id: 't1', jobQueueId: null });
    taskUpdateManyMock.mockResolvedValue({ count: 1 });

    await enqueueDocTranslate('t1', 'u1');

    expect(taskUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 't1', status: 'PENDING', jobQueueId: null },
      data: { jobQueueId: 'job-new' },
    });
  });

  it('复用已终态旧调度行的任务：CAS 谓词用读到的那个旧 id，不是写死 null', async () => {
    taskFindUniqueMock.mockResolvedValue({ id: 't1', jobQueueId: 'job-dead' });
    jobFindUniqueMock.mockResolvedValue({ id: 'job-dead', status: 'FAILED' });
    taskUpdateManyMock.mockResolvedValue({ count: 1 });

    await enqueueDocTranslate('t1', 'u1');

    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jobQueueId: 'job-dead' }),
      })
    );
  });
});

describe('runDocTranslateTick — 孤儿任务补入队 (L23)', () => {
  it('PENDING 且 jobQueueId=null 且过了宽限期 → 补建调度行', async () => {
    taskFindManyMock.mockImplementation(async (args: { where?: { jobQueueId?: unknown } }) =>
      args?.where?.jobQueueId === null ? [{ id: 't-orphan', userId: 'u1' }] : []
    );
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
  it('任务已 CANCELED 且仍绑本代 → 清盘', async () => {
    arrangeProcessingJob();
    arrangeTaskReads(taskRow({ status: 'CANCELED', jobQueueId: 'job-old' }), ['job-old']);

    await runDocTranslateTick();

    expect(deleteTaskFilesMock).toHaveBeenCalledWith('t1');
  });

  it('任务已被 retry 换代（jobQueueId 指向新行）→ 绝不 rm -rf 源文件目录', async () => {
    arrangeProcessingJob();
    // 用户「取消 → 重试」后本代读到的仍是 CANCELED 快照，但任务已绑到新一代
    arrangeTaskReads(taskRow({ status: 'CANCELED', jobQueueId: 'job-new' }), ['job-new']);

    await runDocTranslateTick();

    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
  });

  // L24 的 TOCTOU：快照说「还是我的」，但 deleteTranslateJob 那一趟网络往返之后，
  // 用户已经 retry 完了。清盘前必须重读，不能信快照。
  it('快照仍绑本代、但清盘前重读已换代 → 不删（重读优先于快照）', async () => {
    arrangeProcessingJob();
    arrangeTaskReads(taskRow({ status: 'CANCELED', jobQueueId: 'job-old' }), ['job-new']);

    await runDocTranslateTick();

    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
  });
});

describe('reconcileProcessingJob — 代次门与进度回写 (M13)', () => {
  it('进度回写必须带 jobQueueId 谓词，否则旧代低进度会盖掉新代真实进度', async () => {
    arrangeProcessingJob();
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-old' }));
    getTranslateJobMock.mockResolvedValue({ status: 'running', progress: 42, stage: 'translate' });

    await runDocTranslateTick();

    const progressWrite = findTaskUpdate((c) => c.data?.progress === 42);
    expect(progressWrite).toBeDefined();
    expect(progressWrite!.where).toEqual({
      id: 't1',
      jobQueueId: 'job-old',
      status: 'TRANSLATING',
    });
  });

  it('任务已改嫁新一代 → 停止对账、终态化本代调度行，一个字都不写 task', async () => {
    arrangeProcessingJob();
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-new' }));

    await runDocTranslateTick();

    expect(getTranslateJobMock).not.toHaveBeenCalled();
    expect(taskUpdateManyMock).not.toHaveBeenCalled();
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-old', status: { in: ['SUBMITTED', 'PROCESSING'] } },
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );
  });
});

describe('reconcileProcessingJob — worker 不可达时的超时与重派 (H6)', () => {
  it('超过 MAX_WORKER_RUNTIME_MS：不依赖拿到 remote 状态，入口直接判超时并走 failJob', async () => {
    arrangeProcessingJob({ startedAt: new Date(Date.now() - 4 * 60 * 60_000) });
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-old' }));
    // worker 断电：非 404 的连接错误
    getTranslateJobMock.mockRejectedValue(new Error('ECONNREFUSED'));
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-old',
      attempt: 3,
      maxAttempts: 3,
      params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
    });

    await runDocTranslateTick();

    // 超时判定在接触 worker 之前
    expect(getTranslateJobMock).not.toHaveBeenCalled();
    // 走的是 failJob：调度行终态 + 任务带代次谓词写 FAILED + 退款
    expect(jobUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-old' },
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );
    const failWrite = findTaskUpdate((c) => c.data?.status === 'FAILED');
    expect(failWrite).toBeDefined();
    expect(failWrite!.where).toEqual(
      expect.objectContaining({ id: 't1', jobQueueId: 'job-old' })
    );
  });

  it('绑定台首次不可达 → 记 unreachableSince，不解绑（给短暂抖动留余地）', async () => {
    arrangeProcessingJob();
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-old' }));
    getTranslateJobMock.mockRejectedValue(new Error('ETIMEDOUT'));

    await runDocTranslateTick();

    const paramsWrite = jobUpdateMock.mock.calls
      .map(([args]) => args as { data: { params?: string } })
      .find((c) => typeof c.data?.params === 'string');
    expect(paramsWrite).toBeDefined();
    expect(JSON.parse(paramsWrite!.data.params!).unreachableSince).toEqual(expect.any(String));
    expect(jobUpdateManyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUBMITTED' }) })
    );
  });

  it('绑定台持续不可达超过阈值 → 解绑回炉 SUBMITTED，让 pickWorker 换台', async () => {
    arrangeProcessingJob({
      params: JSON.stringify({
        taskId: 't1',
        workerId: 'w1',
        unreachableSince: new Date(Date.now() - 30 * 60_000).toISOString(),
      }),
    });
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-old' }));
    getTranslateJobMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await runDocTranslateTick();

    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-old', status: 'PROCESSING' },
        data: { status: 'SUBMITTED', startedAt: null },
      })
    );
    const paramsWrite = jobUpdateMock.mock.calls
      .map(([args]) => args as { data: { params?: string } })
      .find((c) => typeof c.data?.params === 'string');
    expect(JSON.parse(paramsWrite!.data.params!).workerId).toBeUndefined();
  });
});

describe('harvestJob — 收割代次谓词 (H4)', () => {
  it('收割回写必须带 jobQueueId 谓词', async () => {
    arrangeProcessingJob();
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-old' }), ['job-old']);
    getTranslateJobMock.mockResolvedValue({ status: 'succeeded', progress: 100, stage: null });

    await runDocTranslateTick();

    const completeWrite = findTaskUpdate((c) => c.data?.status === 'COMPLETED');
    expect(completeWrite).toBeDefined();
    expect(completeWrite!.where).toEqual({
      id: 't1',
      jobQueueId: 'job-old',
      status: { in: ['PENDING', 'TRANSLATING'] },
    });
  });

  // H4 主链路：旧代迟到收割绝不能把新一代标 COMPLETED（否则新代收割 count===0 会 rm -rf 产物）
  it('下载期间用户 retry 换代 → 不落盘、不把新一代标 COMPLETED', async () => {
    arrangeProcessingJob();
    // loadTask 快照仍是本代（代次门放行），但下载完成后重读已经是新一代
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-old' }), ['job-new']);
    getTranslateJobMock.mockResolvedValue({ status: 'succeeded', progress: 100, stage: null });

    await runDocTranslateTick();

    expect(saveOutputFileMock).not.toHaveBeenCalled();
    expect(findTaskUpdate((c) => c.data?.status === 'COMPLETED')).toBeUndefined();
    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
  });

  // H4 的另一半：count===0 的清盘分支不能用过期快照判「还是我的」
  it('收割回写 count===0 且重读已换代 → 绝不 rm -rf 任务目录', async () => {
    arrangeProcessingJob();
    // 第 1 次代次重读（落盘前）仍是本代 → 允许落盘；第 2 次（回写落空后）已换代 → 禁止清盘
    arrangeTaskReads(taskRow({ status: 'TRANSLATING', jobQueueId: 'job-old' }), [
      'job-old',
      'job-new',
    ]);
    getTranslateJobMock.mockResolvedValue({ status: 'succeeded', progress: 100, stage: null });
    taskUpdateManyMock.mockResolvedValue({ count: 0 });

    await runDocTranslateTick();

    expect(saveOutputFileMock).toHaveBeenCalled();
    expect(deleteTaskFilesMock).not.toHaveBeenCalled();
  });
});

describe('dispatchJob — 派发侧代次谓词 (M11 / M12) 与 429 清理 (L28)', () => {
  it('markTaskTranslating 必须带 jobQueueId 谓词（否则会写花新一代的 workerId）', async () => {
    arrangeSubmittedJob({ params: JSON.stringify({ taskId: 't1', workerId: 'w1' }) });
    arrangeTaskReads(taskRow({ status: 'PENDING', jobQueueId: 'job-old' }));
    getTranslateJobMock.mockResolvedValue({ status: 'running', progress: 5, stage: null });

    await runDocTranslateTick();

    const translatingWrite = findTaskUpdate((c) => c.data?.status === 'TRANSLATING');
    expect(translatingWrite).toBeDefined();
    expect(translatingWrite!.where).toEqual({
      id: 't1',
      jobQueueId: 'job-old',
      status: { in: ['PENDING', 'TRANSLATING'] },
    });
  });

  it('issueProxyToken 带代次谓词；写不进去（已换代）就不 start，并清掉已上传的源文件', async () => {
    arrangeSubmittedJob();
    arrangeTaskReads(taskRow({ status: 'PENDING', jobQueueId: 'job-old' }));
    // 机队上找不到这个 jobId（首次派发）→ 走 pickWorker + 上传
    getTranslateJobMock.mockRejectedValue(new MockWorkerError(404));
    taskUpdateManyMock.mockImplementation(async (args: { data?: Record<string, unknown> }) =>
      args?.data && 'proxyTokenHash' in args.data ? { count: 0 } : { count: 1 }
    );

    await runDocTranslateTick();

    const tokenWrite = findTaskUpdate((c) => 'proxyTokenHash' in (c.data ?? {}));
    expect(tokenWrite!.where).toEqual({ id: 't1', jobQueueId: 'job-old' });
    expect(startTranslateJobMock).not.toHaveBeenCalled();
    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      'job-old'
    );
  });

  it('任务已改嫁新一代 → 放弃派发，绝不上传/启动', async () => {
    arrangeSubmittedJob();
    arrangeTaskReads(taskRow({ status: 'PENDING', jobQueueId: 'job-new' }));

    await runDocTranslateTick();

    expect(uploadTranslateInputMock).not.toHaveBeenCalled();
    expect(startTranslateJobMock).not.toHaveBeenCalled();
    expect(taskUpdateManyMock).not.toHaveBeenCalled();
  });

  it('L28：worker 429 让位前必须删掉已上传的源文件，不能留给对方自清扫', async () => {
    arrangeSubmittedJob();
    arrangeTaskReads(taskRow({ status: 'PENDING', jobQueueId: 'job-old' }));
    getTranslateJobMock.mockRejectedValue(new MockWorkerError(404));
    startTranslateJobMock.mockRejectedValue(new MockWorkerError(429));

    await runDocTranslateTick();

    expect(uploadTranslateInputMock).toHaveBeenCalled();
    expect(deleteTranslateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      'job-old'
    );
    expect(jobUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'SUBMITTED', startedAt: null },
      })
    );
  });
});

// H5 的跨模块不变式：僵尸回收阈值必须严格大于本模块承诺的最大运行时。
// 这两个常量当初就是各改各的漂移开的（jobQueue 2h < translateProcessor 3h）。
describe('僵尸回收阈值 vs 合法最大运行时 (H5)', () => {
  it('doc_translate 的回收阈值必须严格大于 MAX_WORKER_RUNTIME_MS', async () => {
    const jobQueue = await vi.importActual<typeof import('@/lib/jobQueue')>(
      '@/lib/jobQueue'
    );
    const processor = await import('@/lib/translate/translateProcessor');
    expect(
      jobQueue.STALE_PROCESSING_THRESHOLD_BY_TYPE[jobQueue.JOB_TYPE.DOC_TRANSLATE]
    ).toBeGreaterThan(processor.MAX_WORKER_RUNTIME_MS);
  });

  // 新增的任务级死线同理：它必须是三者里最外层的那一圈，否则会在任务还合法在跑时
  // 把它打成终态 + 退款（比 H5 的误杀更糟 —— 那至少不退钱）。
  it('MAX_TASK_LIFETIME_MS > 僵尸回收阈值 > MAX_WORKER_RUNTIME_MS', async () => {
    const jobQueue = await vi.importActual<typeof import('@/lib/jobQueue')>(
      '@/lib/jobQueue'
    );
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

// ─── 任务级绝对死线 ───────────────────────────────────────────────────────────
// MAX_WORKER_RUNTIME_MS 是「每一次派发」的预算而非任务总预算：job.startedAt 在每次回炉
// SUBMITTED 时都被清空（五处）。整个机队长期不可达时任务就在 SUBMITTED ↔ PROCESSING 之间
// 无限弹跳、永不终态 —— 用户永远看到「翻译中」，chargedCents 一直押着不退。
describe('executeTick — 任务级绝对死线', () => {
  const DAY = 24 * 60 * 60_000;
  /** 让死线扫描（且只让它）拿到一行任务 */
  function arrangeDeadlineCandidate(row: Record<string, unknown>) {
    taskFindManyMock.mockImplementation(async (args: TaskFindManyArgs) =>
      isDeadlineScan(args) ? [row] : []
    );
  }

  /**
   * 给 refundTaskCharge 一个**能真正跑完**的事务替身。
   *
   * 全局 beforeEach 里的替身是 `cb({})` —— tx.translationTask 是 undefined，退款体第一行就
   * TypeError，被 refundTaskCharge 自己的 try/catch 吞掉。于是「断言 transactionMock 被调用过」
   * 这种写法看起来在测退款，其实退款一步都没执行。这里换成有内容的替身，让
   * refundWalletCents 真的被调到，并把认领谓词捞出来核对 L24 代次令牌。
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
    arrangeTaskReads(taskRow({ id: 't1', jobQueueId: 'job-stuck' }));
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
    // retryable:false ⇒ 不写 nextRetryAt，第 2 步的到期重试捞不回它
    const jobWrite = jobUpdateMock.mock.calls
      .map(([a]) => a as { data: { status: string; params?: string } })
      .find((a) => a.data?.status === 'FAILED');
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
    arrangeTaskReads(taskRow({ id: 't1', jobQueueId: 'job-stuck' }));
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
  it('调度行被僵尸回收直改成 FAILED（绕过 failJob）→ 补做结算：任务终态 + 退款', async () => {
    taskFindManyMock.mockImplementation(async (args: TaskFindManyArgs) =>
      isDeadlineScan(args) || isOrphanScan(args) ? [] : [{ id: 't1', jobQueueId: 'job-zombie' }]
    );
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-zombie',
      type: 'doc_translate',
      status: 'FAILED',
      // 僵尸回收不写 nextRetryAt —— 这正是任务永久卡死的原因
      params: JSON.stringify({ taskId: 't1', workerId: 'w1' }),
      attempt: 3,
      maxAttempts: 3,
    });
    arrangeTaskReads(taskRow({ id: 't1', jobQueueId: 'job-zombie' }));

    await runDocTranslateTick();

    const failWrite = findTaskUpdate((c) => c.data?.status === 'FAILED');
    expect(failWrite).toBeDefined();
    expect(failWrite!.where).toEqual(
      expect.objectContaining({ id: 't1', jobQueueId: 'job-zombie' })
    );
    // 退款走 refundTaskCharge 的事务
    expect(transactionMock).toHaveBeenCalled();
  });

  it('调度行还在途（SUBMITTED/PROCESSING）→ 不动它', async () => {
    taskFindManyMock.mockImplementation(async (args: TaskFindManyArgs) =>
      isDeadlineScan(args) || isOrphanScan(args) ? [] : [{ id: 't1', jobQueueId: 'job-live' }]
    );
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
  });

  it('已排定自动重试（nextRetryAt 在）→ 交给退避回炉，不重复结算', async () => {
    taskFindManyMock.mockImplementation(async (args: TaskFindManyArgs) =>
      isDeadlineScan(args) || isOrphanScan(args) ? [] : [{ id: 't1', jobQueueId: 'job-retry' }]
    );
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
  });
});
