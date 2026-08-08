import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateManyMock, findUniqueMock, updateMock, createMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    jobQueue: {
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
      update: updateMock,
      create: createMock,
    },
  },
}));

import {
  ActiveJobConflictError,
  audioEnhanceActiveKey,
  createJob,
  isJobTypeRetryable,
  JOB_TYPE,
  reclaimStaleProcessingJobs,
  retryJob,
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
        // P5-16：僵尸回收是 activeKey 的安全阀 —— 不释放的话该会话永远入不了新队
        activeKey: null,
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


// ─── L10 / P5-16 ───

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    type: JOB_TYPE.AUDIO_ENHANCE,
    status: 'FAILED',
    sessionId: 'sess-1',
    attempt: 1,
    maxAttempts: 3,
    activeKey: null,
    ...overrides,
  };
}

describe('retryJob — 无消费者的类型不得假装重试成功 (L10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue({});
  });

  it.each([
    JOB_TYPE.KEYWORD_EXTRACTION,
    JOB_TYPE.REPORT_GENERATION,
    JOB_TYPE.BILLING_MAINTENANCE,
    JOB_TYPE.TITLE_GENERATION,
    JOB_TYPE.STORAGE_CLEANUP,
  ])('%s：FAILED 也不回炉（没有任何调度器会捞 SUBMITTED 行）', async (type) => {
    findUniqueMock.mockResolvedValue(jobRow({ type }));
    await expect(retryJob('job-1')).resolves.toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('audio_enhance / doc_translate 仍可重试', async () => {
    expect(isJobTypeRetryable(JOB_TYPE.AUDIO_ENHANCE)).toBe(true);
    expect(isJobTypeRetryable(JOB_TYPE.DOC_TRANSLATE)).toBe(true);
    findUniqueMock.mockResolvedValue(jobRow({ type: JOB_TYPE.DOC_TRANSLATE }));
    await expect(retryJob('job-1')).resolves.toBe(true);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUBMITTED', attempt: { increment: 1 } }),
      })
    );
  });
});

describe('activeKey 排他键 (P5-16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue({});
  });

  it('createJob 传 activeKey 时，唯一键冲突抛 ActiveJobConflictError（而非静默返回空 id）', async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(
      createJob({
        type: JOB_TYPE.AUDIO_ENHANCE,
        sessionId: 'sess-1',
        activeKey: audioEnhanceActiveKey('sess-1'),
      })
    ).rejects.toBeInstanceOf(ActiveJobConflictError);
  });

  it('没传 activeKey 时保持旧行为：任何错误都吞掉返回空串', async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(createJob({ type: JOB_TYPE.REPORT_GENERATION })).resolves.toBe('');
  });

  it('audio_enhance 回炉时重新取回 activeKey（回炉后是非终态，必须持键）', async () => {
    findUniqueMock.mockResolvedValue(jobRow({ activeKey: null }));
    await retryJob('job-1');
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeKey: 'audio_enhance:sess-1' }),
      })
    );
  });

  it('同会话已有别的在途任务持键 → 回炉撞唯一键 → 判定重试失败而非抛出', async () => {
    findUniqueMock.mockResolvedValue(jobRow({ activeKey: null }));
    updateMock.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(retryJob('job-1')).resolves.toBe(false);
  });
});
