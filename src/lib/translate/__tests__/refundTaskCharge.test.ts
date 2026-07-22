// refundTaskCharge 幂等闸单测：refundedAt 条件 CAS 抢占（防双退）、
// 入账失败还原闸（下一轮可兜底重试）。这是翻译计费最关键的钱路径。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { taskUpdateManyMock, taskFindUniqueMock, refundWalletCentsMock } = vi.hoisted(() => ({
  taskUpdateManyMock: vi.fn(),
  taskFindUniqueMock: vi.fn(),
  refundWalletCentsMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: {
      updateMany: taskUpdateManyMock,
      findUnique: taskFindUniqueMock,
      update: vi.fn(),
    },
    jobQueue: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
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
vi.mock('@/lib/translate/workerClient', () => ({
  getTranslateFleetConfig: vi.fn(),
  pingTranslateWorker: vi.fn(),
  uploadTranslateInput: vi.fn(),
  startTranslateJob: vi.fn(),
  getTranslateJob: vi.fn(),
  downloadTranslateOutput: vi.fn(),
  deleteTranslateJob: vi.fn(),
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
    expect(refundWalletCentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        amountCents: 120,
        type: 'translation_refund',
      })
    );
  });

  it('闸已被占（count=0，已退过/未扣费）→ 不再入账（幂等防双退）', async () => {
    taskUpdateManyMock.mockResolvedValue({ count: 0 });

    await refundTaskCharge('t1', '用户取消退款');
    expect(refundWalletCentsMock).not.toHaveBeenCalled();
  });

  it('入账失败 → 还原退款闸（refundedAt 置回 null），等下一轮兜底', async () => {
    taskUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // 抢闸成功
      .mockResolvedValueOnce({ count: 1 }); // 还原闸
    taskFindUniqueMock.mockResolvedValue({ userId: 'u1', chargedCents: 120 });
    refundWalletCentsMock.mockRejectedValue(new Error('db down'));

    await refundTaskCharge('t1', '翻译失败自动退款');

    expect(taskUpdateManyMock).toHaveBeenLastCalledWith({
      where: { id: 't1' },
      data: { refundedAt: null },
    });
  });
});
