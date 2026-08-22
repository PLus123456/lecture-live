// H5 / L25：文档翻译调度行的「僵尸回收阈值」与「回炉抢占」。
//
// H5：通用僵尸回收阈值（2h）曾经小于文档翻译的合法最大运行时（3h），
//     每 15 分钟一次的 billing maintenance 必然在大文档跑到一半时把调度行打成 FAILED。
// L25：retryJob 的回炉是 check-then-act（findUnique 预检 + 无条件 update）；
//     doc_translate 的 tick 同时跑在 ws 进程与每个 API 进程里，同一轮可能回炉两次，
//     attempt 一次跳 2、白烧一格退避档位。
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
  JOB_TYPE,
  LONG_RUNNING_JOB_TYPES,
  reclaimAllStaleProcessingJobs,
  reclaimStaleProcessingJobs,
  retryJob,
  STALE_PROCESSING_JOB_THRESHOLD_MS,
  STALE_PROCESSING_THRESHOLD_BY_TYPE,
} from '@/lib/jobQueue';

const NOW = new Date('2026-08-22T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  updateManyMock.mockResolvedValue({ count: 0 });
  updateMock.mockResolvedValue({});
});

describe('僵尸回收阈值按 job type 分档 (H5)', () => {
  it('doc_translate 的阈值必须严格大于通用阈值（否则长任务必被误杀）', () => {
    expect(STALE_PROCESSING_THRESHOLD_BY_TYPE[JOB_TYPE.DOC_TRANSLATE]).toBeGreaterThan(
      STALE_PROCESSING_JOB_THRESHOLD_MS
    );
    expect(LONG_RUNNING_JOB_TYPES).toContain(JOB_TYPE.DOC_TRANSLATE);
  });

  it('通用扫描必须排除长跑类型，长跑类型各走自己的阈值', async () => {
    await reclaimAllStaleProcessingJobs(NOW);

    const calls = updateManyMock.mock.calls.map(([args]) => args as {
      where: { type?: unknown; startedAt?: { lte: Date } };
    });
    expect(calls).toHaveLength(1 + LONG_RUNNING_JOB_TYPES.length);

    const generic = calls.find((c) => (c.where.type as { notIn?: string[] })?.notIn);
    expect(generic).toBeDefined();
    expect((generic!.where.type as { notIn: string[] }).notIn).toContain(
      JOB_TYPE.DOC_TRANSLATE
    );
    expect(generic!.where.startedAt!.lte).toEqual(
      new Date(NOW.getTime() - STALE_PROCESSING_JOB_THRESHOLD_MS)
    );

    const docTranslate = calls.find((c) =>
      (c.where.type as { in?: string[] })?.in?.includes(JOB_TYPE.DOC_TRANSLATE)
    );
    expect(docTranslate).toBeDefined();
    expect(docTranslate!.where.startedAt!.lte).toEqual(
      new Date(
        NOW.getTime() - STALE_PROCESSING_THRESHOLD_BY_TYPE[JOB_TYPE.DOC_TRANSLATE]
      )
    );
  });

  it('回收数量是各档之和', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 3 });
    await expect(reclaimAllStaleProcessingJobs(NOW)).resolves.toBe(5);
  });

  it('不传 options 时保持历史语义：单条不分类型的扫描', async () => {
    await reclaimStaleProcessingJobs(NOW);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].where).toEqual({
      status: 'PROCESSING',
      startedAt: { lte: new Date(NOW.getTime() - STALE_PROCESSING_JOB_THRESHOLD_MS) },
    });
  });
});

describe('retryJob 回炉必须是条件更新 (L25)', () => {
  function failedJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      type: JOB_TYPE.DOC_TRANSLATE,
      status: 'FAILED',
      sessionId: null,
      attempt: 1,
      maxAttempts: 3,
      activeKey: null,
      ...overrides,
    };
  }

  it('UPDATE 的 where 必须带 status=FAILED（谓词压进语句，不是只靠预检）', async () => {
    findUniqueMock.mockResolvedValue(failedJob());

    await expect(retryJob('job-1')).resolves.toBe(true);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: 'FAILED' },
        data: expect.objectContaining({ attempt: { increment: 1 } }),
      })
    );
  });

  it('条件没命中（P2025：别的进程同一轮已回炉过）→ 返回 false，不抛', async () => {
    findUniqueMock.mockResolvedValue(failedJob());
    updateMock.mockRejectedValue(
      Object.assign(new Error('Record to update not found'), { code: 'P2025' })
    );

    await expect(retryJob('job-1')).resolves.toBe(false);
  });
});
