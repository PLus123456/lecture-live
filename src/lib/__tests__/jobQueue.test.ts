import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findUniqueMock,
  updateMock,
  updateManyMock,
  createMock,
  aggregateMock,
  executeRawMock,
  settleExecuteRawMock,
  rootQueryRawMock,
  queryRawMock,
  transactionMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
  createMock: vi.fn(),
  aggregateMock: vi.fn(),
  executeRawMock: vi.fn(),
  settleExecuteRawMock: vi.fn(),
  rootQueryRawMock: vi.fn(),
  queryRawMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    jobQueue: {
      findUnique: findUniqueMock,
      update: updateMock,
      updateMany: updateManyMock,
      create: createMock,
      aggregate: aggregateMock,
    },
    $executeRaw: settleExecuteRawMock,
    $queryRaw: rootQueryRawMock,
    $transaction: transactionMock,
  },
}));

import {
  ActiveJobConcurrencyExceededError,
  ActiveJobConflictError,
  ActiveJobReservationWindowExpiredError,
  audioEnhanceActiveKey,
  claimActiveJob,
  completeActiveJob,
  createJob,
  failActiveJob,
  isJobTypeRetryable,
  JOB_STATUS,
  JOB_TYPE,
  reclaimStaleProcessingJobs,
  retryJob,
  STALE_PROCESSING_JOB_THRESHOLD_MS,
  trackJob,
} from '@/lib/jobQueue';

