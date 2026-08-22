import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockActiveJobConflictError extends Error {
    constructor(readonly activeKey: string) {
      super(`Active job already exists for ${activeKey}`);
      this.name = 'ActiveJobConflictError';
    }
  }

  class MockActiveJobReservationWindowExpiredError extends Error {
    constructor(
      readonly scope: string,
      readonly admissionNow: Date,
      readonly windowStart: Date,
      readonly windowEnd: Date
    ) {
      super(`${scope} resource reservation window expired`);
      this.name = 'ActiveJobReservationWindowExpiredError';
    }
  }

  return {
    MockActiveJobConflictError,
    MockActiveJobReservationWindowExpiredError,
    findUnique: vi.fn(),
    sessionUpdateMany: vi.fn(),
    claimActiveJob: vi.fn(),
    completeActiveJob: vi.fn(),
    failActiveJob: vi.fn(),
    loadSessionReport: vi.fn(),
    stageArtifact: vi.fn(),
    completeStagedArtifactPublishes: vi.fn(),
    settleStagedArtifactsInTransaction: vi.fn(),
    rollbackStagedArtifact: vi.fn(),
    getStoredArtifactById: vi.fn(),
    planSessionReportWork: vi.fn(),
    assertWithinBudget: vi.fn(),
    generateSessionReport: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: mocks.findUnique,
      updateMany: mocks.sessionUpdateMany,
    },
    $transaction: vi.fn(async (callback) =>
      callback({ session: { updateMany: mocks.sessionUpdateMany } })
    ),
  },
}));

vi.mock('@/lib/jobQueue', () => ({
  ActiveJobConflictError: mocks.MockActiveJobConflictError,
  ActiveJobReservationWindowExpiredError:
    mocks.MockActiveJobReservationWindowExpiredError,
  claimActiveJob: mocks.claimActiveJob,
  completeActiveJob: mocks.completeActiveJob,
  failActiveJob: mocks.failActiveJob,
  JOB_TYPE: { REPORT_GENERATION: 'report_generation' },
}));

vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionReport: mocks.loadSessionReport,
  stageArtifact: mocks.stageArtifact,
  completeStagedArtifactPublishes: mocks.completeStagedArtifactPublishes,
  settleStagedArtifactsInTransaction:
    mocks.settleStagedArtifactsInTransaction,
  rollbackStagedArtifact: mocks.rollbackStagedArtifact,
}));

vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_STATE: { ACTIVE: 'ACTIVE', RESERVED: 'RESERVED' },
  getStoredArtifactById: mocks.getStoredArtifactById,
}));

vi.mock('@/lib/llm/reportManager', () => ({
  planSessionReportWork: mocks.planSessionReportWork,
  assertSessionReportWorkWithinBudget: mocks.assertWithinBudget,
  generateSessionReport: mocks.generateSessionReport,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn() }),
  },
  serializeError: (error: unknown) => String(error),
}));

import {
  computeSessionReportSourceHash,
  generateOrReuseSessionReport,
  REPORT_GENERATION_SCHEMA_VERSION,
  SessionReportGenerationError,
  type GenerateOrReuseSessionReportOptions,
} from '@/lib/llm/reportGenerationService';

const PLAN = {
  providerCalls: 2,
  reservedTokens: 12_000,
  chunkCount: 0,
  usesMapReduce: false,
};

interface MockGenerateOptions {
  callLLM: (system: string, user: string) => Promise<string>;
}

function options(
  overrides: Partial<GenerateOrReuseSessionReportOptions> = {}
): GenerateOrReuseSessionReportOptions {
  return {
    session: {
      id: 'session-1',
      userId: 'user-1',
      recordingPath: null,
      transcriptPath: 'sessions/session-1/transcript.json',
      summaryPath: null,
    },
    transcript: 'A substantive lecture transcript. '.repeat(10),
    sessionTitle: 'Lecture one',
    courseName: 'Security',
    durationMs: 60_000,
    date: '2026-08-20',
    summaryBlocks: [],
    language: 'en',
    callLLM: vi.fn().mockResolvedValue('{}'),
    contextWindow: 16_384,
    maxOutputTokens: 4096,
    modelKey: 'model:summary-1',
    triggeredBy: 'system',
    ...overrides,
  };
}

