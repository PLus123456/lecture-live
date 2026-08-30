// H5 / L25：文档翻译调度行的「僵尸回收阈值」与「回炉抢占」。
//
// H5：通用僵尸回收阈值（2h）曾经小于文档翻译的合法最大运行时（3h），
//     每 15 分钟一次的 billing maintenance 必然在大文档跑到一半时把调度行打成 FAILED。
// L25：retryJob 的回炉是 check-then-act（findUnique 预检 + 无条件 update）；
//     doc_translate 的 tick 同时跑在 ws 进程与每个 API 进程里，同一轮可能回炉两次，
//     attempt 一次跳 2、白烧一格退避档位。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  updateManyMock,
  findUniqueMock,
  updateMock,
  createMock,
  rootExecuteRawMock,
  rootQueryRawMock,
} = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  createMock: vi.fn(),
  rootExecuteRawMock: vi.fn(),
  rootQueryRawMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    jobQueue: {
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
      update: updateMock,
      create: createMock,
    },
    // 回收走原始 SQL（DB UTC 时钟 + 与 claim 共用的 resourceScope X lock），不是 updateMany。
    $executeRaw: rootExecuteRawMock,
    $queryRaw: rootQueryRawMock,
    $transaction: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  updateManyMock.mockResolvedValue({ count: 0 });
  updateMock.mockResolvedValue({});
  // 没有带 resourceScope 的僵尸行 → 只会走「非资源任务」那一条 UPDATE。
  rootQueryRawMock.mockResolvedValue([]);
  rootExecuteRawMock.mockResolvedValue(0);
});

/** 取第 n 条根级 $executeRaw 的 Prisma.sql（拼好的 SQL 文本 + 参数值）。 */
function reclaimSql(index: number) {
  const call = rootExecuteRawMock.mock.calls[index]?.[0] as {
    strings?: string[];
    values?: unknown[];
  };
  return { text: call?.strings?.join('?') ?? '', values: call?.values ?? [] };
}

describe('僵尸回收阈值按 job type 分档 (H5)', () => {
  it('doc_translate 的阈值必须严格大于通用阈值（否则长任务必被误杀）', () => {
    expect(STALE_PROCESSING_THRESHOLD_BY_TYPE[JOB_TYPE.DOC_TRANSLATE]).toBeGreaterThan(
      STALE_PROCESSING_JOB_THRESHOLD_MS
    );
    expect(LONG_RUNNING_JOB_TYPES).toContain(JOB_TYPE.DOC_TRANSLATE);
  });

  it('通用扫描必须排除长跑类型，长跑类型各走自己的阈值', async () => {
    await reclaimAllStaleProcessingJobs();

    // 每一档一条根级 UPDATE（本用例没有带 resourceScope 的僵尸行）。
    expect(rootExecuteRawMock).toHaveBeenCalledTimes(1 + LONG_RUNNING_JOB_TYPES.length);

    const generic = reclaimSql(0);
    expect(generic.text).toContain('type NOT IN');
    expect(generic.values).toEqual(
      expect.arrayContaining([
        JOB_TYPE.DOC_TRANSLATE,
        STALE_PROCESSING_JOB_THRESHOLD_MS * 1000,
      ])
    );

    const docTranslate = reclaimSql(1);
    expect(docTranslate.text).toContain('type IN');
    expect(docTranslate.values).toEqual(
      expect.arrayContaining([
        JOB_TYPE.DOC_TRANSLATE,
        STALE_PROCESSING_THRESHOLD_BY_TYPE[JOB_TYPE.DOC_TRANSLATE] * 1000,
      ])
    );
  });

  it('回收数量是各档之和', async () => {
    rootExecuteRawMock.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    await expect(reclaimAllStaleProcessingJobs()).resolves.toBe(5);
  });

  it('不传 options 时保持历史语义：单条不分类型的扫描', async () => {
    await reclaimStaleProcessingJobs();
    expect(rootExecuteRawMock).toHaveBeenCalledTimes(1);
    const sql = reclaimSql(0);
    expect(sql.text).not.toContain('type IN');
    expect(sql.text).not.toContain('type NOT IN');
    expect(sql.values).toEqual(
      expect.arrayContaining([STALE_PROCESSING_JOB_THRESHOLD_MS * 1000])
    );
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

  it('UPDATE 的 where 必须带 status=FAILED 与 attempt 快照（谓词压进语句，不是只靠预检）', async () => {
    findUniqueMock.mockResolvedValue(failedJob());
    updateManyMock.mockResolvedValue({ count: 1 });

    await expect(retryJob('job-1')).resolves.toBe(true);

    // attempt 一并入 where：两个 tick 读到同一份 FAILED 快照时只有一个能递增，
    // 否则 attempt 一次跳 2、白烧掉一格退避档位。
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          status: 'FAILED',
          attempt: 1,
        }),
        data: expect.objectContaining({ attempt: { increment: 1 } }),
      })
    );
  });

  it('条件没命中（别的进程同一轮已回炉过）→ 返回 false，不抛', async () => {
    findUniqueMock.mockResolvedValue(failedJob());
    updateManyMock.mockResolvedValue({ count: 0 });

    await expect(retryJob('job-1')).resolves.toBe(false);
  });

  it('P2025（条件更新的竞态输家）同样收敛成 false', async () => {
    findUniqueMock.mockResolvedValue(failedJob());
    updateManyMock.mockRejectedValue(
      Object.assign(new Error('Record to update not found'), { code: 'P2025' })
    );

    await expect(retryJob('job-1')).resolves.toBe(false);
  });
});