describe('trackJob — durable operation journal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ id: 'tracked-job-1' });
    updateMock.mockResolvedValue({});
    transactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ jobQueue: { update: updateMock } })
    );
  });

  it('外部操作成功时把 SUCCESS 与 terminal mutation 放在同一事务', async () => {
    const terminalMutation = vi.fn().mockResolvedValue(undefined);
    const result = await trackJob(
      {
        type: JOB_TYPE.ADMIN_INTEGRATION,
        resultSummary: (value: { ok: boolean; secret: string }) => ({ ok: value.ok }),
        terminalMutation,
      },
      async () => ({ ok: true, secret: 'must-not-be-journalled' })
    );

    expect(result.ok).toBe(true);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'tracked-job-1' },
      data: expect.objectContaining({
        status: JOB_STATUS.SUCCESS,
        result: JSON.stringify({ ok: true }),
      }),
    });
    expect(terminalMutation).toHaveBeenCalledWith(
      expect.objectContaining({ jobQueue: { update: updateMock } }),
      { status: JOB_STATUS.SUCCESS, result }
    );
    expect(JSON.stringify(updateMock.mock.calls)).not.toContain('must-not-be-journalled');
  });

  it('外部操作失败时把 FAILED 与 terminal mutation 放在同一事务', async () => {
    const failure = new Error('upstream leaked oauth_code=secret');
    const terminalMutation = vi.fn().mockResolvedValue(undefined);

    await expect(
      trackJob(
        {
          type: JOB_TYPE.ADMIN_INTEGRATION,
          errorSummary: (error) =>
            error instanceof Error ? error.name : 'UnknownError',
          terminalMutation,
        },
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'tracked-job-1' },
      data: expect.objectContaining({
        status: JOB_STATUS.FAILED,
        error: 'Error',
      }),
    });
    expect(terminalMutation).toHaveBeenCalledWith(
      expect.anything(),
      { status: JOB_STATUS.FAILED, error: failure }
    );
    expect(JSON.stringify(updateMock.mock.calls)).not.toContain('oauth_code=secret');
  });

  it('终态事务失败时保留 PROCESSING，不在根 client 伪造终态', async () => {
    const auditFailure = new Error('audit unavailable');
    transactionMock.mockRejectedValueOnce(auditFailure);

    await expect(
      trackJob(
        {
          type: JOB_TYPE.ADMIN_MUTATION,
          terminalMutation: vi.fn(),
        },
        async () => ({ ok: true })
      )
    ).rejects.toBe(auditFailure);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: JOB_STATUS.PROCESSING }),
      })
    );
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('reclaimStaleProcessingJobs', () => {
  beforeEach(() => {
    settleExecuteRawMock.mockReset();
    rootQueryRawMock.mockReset();
    rootQueryRawMock.mockResolvedValue([]);
    executeRawMock.mockReset();
    transactionMock.mockReset();
  });

  it('把超过默认阈值仍处于 PROCESSING 的任务原子标为 FAILED', async () => {
    settleExecuteRawMock.mockResolvedValue(3);

    const count = await reclaimStaleProcessingJobs();

    expect(count).toBe(3);
    const sql = settleExecuteRawMock.mock.calls[0]?.[0] as {
      strings?: string[];
      values?: unknown[];
    };
    expect(sql.strings?.join('')).toContain('completedAt = UTC_TIMESTAMP(3)');
    expect(sql.strings?.join('')).toContain('DATE_SUB');
    expect(sql.values).toEqual(
      expect.arrayContaining([
        'FAILED',
        expect.stringContaining('自动回收'),
        'PROCESSING',
        STALE_PROCESSING_JOB_THRESHOLD_MS * 1000,
      ])
    );
  });

  it('支持自定义阈值', async () => {
    settleExecuteRawMock.mockResolvedValue(0);
    const customThresholdMs = 30 * 60_000;

    await reclaimStaleProcessingJobs(customThresholdMs);

    const sql = settleExecuteRawMock.mock.calls[0]?.[0] as {
      values?: unknown[];
    };
    expect(sql.values).toEqual(
      expect.arrayContaining([customThresholdMs * 1000])
    );
  });

  it('无僵尸任务时返回 0', async () => {
    settleExecuteRawMock.mockResolvedValue(0);

    const count = await reclaimStaleProcessingJobs();

    expect(count).toBe(0);
  });

  it('资源僵尸回收与 claim 共用 scope X lock，非资源任务单独回收', async () => {
    rootQueryRawMock.mockResolvedValue([{ resourceScope: 'llm_tokens' }]);
    executeRawMock
      .mockResolvedValueOnce(1) // sentinel no-op upsert
      .mockResolvedValueOnce(2); // resource rows
    settleExecuteRawMock.mockResolvedValue(1); // non-resource rows
    transactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ $executeRaw: executeRawMock })
    );

    await expect(reclaimStaleProcessingJobs()).resolves.toBe(3);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(
      (executeRawMock.mock.calls[0]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('ON DUPLICATE KEY UPDATE');
    expect(
      (executeRawMock.mock.calls[1]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('resourceScope =');
    expect(
      (settleExecuteRawMock.mock.calls[0]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('resourceScope IS NULL');
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

const RESOURCE_WINDOW_START = new Date('2026-08-20T00:00:00.000Z');
const RESOURCE_WINDOW_END = new Date('2026-08-21T00:00:00.000Z');
const RESOURCE_ADMISSION_NOW = new Date('2026-08-20T12:00:00.000Z');

describe('retryJob — 无消费者的类型不得假装重试成功 (L10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue({});
    updateManyMock.mockResolvedValue({ count: 1 });
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
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('audio_enhance / doc_translate 仍可重试', async () => {
    expect(isJobTypeRetryable(JOB_TYPE.AUDIO_ENHANCE)).toBe(true);
    expect(isJobTypeRetryable(JOB_TYPE.DOC_TRANSLATE)).toBe(true);
    findUniqueMock.mockResolvedValue(jobRow({ type: JOB_TYPE.DOC_TRANSLATE }));
    await expect(retryJob('job-1')).resolves.toBe(true);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          status: 'FAILED',
          attempt: 1,
        }),
        data: expect.objectContaining({ status: 'SUBMITTED', attempt: { increment: 1 } }),
      })
    );
  });

  it('传入事务客户端时，读取与 CAS 都不逃逸到根 PrismaClient', async () => {
    const txFindUnique = vi.fn().mockResolvedValue(
      jobRow({ type: JOB_TYPE.DOC_TRANSLATE })
    );
    const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      jobQueue: {
        findUnique: txFindUnique,
        updateMany: txUpdateMany,
      },
    } as unknown as NonNullable<Parameters<typeof retryJob>[1]>;

    await expect(retryJob('job-1', tx)).resolves.toBe(true);

    expect(txFindUnique).toHaveBeenCalledWith({ where: { id: 'job-1' } });
    expect(txUpdateMany).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('迟到 retry 不会覆盖已被另一 tick claim 的 PROCESSING 新代', async () => {
    findUniqueMock.mockResolvedValue(jobRow({ type: JOB_TYPE.DOC_TRANSLATE }));
    updateManyMock.mockResolvedValue({ count: 0 });

    await expect(retryJob('job-1')).resolves.toBe(false);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'FAILED', attempt: 1 }),
      })
    );
  });
});

