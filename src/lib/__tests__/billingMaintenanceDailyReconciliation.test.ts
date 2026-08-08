import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L8：`maybeRunDailyReconciliation` 的多实例 TOCTOU。
 * 旧写法「读日期 → 跑整场对账 → 才 upsert 写日期」，窗口 = 整场对账时长（全量遍历用户 + 逐用户
 * 多次聚合），多实例/多次触发都读到旧值 → 各跑一遍全量对账。改为**先条件写抢占再跑**，
 * 窗口收敛到单条语句；对账失败则把抢占释放掉，不让今天的对账被永久跳过。
 */

const {
  settingFindUniqueMock,
  settingUpdateManyMock,
  settingCreateMock,
  settingUpsertMock,
  runReconciliationMock,
  createJobMock,
} = vi.hoisted(() => ({
  settingFindUniqueMock: vi.fn(),
  settingUpdateManyMock: vi.fn(),
  settingCreateMock: vi.fn(),
  settingUpsertMock: vi.fn(),
  runReconciliationMock: vi.fn(),
  createJobMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      findUnique: settingFindUniqueMock,
      updateMany: settingUpdateManyMock,
      create: settingCreateMock,
      upsert: settingUpsertMock,
    },
  },
}));

vi.mock('@/lib/reconciliation', () => ({
  runTranscriptionUsageReconciliation: runReconciliationMock,
}));

vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { RECONCILIATION: 'reconciliation' },
  createJob: createJobMock,
  markJobProcessing: vi.fn(),
  markJobSuccess: vi.fn(),
  markJobFailed: vi.fn(),
  trackJob: vi.fn(),
  reclaimStaleProcessingJobs: vi.fn(),
}));

import { maybeRunDailyReconciliation } from '@/lib/billingMaintenance';

const NOW = new Date('2026-06-01T03:00:00.000Z');
const TODAY = '2026-06-01';
const KEY = 'billing.reconciliation.lastRunUtcDate';

describe('maybeRunDailyReconciliation（L8）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createJobMock.mockResolvedValue(null);
    runReconciliationMock.mockResolvedValue({ id: 'run-1' });
    settingUpdateManyMock.mockResolvedValue({ count: 1 });
    settingCreateMock.mockResolvedValue({});
  });

  it('已跑过今天：直接返回 null，不抢占也不跑', async () => {
    settingFindUniqueMock.mockResolvedValue({ value: TODAY });

    expect(await maybeRunDailyReconciliation(NOW)).toBeNull();
    expect(settingUpdateManyMock).not.toHaveBeenCalled();
    expect(runReconciliationMock).not.toHaveBeenCalled();
  });

  it('▶ 抢占发生在对账**之前**（条件写 value != 今天）', async () => {
    settingFindUniqueMock.mockResolvedValue({ value: '2026-05-31' });
    const order: string[] = [];
    settingUpdateManyMock.mockImplementation(async () => {
      order.push('claim');
      return { count: 1 };
    });
    runReconciliationMock.mockImplementation(async () => {
      order.push('reconcile');
      return { id: 'run-1' };
    });

    expect(await maybeRunDailyReconciliation(NOW)).toBe('run-1');
    expect(order).toEqual(['claim', 'reconcile']);
    expect(settingUpdateManyMock).toHaveBeenCalledWith({
      where: { key: KEY, value: { not: TODAY } },
      data: { value: TODAY },
    });
  });

  it('▶ 抢占失败（另一实例刚抢到）→ 不跑对账', async () => {
    settingFindUniqueMock.mockResolvedValue({ value: '2026-05-31' });
    settingUpdateManyMock.mockResolvedValue({ count: 0 });
    settingCreateMock.mockRejectedValue(new Error('unique constraint'));

    expect(await maybeRunDailyReconciliation(NOW)).toBeNull();
    expect(runReconciliationMock).not.toHaveBeenCalled();
  });

  it('首次运行（行不存在）：靠 create 的唯一键抢占，成功即跑', async () => {
    settingFindUniqueMock.mockResolvedValue(null);
    settingUpdateManyMock.mockResolvedValue({ count: 0 });

    expect(await maybeRunDailyReconciliation(NOW)).toBe('run-1');
    expect(settingCreateMock).toHaveBeenCalledWith({
      data: { key: KEY, value: TODAY },
    });
  });

  it('▶ 对账失败：把抢占释放回原值（今天仍可重试，而不是被永久跳过）', async () => {
    settingFindUniqueMock.mockResolvedValue({ value: '2026-05-31' });
    runReconciliationMock.mockRejectedValue(new Error('boom'));

    await expect(maybeRunDailyReconciliation(NOW)).rejects.toThrow('boom');
    expect(settingUpdateManyMock).toHaveBeenLastCalledWith({
      where: { key: KEY, value: TODAY },
      data: { value: '2026-05-31' },
    });
  });
});