function cachedArtifact(
  sourceHash: string,
  isWorthSummarizing: boolean,
  report: Record<string, unknown> | null
) {
  const completeReport =
    report === null
      ? null
      : {
          title: 'Report',
          topic: 'Security',
          participants: ['Lecturer'],
          date: '2026-08-20',
          duration: '1 min',
          overview: 'Overview',
          sections: [],
          conclusions: [],
          actionItems: [],
          keyTerms: {},
          ...report,
        };
  return {
    significance: {
      score: isWorthSummarizing ? 0.9 : 0.1,
      reason: 'test',
      isWorthSummarizing,
    },
    report: completeReport,
    generatedAt: '2026-08-20T00:00:00.000Z',
    _generation: {
      schemaVersion: REPORT_GENERATION_SCHEMA_VERSION,
      sourceHash,
    },
  };
}

describe('reportGenerationService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUnique.mockResolvedValue({ reportPath: null });
    mocks.claimActiveJob.mockResolvedValue('job-1');
    mocks.completeActiveJob.mockResolvedValue(undefined);
    mocks.failActiveJob.mockResolvedValue(undefined);
    mocks.planSessionReportWork.mockReturnValue(PLAN);
    mocks.stageArtifact.mockResolvedValue({
      category: 'reports',
      reference: 'sessions/session-1/report-version.json',
      localReference: 'sessions/session-1/report-version.json',
      storage: 'local',
      previousReference: null,
      storedArtifactId: 'report-artifact-1',
      expectedPreviousArtifactId: null,
      actualBytes: 10,
      artifactType: 'report',
    });
    mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.settleStagedArtifactsInTransaction.mockResolvedValue([
      { staged: {}, settled: { artifact: {}, previous: null } },
    ]);
    mocks.completeStagedArtifactPublishes.mockResolvedValue([]);
    mocks.getStoredArtifactById.mockResolvedValue({ state: 'RESERVED' });
    mocks.rollbackStagedArtifact.mockResolvedValue(undefined);
    mocks.generateSessionReport.mockResolvedValue(
      cachedArtifact('ignored-until-service-adds-envelope', true, { title: 'ok' })
    );
  });

  it('同 sourceHash 的有效正结果直接复用，不 claim、不调用 provider', async () => {
    const input = options();
    const sourceHash = computeSessionReportSourceHash(input);
    mocks.findUnique.mockResolvedValue({ reportPath: 'reports/existing.json' });
    mocks.loadSessionReport.mockResolvedValue(
      cachedArtifact(sourceHash, true, { title: 'cached' })
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result).toMatchObject({
      status: 'reused',
      reportPath: 'reports/existing.json',
      sourceHash,
    });
    expect(mocks.claimActiveJob).not.toHaveBeenCalled();
    expect(mocks.assertWithinBudget).not.toHaveBeenCalled();
    expect(input.callLLM).not.toHaveBeenCalled();
  });

  it('report:null + 不值得总结是可复用的有效否定结果', async () => {
    const input = options();
    const sourceHash = computeSessionReportSourceHash(input);
    mocks.findUnique.mockResolvedValue({ reportPath: 'reports/negative.json' });
    mocks.loadSessionReport.mockResolvedValue(
      cachedArtifact(sourceHash, false, null)
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result.status).toBe('reused');
    if (result.status === 'reused') {
      expect(result.reportData.report).toBeNull();
    }
    expect(mocks.claimActiveJob).not.toHaveBeenCalled();
  });

  it('值得总结但 report:null 不是有效缓存，会重新生成', async () => {
    const input = options();
    const sourceHash = computeSessionReportSourceHash(input);
    mocks.findUnique.mockResolvedValue({ reportPath: 'reports/broken.json' });
    mocks.loadSessionReport.mockResolvedValue(
      cachedArtifact(sourceHash, true, null)
    );
    mocks.generateSessionReport.mockResolvedValue(
      cachedArtifact('service-will-replace-this', true, { title: 'regenerated' })
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result.status).toBe('generated');
    expect(mocks.claimActiveJob).toHaveBeenCalledTimes(1);
    expect(mocks.stageArtifact).toHaveBeenCalledTimes(1);
  });

  it('同 hash 但结构损坏的正报告不算有效缓存', async () => {
    const input = options();
    const sourceHash = computeSessionReportSourceHash(input);
    const broken = {
      ...cachedArtifact(sourceHash, true, { title: 'unused' }),
      report: { title: 'incomplete' },
    };
    mocks.findUnique.mockResolvedValue({ reportPath: 'reports/broken.json' });
    mocks.loadSessionReport.mockResolvedValue(broken);

    const result = await generateOrReuseSessionReport(input);

    expect(result.status).toBe('generated');
    expect(mocks.claimActiveJob).toHaveBeenCalledTimes(1);
  });

  it('并发唯一键冲突且 winner 尚未落盘时返回 in_progress', async () => {
    const input = options();
    mocks.findUnique.mockResolvedValue({ reportPath: null });
    mocks.claimActiveJob.mockRejectedValue(
      new mocks.MockActiveJobConflictError('report:session-1:hash')
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result.status).toBe('in_progress');
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    expect(mocks.generateSessionReport).not.toHaveBeenCalled();
    expect(input.callLLM).not.toHaveBeenCalled();
  });

  it('唯一键冲突与 winner 落盘擦肩时二次读取并直接复用', async () => {
    const input = options();
    const sourceHash = computeSessionReportSourceHash(input);
    mocks.findUnique
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: 'reports/winner.json' });
    mocks.claimActiveJob.mockRejectedValue(
      new mocks.MockActiveJobConflictError(`report:session-1:${sourceHash}`)
    );
    mocks.loadSessionReport.mockResolvedValue(
      cachedArtifact(sourceHash, true, { title: 'winner' })
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result).toMatchObject({
      status: 'reused',
      reportPath: 'reports/winner.json',
      sourceHash,
    });
    expect(mocks.generateSessionReport).not.toHaveBeenCalled();
  });

  it('初读 miss 后 winner 已完成且 claim 因预算失败时仍优先复用 exact-hash 缓存', async () => {
    const input = options();
    const sourceHash = computeSessionReportSourceHash(input);
    mocks.findUnique
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: 'reports/winner.json' });
    mocks.claimActiveJob.mockRejectedValue(new Error('daily budget exhausted'));
    mocks.loadSessionReport.mockResolvedValue(
      cachedArtifact(sourceHash, true, { title: 'winner' })
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result).toMatchObject({
      status: 'reused',
      reportPath: 'reports/winner.json',
      sourceHash,
    });
    expect(mocks.generateSessionReport).not.toHaveBeenCalled();
  });

  it('winner 在初读 miss 后已完成并释放 activeKey 时，loser claim 后二次命中且零 provider', async () => {
    const input = options();
    const sourceHash = computeSessionReportSourceHash(input);
    mocks.findUnique
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: 'reports/winner.json' });
    mocks.loadSessionReport.mockResolvedValue(
      cachedArtifact(sourceHash, true, { title: 'winner' })
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result).toMatchObject({
      status: 'reused',
      reportPath: 'reports/winner.json',
    });
    expect(mocks.claimActiveJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ reusedAfterClaim: true, actualTokens: 0 }),
      0
    );
    expect(mocks.generateSessionReport).not.toHaveBeenCalled();
    expect(input.callLLM).not.toHaveBeenCalled();
  });

  it('不同 sourceHash 在 claim 间隙发布时旧请求关闭失败，不能前移 CAS baseline 覆盖新版本', async () => {
    const input = options();
    mocks.findUnique
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: 'reports/newer-version.json' });
    mocks.loadSessionReport.mockResolvedValue(
      cachedArtifact('different-source-hash', true, { title: 'newer' })
    );

    await expect(generateOrReuseSessionReport(input)).rejects.toThrow(
      'report artifact changed while waiting for generation claim'
    );

    expect(mocks.failActiveJob).toHaveBeenCalledWith(
      'job-1',
      expect.any(SessionReportGenerationError),
      expect.objectContaining({ actualTokens: 0, providerCallsStarted: 0 }),
      0
    );
    expect(mocks.generateSessionReport).not.toHaveBeenCalled();
    expect(input.callLLM).not.toHaveBeenCalled();
    expect(mocks.stageArtifact).not.toHaveBeenCalled();
  });

  it('生成前原子记录整次预留，生成后持久化并 await 成功终态', async () => {
    const callLLM = vi.fn().mockResolvedValue('{}');
    const input = options({ callLLM });
    mocks.generateSessionReport.mockImplementation(
      async (generateOptions: MockGenerateOptions) => {
        await generateOptions.callLLM('system-1', 'user-1');
        await generateOptions.callLLM('system-2', 'user-2');
        return cachedArtifact('service-will-replace-this', true, {
          title: 'fresh',
        });
      }
    );

    const result = await generateOrReuseSessionReport(input);

    expect(result.status).toBe('generated');
    expect(mocks.claimActiveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'report_generation',
        sessionId: 'session-1',
        activeKey: expect.stringMatching(/^report:session-1:[a-f0-9]{64}$/),
        params: expect.objectContaining({
          reservedTokens: PLAN.reservedTokens,
          providerCalls: PLAN.providerCalls,
        }),
        resourceReservation: {
          scope: 'llm_tokens',
          units: PLAN.reservedTokens,
          perUserLimit: 5_000_000,
          globalLimit: 20_000_000,
          windowStart: expect.any(Date),
          windowEnd: expect.any(Date),
        },
      })
    );
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(mocks.stageArtifact).toHaveBeenCalledWith(
      input.session,
      'reports',
      expect.stringContaining('"sourceHash"'),
      { previousReference: null }
    );
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', reportPath: null },
      data: { reportPath: 'sessions/session-1/report-version.json' },
    });
    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        providerCallsStarted: 2,
        actualTokens: 8348,
        providerMeasuredCalls: 0,
        conservativeFallbackCalls: 2,
      }),
      8348
    );
    expect(mocks.failActiveJob).not.toHaveBeenCalled();
  });

  it('UTC 日界后才取得资源锁时按数据库时间重算窗口并只重试 claim', async () => {
    const oldStart = new Date('2026-08-20T00:00:00.000Z');
    const oldEnd = new Date('2026-08-21T00:00:00.000Z');
    const admissionNow = new Date('2026-08-21T00:00:00.100Z');
    mocks.claimActiveJob
      .mockRejectedValueOnce(
        new mocks.MockActiveJobReservationWindowExpiredError(
          'llm_tokens',
          admissionNow,
          oldStart,
          oldEnd
        )
      )
      .mockResolvedValueOnce('job-new-day');

    await generateOrReuseSessionReport(options());

    expect(mocks.claimActiveJob).toHaveBeenCalledTimes(2);
    expect(mocks.claimActiveJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        resourceReservation: expect.objectContaining({
          windowStart: new Date('2026-08-21T00:00:00.000Z'),
          windowEnd: new Date('2026-08-22T00:00:00.000Z'),
        }),
      })
    );
    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'job-new-day',
      expect.any(Object),
      expect.any(Number)
    );
  });

  it('provider usage 完整时按实测结算，并把 planner 输出上限锁到真实调用', async () => {
    const callLLM = vi.fn(
      async (
        _system: string,
        _user: string,
        execution: {
          maxOutputTokens: number;
          onUsage: (usage: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          }) => void;
        }
      ) => {
        execution.onUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
        return '{}';
      }
    );
    const input = options({ callLLM });
    mocks.generateSessionReport.mockImplementation(
      async (generateOptions: MockGenerateOptions) => {
        await generateOptions.callLLM('system-1', 'user-1');
        await generateOptions.callLLM('system-2', 'user-2');
        return cachedArtifact('unused', true, { title: 'fresh' });
      }
    );

    await generateOrReuseSessionReport(input);

    expect(callLLM).toHaveBeenCalledWith(
      'system-1',
      'user-1',
      expect.objectContaining({ maxOutputTokens: 4096 })
    );
    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        actualTokens: 30,
        providerMeasuredCalls: 2,
        conservativeFallbackCalls: 0,
      }),
      30
    );
  });

  it.each([
    ['usage 全缺失', undefined],
    ['usage 只有 input', { inputTokens: 12 }],
    ['usage 夸大越过本调用预留', { totalTokens: Number.MAX_SAFE_INTEGER }],
    ['非空付费调用却上报 0', { totalTokens: 0 }],
  ])('%s 时按每调用上界保守结算', async (_label, usage) => {
    const callLLM = vi.fn(
      async (
        _system: string,
        _user: string,
        execution: {
          onUsage: (value: typeof usage) => void;
        }
      ) => {
        execution.onUsage(usage);
        return '{}';
      }
    );
    const input = options({ callLLM });
    mocks.generateSessionReport.mockImplementation(
      async (generateOptions: MockGenerateOptions) => {
        await generateOptions.callLLM('system-1', 'user-1');
        return cachedArtifact('unused', true, { title: 'fresh' });
      }
    );

    await generateOrReuseSessionReport(input);

    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        actualTokens: 4174,
        providerMeasuredCalls: 0,
        conservativeFallbackCalls: 1,
      }),
      4174
    );
  });

  it('不同版本抢先发布导致 CAS 失败时回滚 staged 对象并记任务失败', async () => {
    const input = options();
    mocks.sessionUpdateMany.mockResolvedValue({ count: 0 });

    await expect(generateOrReuseSessionReport(input)).rejects.toThrow(
      'report artifact changed while generation was running'
    );

    expect(mocks.rollbackStagedArtifact).toHaveBeenCalledWith(
      input.session,
      expect.objectContaining({
        reference: 'sessions/session-1/report-version.json',
      })
    );
    expect(mocks.completeStagedArtifactPublishes).not.toHaveBeenCalled();
    expect(mocks.failActiveJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeActiveJob).not.toHaveBeenCalled();
  });

  it('CAS 已提交但响应丢失时以 readback 为准，不删除 Session 正引用的对象', async () => {
    const input = options();
    const networkError = new Error('connection lost after commit');
    mocks.findUnique
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({
        reportPath: 'sessions/session-1/report-version.json',
      });
    mocks.sessionUpdateMany.mockRejectedValue(networkError);
    mocks.getStoredArtifactById.mockResolvedValueOnce({
      state: 'ACTIVE',
      reference: 'sessions/session-1/report-version.json',
    });

    const result = await generateOrReuseSessionReport(input);

    expect(result).toMatchObject({
      status: 'generated',
      reportPath: 'sessions/session-1/report-version.json',
    });
    expect(mocks.rollbackStagedArtifact).not.toHaveBeenCalled();
    expect(mocks.completeStagedArtifactPublishes).not.toHaveBeenCalled();
    expect(mocks.completeActiveJob).toHaveBeenCalledTimes(1);
    expect(mocks.failActiveJob).not.toHaveBeenCalled();
  });

  it('CAS readback 显示第三方新版本时只回滚本次 staged 对象', async () => {
    const input = options();
    mocks.findUnique
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: 'reports/third-party.json' });
    mocks.sessionUpdateMany.mockResolvedValue({ count: 0 });

    await expect(generateOrReuseSessionReport(input)).rejects.toThrow(
      'report artifact changed while generation was running'
    );

    expect(mocks.rollbackStagedArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.completeStagedArtifactPublishes).not.toHaveBeenCalled();
  });

  it('CAS 与 readback 都失败时保留 staged 对象，避免误删未知提交结果', async () => {
    const input = options();
    const publishError = new Error('publish response lost');
    mocks.findUnique
      .mockResolvedValueOnce({ reportPath: null })
      .mockResolvedValueOnce({ reportPath: null })
      .mockRejectedValueOnce(new Error('readback unavailable'));
    mocks.sessionUpdateMany.mockRejectedValue(publishError);

    await expect(generateOrReuseSessionReport(input)).rejects.toBe(publishError);

    expect(mocks.rollbackStagedArtifact).not.toHaveBeenCalled();
    expect(mocks.completeStagedArtifactPublishes).not.toHaveBeenCalled();
    expect(mocks.failActiveJob).toHaveBeenCalledTimes(1);
  });

  it('预算门禁失败发生在 claim/provider 前，但不阻止已有缓存复用', async () => {
    const input = options();
    const budgetError = new Error('over budget');
    mocks.assertWithinBudget.mockImplementation(() => {
      throw budgetError;
    });

    await expect(generateOrReuseSessionReport(input)).rejects.toBe(budgetError);

    expect(mocks.claimActiveJob).not.toHaveBeenCalled();
    expect(mocks.generateSessionReport).not.toHaveBeenCalled();
    expect(input.callLLM).not.toHaveBeenCalled();
  });

  it('生成器超出已预留调用次数时失败并释放正常失败 claim', async () => {
    const input = options();
    mocks.planSessionReportWork.mockReturnValue({ ...PLAN, providerCalls: 1 });
    mocks.generateSessionReport.mockImplementation(
      async (generateOptions: MockGenerateOptions) => {
        await generateOptions.callLLM('system-1', 'user-1');
        await generateOptions.callLLM('system-2', 'user-2');
        return cachedArtifact('unused', true, { title: 'never returned' });
      }
    );

    await expect(generateOrReuseSessionReport(input)).rejects.toBeInstanceOf(
      SessionReportGenerationError
    );

    expect(mocks.failActiveJob).toHaveBeenCalledWith(
      'job-1',
      expect.any(SessionReportGenerationError),
      expect.objectContaining({ providerCallsStarted: 1 }),
      expect.any(Number)
    );
    expect(mocks.completeActiveJob).not.toHaveBeenCalled();
    expect(mocks.stageArtifact).not.toHaveBeenCalled();
  });

  it('值得总结但生成结果为空时记失败，不把 report:null 当永久有效结果', async () => {
    const input = options();
    mocks.generateSessionReport.mockResolvedValue(
      cachedArtifact('unused', true, null)
    );

    await expect(generateOrReuseSessionReport(input)).rejects.toBeInstanceOf(
      SessionReportGenerationError
    );

    expect(mocks.stageArtifact).not.toHaveBeenCalled();
    expect(mocks.failActiveJob).toHaveBeenCalledTimes(1);
  });

  it('失败终态写入也失败时保留原始错误，让 PROCESSING 键交给僵尸回收', async () => {
    const input = options();
    const providerError = new Error('provider failed');
    mocks.generateSessionReport.mockRejectedValue(providerError);
    mocks.failActiveJob.mockRejectedValue(new Error('terminal update failed'));

    await expect(generateOrReuseSessionReport(input)).rejects.toBe(providerError);

    expect(mocks.failActiveJob).toHaveBeenCalledWith(
      'job-1',
      providerError,
      expect.objectContaining({ actualTokens: 0 }),
      0
    );
    expect(mocks.completeActiveJob).not.toHaveBeenCalled();
  });

  it('成功终态写入失败不会反写 FAILED；已持久化结果可供后续请求复用', async () => {
    const input = options();
    const terminalError = new Error('success terminal update failed');
    mocks.completeActiveJob.mockRejectedValue(terminalError);

    await expect(generateOrReuseSessionReport(input)).rejects.toBe(terminalError);

    expect(mocks.stageArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.failActiveJob).not.toHaveBeenCalled();
  });

  it('sourceHash 对键顺序稳定，覆盖内容/模型，但可任意改名的显示标题不制造新付费版本', () => {
    const base = options();
    const first = computeSessionReportSourceHash(base);
    const same = computeSessionReportSourceHash({
      ...base,
      summaryBlocks: base.summaryBlocks.map((block) => ({ ...block })),
    });

    expect(same).toBe(first);
    expect(
      computeSessionReportSourceHash({ ...base, transcript: `${base.transcript}!` })
    ).not.toBe(first);
    expect(
      computeSessionReportSourceHash({ ...base, sessionTitle: 'Changed title' })
    ).toBe(first);
    expect(
      computeSessionReportSourceHash({ ...base, modelKey: 'model:summary-2' })
    ).not.toBe(first);
  });
});