describe('activeKey 排他键 (P5-16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue({});
    updateManyMock.mockResolvedValue({ count: 1 });
    executeRawMock.mockResolvedValue(1);
    settleExecuteRawMock.mockResolvedValue(1);
    queryRawMock.mockImplementation((query: { strings?: string[] }) =>
      query.strings?.join('').includes('UTC_TIMESTAMP')
        ? Promise.resolve([{ admissionNow: RESOURCE_ADMISSION_NOW }])
        : Promise.resolve([{ key: 'lock' }])
    );
    aggregateMock.mockResolvedValue({ _sum: { reservedUnits: BigInt(0) } });
    findUniqueMock.mockResolvedValue(null);
    transactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: executeRawMock,
          $queryRaw: queryRawMock,
          jobQueue: {
            aggregate: aggregateMock,
            create: createMock,
            findUnique: findUniqueMock,
          },
        })
    );
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
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeKey: 'audio_enhance:sess-1' }),
      })
    );
  });

  it('同会话已有别的在途任务持键 → 回炉撞唯一键 → 判定重试失败而非抛出', async () => {
    findUniqueMock.mockResolvedValue(jobRow({ activeKey: null }));
    updateManyMock.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(retryJob('job-1')).resolves.toBe(false);
  });

  it('严格 claim 在一次 INSERT 中取得 PROCESSING 键并写 startedAt', async () => {
    createMock.mockResolvedValue({ id: 'strict-job-1' });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-1',
        userId: 'user-1',
        triggeredBy: 'system',
        activeKey: 'report:sess-1:hash-1',
        params: { reservedTokens: 1234 },
      })
    ).resolves.toBe('strict-job-1');

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: JOB_TYPE.REPORT_GENERATION,
        status: 'PROCESSING',
        sessionId: 'sess-1',
        userId: 'user-1',
        activeKey: 'report:sess-1:hash-1',
        startedAt: expect.any(Date),
        params: JSON.stringify({ reservedTokens: 1234 }),
      }),
    });
  });

  it('严格 claim 只把唯一键冲突映射为 in-flight，其他数据库错误关闭失败', async () => {
    createMock.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        activeKey: 'report:sess-1:hash-1',
      })
    ).rejects.toBeInstanceOf(ActiveJobConflictError);

    const unavailable = new Error('database unavailable');
    createMock.mockRejectedValueOnce(unavailable);
    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        activeKey: 'report:sess-1:hash-1',
      })
    ).rejects.toBe(unavailable);
  });

  it('严格成功/失败终态均 await 更新并释放 activeKey', async () => {
    await completeActiveJob(
      'strict-job-1',
      { providerCallsStarted: 2 },
      987
    );
    const successSql = settleExecuteRawMock.mock.calls[0]?.[0] as {
      strings?: string[];
      values?: unknown[];
    };
    expect(successSql.strings?.join('')).toContain(
      'completedAt = UTC_TIMESTAMP(3)'
    );
    expect(successSql.values).toEqual(
      expect.arrayContaining([
        'SUCCESS',
        JSON.stringify({ providerCallsStarted: 2 }),
        BigInt(987),
        'strict-job-1',
        'PROCESSING',
      ])
    );

    await failActiveJob(
      'strict-job-2',
      new Error('upstream failed'),
      { providerCallsStarted: 1 },
      456
    );
    const failureSql = settleExecuteRawMock.mock.calls[1]?.[0] as {
      strings?: string[];
      values?: unknown[];
    };
    expect(failureSql.values).toEqual(
      expect.arrayContaining([
        'FAILED',
        'upstream failed',
        JSON.stringify({ providerCallsStarted: 1 }),
        BigInt(456),
        'strict-job-2',
        'PROCESSING',
      ])
    );
  });

  it('资源任务终态迁移先取得与 claim 相同的 scope X lock', async () => {
    findUniqueMock.mockResolvedValueOnce({ resourceScope: 'llm_tokens' });

    await completeActiveJob('resource-job-1', { ok: true }, 123);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalledTimes(2);
    expect(
      (executeRawMock.mock.calls[0]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('ON DUPLICATE KEY UPDATE');
    expect(
      (executeRawMock.mock.calls[1]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('UPDATE JobQueue');
    expect(settleExecuteRawMock).not.toHaveBeenCalled();
  });

  it('资源预留在同一事务内锁 scope、统计用户/全局余额并 claim', async () => {
    createMock.mockResolvedValue({ id: 'budgeted-job' });
    aggregateMock
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(3000) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(1000) } });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-2',
        userId: 'user-1',
        activeKey: 'report:sess-2:hash-2',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).resolves.toBe('budgeted-job');

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(
      (executeRawMock.mock.calls[0]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('ON DUPLICATE KEY UPDATE');
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resourceScope: 'llm_report_tokens',
        reservedUnits: BigInt(2000),
        startedAt: RESOURCE_ADMISSION_NOW,
        status: 'PROCESSING',
      }),
    });
  });

  it('不同 sourceHash 也不能并发穿透同一用户 token 池', async () => {
    aggregateMock
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(4000) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(4000) } });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-new-version',
        userId: 'user-1',
        activeKey: 'report:sess-new-version:different-hash',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).rejects.toMatchObject({
      dimension: 'user',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('只有 active 预留导致暂时不足时返回短重试，而不是误导客户端等到次日', async () => {
    aggregateMock
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(4000) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(4000) } });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-active-shortage',
        userId: 'user-1',
        activeKey: 'report:sess-active-shortage:hash',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).rejects.toMatchObject({
      dimension: 'user',
      resetAt: new Date(RESOURCE_ADMISSION_NOW.getTime() + 15_000),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('前序版本已完成后 actualUnits 仍占用当日池，修改 sourceHash 不会拿回全部预算', async () => {
    aggregateMock
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(0) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(0) } })
      .mockResolvedValueOnce({ _sum: { actualUnits: BigInt(4000) } })
      .mockResolvedValueOnce({ _sum: { actualUnits: BigInt(4000) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(0) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(0) } });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-new-version',
        userId: 'user-1',
        activeKey: 'report:sess-new-version:third-hash',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).rejects.toMatchObject({ dimension: 'user', resetAt: RESOURCE_WINDOW_END });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('终态 actualUnits 未知时按完整预留保守结算，不能由僵尸回收退回额度', async () => {
    aggregateMock
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(0) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(0) } })
      .mockResolvedValueOnce({ _sum: { actualUnits: BigInt(0) } })
      .mockResolvedValueOnce({ _sum: { actualUnits: BigInt(0) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(4000) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(4000) } });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-after-unknown',
        userId: 'user-1',
        activeKey: 'report:sess-after-unknown:hash',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).rejects.toMatchObject({
      dimension: 'user',
      resetAt: RESOURCE_WINDOW_END,
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('scope 锁拿到时窗口已过期则在任何统计或建行前关闭失败', async () => {
    queryRawMock.mockImplementation((query: { strings?: string[] }) =>
      query.strings?.join('').includes('UTC_TIMESTAMP')
        ? Promise.resolve([{ admissionNow: RESOURCE_WINDOW_END }])
        : Promise.resolve([{ key: 'lock' }])
    );

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-midnight',
        userId: 'user-1',
        activeKey: 'report:sess-midnight:hash',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).rejects.toBeInstanceOf(ActiveJobReservationWindowExpiredError);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(
      (executeRawMock.mock.calls[0]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('ON DUPLICATE KEY UPDATE');
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(
      (queryRawMock.mock.calls[0]?.[0] as { strings?: string[] }).strings?.join('')
    ).toContain('UTC_TIMESTAMP');
    expect(aggregateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('统计与建行跨 UTC 日界时在提交前回滚旧窗口 claim，并携带 final DB 时间', async () => {
    createMock.mockResolvedValue({ id: 'rolled-back-by-transaction' });
    queryRawMock
      .mockResolvedValueOnce([{ admissionNow: RESOURCE_ADMISSION_NOW }])
      .mockResolvedValueOnce([{ admissionNow: RESOURCE_WINDOW_END }]);

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-final-midnight',
        userId: 'user-1',
        activeKey: 'report:sess-final-midnight:hash',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).rejects.toMatchObject({
      name: 'ActiveJobReservationWindowExpiredError',
      admissionNow: RESOURCE_WINDOW_END,
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  });

  it('同 sourceHash 冲突先返回单飞语义，不误消耗或误报资源预算', async () => {
    findUniqueMock.mockResolvedValue({ id: 'winner' });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.REPORT_GENERATION,
        sessionId: 'sess-1',
        userId: 'user-1',
        activeKey: 'report:sess-1:same-hash',
        resourceReservation: {
          scope: 'llm_report_tokens',
          units: 2000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
        },
      })
    ).rejects.toBeInstanceOf(ActiveJobConflictError);
    expect(aggregateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('owner 在途数量与 claim 共用 scope 锁，超过任务并发上限时不建行', async () => {
    aggregateMock.mockResolvedValueOnce({
      _count: { _all: 1 },
      _sum: { reservedUnits: BigInt(500) },
    });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.TRANSLATION_LLM_PROXY,
        sessionId: 'translation-task-1',
        userId: 'user-1',
        activeKey: 'translation_llm:task:hash-2',
        resourceReservation: {
          scope: 'llm_tokens',
          units: 1000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
          owner: {
            limit: 3000,
            settledUnitsFloor: 0,
            maxActiveJobs: 1,
          },
        },
      })
    ).rejects.toBeInstanceOf(ActiveJobConcurrencyExceededError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('owner 终身预算同时统计业务表下限、已结算、未知终态和在途预留', async () => {
    aggregateMock
      .mockResolvedValueOnce({
        _count: { _all: 0 },
        _sum: { reservedUnits: BigInt(500) },
      })
      .mockResolvedValueOnce({ _sum: { actualUnits: BigInt(1000) } })
      .mockResolvedValueOnce({ _sum: { reservedUnits: BigInt(500) } });

    await expect(
      claimActiveJob({
        type: JOB_TYPE.TRANSLATION_LLM_PROXY,
        sessionId: 'translation-task-1',
        userId: 'user-1',
        activeKey: 'translation_llm:task:hash-3',
        resourceReservation: {
          scope: 'llm_tokens',
          units: 1000,
          perUserLimit: 5000,
          globalLimit: 10_000,
          windowStart: RESOURCE_WINDOW_START,
          windowEnd: RESOURCE_WINDOW_END,
          owner: {
            limit: 3000,
            settledUnitsFloor: 1200,
            maxActiveJobs: 1,
          },
        },
      })
    ).rejects.toMatchObject({ dimension: 'owner' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('资源终态 CAS、成功幂等键保留和业务计量 mutation 在同一事务', async () => {
    findUniqueMock.mockResolvedValueOnce({ resourceScope: 'llm_tokens' });
    const mutation = vi.fn(async (tx: unknown) => {
      void tx;
    });

    await completeActiveJob(
      'proxy-job-1',
      { cached: true },
      20,
      { retainActiveKeyOnSuccess: true, mutation }
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);
    const txArg = mutation.mock.calls[0][0];
    expect(txArg).toMatchObject({ $executeRaw: executeRawMock });
    const settlementSql = executeRawMock.mock.calls[1][0] as {
      strings?: string[];
    };
    expect(settlementSql.strings?.join('')).toContain('activeKey = activeKey');
  });

  it('终态 CAS 提交后丢失响应时以 readback 确认结算，不重复改写', async () => {
    const networkError = new Error('lost after commit');
    settleExecuteRawMock.mockRejectedValue(networkError);
    findUniqueMock.mockResolvedValue({ status: 'SUCCESS' });

    await expect(
      completeActiveJob('strict-job-1', { ok: true }, 123)
    ).resolves.toBeUndefined();
    expect(settleExecuteRawMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 'strict-job-1' },
      select: { status: true },
    });
  });
});
