import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateManyMock } = vi.hoisted(() => ({ updateManyMock: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: { jobQueue: { updateMany: updateManyMock } },
}));

import {
  reclaimStaleProcessingJobs,
  STALE_PROCESSING_JOB_THRESHOLD_MS,
} from '@/lib/jobQueue';

describe('reclaimStaleProcessingJobs', () => {
  beforeEach(() => {
    updateManyMock.mockReset();
  });

  it('把超过默认阈值仍处于 PROCESSING 的任务原子标为 FAILED', async () => {
    updateManyMock.mockResolvedValue({ count: 3 });
    const now = new Date('2026-05-30T12:00:00.000Z');

    const count = await reclaimStaleProcessingJobs(now);

    expect(count).toBe(3);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        status: 'PROCESSING',
        startedAt: {
          lte: new Date(now.getTime() - STALE_PROCESSING_JOB_THRESHOLD_MS),
        },
      },
      data: {
        status: 'FAILED',
        error: expect.stringContaining('自动回收'),
        completedAt: now,
      },
    });
  });

  it('支持自定义阈值', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    const now = new Date('2026-05-30T12:00:00.000Z');
    const customThresholdMs = 30 * 60_000;

    await reclaimStaleProcessingJobs(now, customThresholdMs);

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startedAt: { lte: new Date(now.getTime() - customThresholdMs) },
        }),
      })
    );
  });

  it('无僵尸任务时返回 0', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const count = await reclaimStaleProcessingJobs(
      new Date('2026-05-30T12:00:00.000Z')
    );

    expect(count).toBe(0);
  });
});
