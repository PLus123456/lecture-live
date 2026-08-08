// refundTaskCharge 幂等闸单测：refundedAt 条件 CAS 抢占（防双退）、
// 入账失败整体回滚（下一轮可兜底重试）、代次守卫（不退掉用户重试后新扣的钱）。
// 这是翻译计费最关键的钱路径。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { taskUpdateManyMock, taskFindUniqueMock, refundWalletCentsMock, transactionMock } =
  vi.hoisted(() => ({
    taskUpdateManyMock: vi.fn(),
    taskFindUniqueMock: vi.fn(),
    refundWalletCentsMock: vi.fn(),
    transactionMock: vi.fn(),
  }));

/** 事务替身：把 callback 交给同一组 mock；回调抛出即视为整体回滚。 */
const txClient = {
  translationTask: { updateMany: taskUpdateManyMock, findUnique: taskFindUniqueMock },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: {
      updateMany: taskUpdateManyMock,
      findUnique: taskFindUniqueMock,
      update: vi.fn(),
      findMany: vi.fn(),
    },
    jobQueue: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/wallet', () => ({ refundWalletCents: refundWalletCentsMock }));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { DOC_TRANSLATE: 'doc_translate' },
  JOB_STATUS: { SUBMITTED: 'SUBMITTED', PROCESSING: 'PROCESSING', SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  createJob: vi.fn(),
  retryJob: vi.fn(),
}));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: vi.fn() }));
vi.mock('@/lib/userRoles', () => ({ resolveUserTranslationModelId: vi.fn() }));
vi.mock('@/lib/llm/summaryModel', () => ({ resolveGroupBoundModel: vi.fn() }));
vi.mock('@/lib/translate/workerClient', () => ({
  getTranslateFleetConfig: vi.fn(),
  pingTranslateWorker: vi.fn(),
  uploadTranslateInput: vi.fn(),
  startTranslateJob: vi.fn(),
  getTranslateJob: vi.fn(),
  downloadTranslateOutput: vi.fn(),
  deleteTranslateJob: vi.fn(),
  buildWorkerModelLabel: vi.fn(() => 'mock-model'),
  TranslateWorkerError: class extends Error {},
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  readSourceFile: vi.fn(),
  saveOutputFile: vi.fn(),
  deleteTaskFiles: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  serializeError: (e: unknown) => e,
}));

import { refundTaskCharge } from '@/lib/translate/translateProcessor';

beforeEach(() => {
  taskUpdateManyMock.mockReset();
  taskFindUniqueMock.mockReset();
  refundWalletCentsMock.mockReset();
  transactionMock.mockReset();
  transactionMock.mockImplementation((cb: (tx: unknown) => unknown) => cb(txClient));
});

describe('refundTaskCharge', () => {
  it('抢到闸（count=1）→ 按 chargedCents 全额入账', async () => {
    taskUpdateManyMock.mockResolvedValue({ count: 1 });
    taskFindUniqueMock.mockResolvedValue({ userId: 'u1', chargedCents: 120 });
    refundWalletCentsMock.mockResolvedValue({ balanceAfterCents: 500 });

    await refundTaskCharge('t1', '翻译失败自动退款');

    // CAS 形态：refundedAt=null 且 chargedCents>0 才置位
    expect(taskUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 't1', refundedAt: null, chargedCents: { gt: 0 } },
      data: { refundedAt: expect.any(Date) },
    });
    // L22：入账必须走同一个事务客户端（第二个参数），否则「闸已置位、钱没到账」会永久卡死
    expect(refundWalletCentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        amountCents: 120,
        type: 'translation_refund',
      }),
      txClient
    );
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('闸已被占（count=0，已退过/未扣费）→ 不再入账（幂等防双退）', async () => {
    taskUpdateManyMock.mockResolvedValue({ count: 0 });

    await refundTaskCharge('t1', '用户取消退款');
    expect(refundWalletCentsMock).not.toHaveBeenCalled();
  });

  it('L22：入账失败 → 事务整体回滚（不再靠补偿写还原闸），且不抛给调用方', async () => {
    taskUpdateManyMock.mockResolvedValue({ count: 1 });
    taskFindUniqueMock.mockResolvedValue({ userId: 'u1', chargedCents: 120 });
    refundWalletCentsMock.mockRejectedValue(new Error('db down'));

    await expect(refundTaskCharge('t1', '翻译失败自动退款')).resolves.toBeUndefined();

    // 抢闸与入账在同一事务里，失败即回滚 —— 不该再有「补偿性地把 refundedAt 写回 null」
    // 这一条独立语句（它自己也可能挂，挂了这笔钱就永久消失）
    const compensating = taskUpdateManyMock.mock.calls.find(
      (c) => c[0]?.data?.refundedAt === null
    );
    expect(compensating).toBeUndefined();
  });

  it('L24：带代次守卫时，CAS 谓词必须带上 jobQueueId', async () => {
    taskUpdateManyMock.mockResolvedValue({ count: 0 });

    await refundTaskCharge('t1', '翻译失败自动退款', 'job-1');

    expect(taskUpdateManyMock).toHaveBeenCalledWith({
      where: {
        id: 't1',
        refundedAt: null,
        chargedCents: { gt: 0 },
        jobQueueId: 'job-1',
      },
      data: { refundedAt: expect.any(Date) },
    });
    // 任务已换代（谓词不命中）→ 不得退掉新一代刚扣的钱
    expect(refundWalletCentsMock).not.toHaveBeenCalled();
  });
});
