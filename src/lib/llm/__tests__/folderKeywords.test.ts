import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockActiveJobConflictError extends Error {
    constructor(readonly activeKey: string) {
      super(`Active job already exists for ${activeKey}`);
      this.name = 'ActiveJobConflictError';
    }
  }
  class MockWindowExpiredError extends Error {
    constructor(
      readonly scope: string,
      readonly admissionNow: Date,
      readonly windowStart: Date,
      readonly windowEnd: Date
    ) {
      super(`${scope} window expired`);
      this.name = 'ActiveJobReservationWindowExpiredError';
    }
  }
  return {
    MockActiveJobConflictError,
    MockWindowExpiredError,
    markerReadRaw: vi.fn(),
    markerWriteRaw: vi.fn(),
    keywordCount: vi.fn(),
    keywordFindMany: vi.fn(),
    keywordUpdate: vi.fn(),
    keywordCreate: vi.fn(),
    keywordUpsert: vi.fn(),
    keywordDeleteMany: vi.fn(),
    getProvider: vi.fn(),
    callLLM: vi.fn(),
    claimActiveJob: vi.fn(),
    completeActiveJob: vi.fn(),
    failActiveJob: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: mocks.markerReadRaw,
    $executeRaw: mocks.markerWriteRaw,
    folderKeyword: {
      count: mocks.keywordCount,
      findMany: mocks.keywordFindMany,
      update: mocks.keywordUpdate,
      create: mocks.keywordCreate,
      upsert: mocks.keywordUpsert,
      deleteMany: mocks.keywordDeleteMany,
    },
  },
}));

vi.mock('@/lib/llm/gateway', () => ({
  getProviderForPurpose: mocks.getProvider,
  callLLM: mocks.callLLM,
}));

vi.mock('@/lib/jobQueue', () => ({
  ActiveJobConflictError: mocks.MockActiveJobConflictError,
  ActiveJobReservationWindowExpiredError: mocks.MockWindowExpiredError,
  claimActiveJob: mocks.claimActiveJob,
  completeActiveJob: mocks.completeActiveJob,
  failActiveJob: mocks.failActiveJob,
  JOB_TYPE: { KEYWORD_EXTRACTION: 'keyword_extraction' },
}));

vi.mock('@/lib/payment/entitlementAdmission', () => ({
  assertPaymentBenefitAvailable: vi.fn().mockResolvedValue(undefined),
}));

import { extractAndAccumulateKeywords } from '@/lib/llm/folderKeywords';

const PROVIDER = {
  name: 'provider',
  model: 'keyword-model',
  dbModelId: 'model-1',
  maxTokens: 4096,
};

describe('extractAndAccumulateKeywords SEC-011 admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProvider.mockResolvedValue(PROVIDER);
    mocks.markerReadRaw.mockResolvedValue([{ sourceHash: null }]);
    mocks.markerWriteRaw.mockResolvedValue(1);
    mocks.keywordCount.mockResolvedValue(0);
    mocks.keywordFindMany.mockResolvedValue([]);
    mocks.keywordUpdate.mockResolvedValue({});
    mocks.keywordCreate.mockImplementation(async ({ data }) => ({
      id: `created-${data.keyword}`,
      ...data,
    }));
    mocks.claimActiveJob.mockResolvedValue('keyword-job-1');
    mocks.completeActiveJob.mockResolvedValue(undefined);
    mocks.failActiveJob.mockResolvedValue(undefined);
    mocks.callLLM.mockResolvedValue('[]');
  });

  it('空 transcript 是本地空操作，不解析模型也不 claim', async () => {
    await expect(
      extractAndAccumulateKeywords('session-1', 'folder-1', 'user-1', '   ')
    ).resolves.toEqual([]);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.claimActiveJob).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('整次最坏 token 在共享日账原子预留，可信 usage 按实际结算且空数组落有效否定 marker', async () => {
    mocks.callLLM.mockImplementation(
      async (
        _system: string,
        _user: string,
        options: { onUsage?: (usage: { totalTokens: number }) => void }
      ) => {
        options.onUsage?.({ totalTokens: 19 });
        return '[]';
      }
    );

    const result = await extractAndAccumulateKeywords(
      'session-1',
      'folder-1',
      'user-1',
      'A lecture about distributed systems.'
    );

    expect(result).toEqual([]);
    expect(mocks.claimActiveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'keyword_extraction',
        sessionId: 'session-1',
        userId: 'user-1',
        activeKey: 'folder_keywords:session-1:folder-1',
        resourceReservation: expect.objectContaining({
          scope: 'llm_tokens',
          units: expect.any(Number),
        }),
      })
    );
    expect(mocks.claimActiveJob.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.callLLM.mock.invocationCallOrder[0]
    );
    expect(mocks.markerWriteRaw).toHaveBeenCalledTimes(1);
    const markerSql = mocks.markerWriteRaw.mock.calls[0]?.[0] as {
      strings?: string[];
      values?: unknown[];
    };
    expect(markerSql.strings?.join('')).toContain('UPDATE FolderSession');
    expect(markerSql.strings?.join('')).toContain(
      'folderKeywordGeneratedAt = UTC_TIMESTAMP(3)'
    );
    expect(markerSql.values).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[a-f0-9]{64}$/),
        'folder-1',
        'session-1',
      ])
    );
    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'keyword-job-1',
      expect.objectContaining({
        actualTokens: 19,
        providerMeasuredCalls: 1,
        conservativeFallbackCalls: 0,
        keywordCount: 0,
      }),
      19
    );
  });

  it('已知词查询和 prompt 都有共享策略边界，不会复制第 201 项', async () => {
    mocks.keywordFindMany.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({
        id: `keyword-${index}`,
        keyword: index === 200 ? 'CANARY-OVER-LIMIT' : `known-${index}`,
        confidence: 1,
        usageCount: 1,
      }))
    );

    await extractAndAccumulateKeywords(
      'session-1',
      'folder-1',
      'user-1',
      'A normal lecture.'
    );

    expect(mocks.keywordFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 200,
        orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
      })
    );
    const system = mocks.callLLM.mock.calls[0]?.[0] as string;
    expect(system).toContain('known-0');
    expect(system).not.toContain('CANARY-OVER-LIMIT');
    expect(new TextEncoder().encode(system).byteLength).toBeLessThan(20 * 1024);
  });

  it('provider 断连时按单调用上界结算 FAILED，不写 marker', async () => {
    mocks.callLLM.mockRejectedValue(new Error('provider disconnected'));

    await expect(
      extractAndAccumulateKeywords(
        'session-1',
        'folder-1',
        'user-1',
        'A normal lecture.'
      )
    ).rejects.toThrow('provider disconnected');

    const reserved = (
      mocks.claimActiveJob.mock.calls[0]?.[0] as {
        resourceReservation: { units: number };
      }
    ).resourceReservation.units;
    expect(mocks.failActiveJob).toHaveBeenCalledWith(
      'keyword-job-1',
      expect.any(Error),
      expect.objectContaining({
        actualTokens: reserved,
        conservativeFallbackCalls: 1,
      }),
      reserved
    );
    expect(mocks.markerWriteRaw).not.toHaveBeenCalled();
  });

  it('同 session-folder 在途冲突直接复用单飞语义，零 provider 调用', async () => {
    mocks.claimActiveJob.mockRejectedValue(
      new mocks.MockActiveJobConflictError(
        'folder_keywords:session-1:folder-1'
      )
    );

    await expect(
      extractAndAccumulateKeywords(
        'session-1',
        'folder-1',
        'user-1',
        'A normal lecture.'
      )
    ).resolves.toEqual([]);
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.completeActiveJob).not.toHaveBeenCalled();
  });

  it('claim 成功后发现 winner 已落 marker 时以 0 usage 完成 loser', async () => {
    let sourceHash = '';
    mocks.claimActiveJob.mockImplementation(async (options) => {
      sourceHash = options.params.sourceHash;
      return 'keyword-job-loser';
    });
    mocks.markerReadRaw
      .mockResolvedValueOnce([{ sourceHash: null }])
      .mockImplementation(async () => [{ sourceHash }]);

    await expect(
      extractAndAccumulateKeywords(
        'session-1',
        'folder-1',
        'user-1',
        'A normal lecture.'
      )
    ).resolves.toEqual([]);

    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'keyword-job-loser',
      expect.objectContaining({ reusedAfterClaim: true, actualTokens: 0 }),
      0
    );
  });

  it('不同 sourceHash winner 在等待 claim 期间落 marker 时旧请求 0 usage 失败，不能回退 marker', async () => {
    mocks.markerReadRaw
      .mockResolvedValueOnce([{ sourceHash: null }])
      .mockResolvedValueOnce([{ sourceHash: 'f'.repeat(64) }]);

    await expect(
      extractAndAccumulateKeywords(
        'session-1',
        'folder-1',
        'user-1',
        'An older transcript version.'
      )
    ).rejects.toThrow(
      'Folder keyword source changed while waiting for generation claim'
    );

    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.markerWriteRaw).not.toHaveBeenCalled();
    expect(mocks.failActiveJob).toHaveBeenCalledWith(
      'keyword-job-1',
      expect.any(Error),
      expect.objectContaining({ actualTokens: 0 }),
      0
    );
  });

  it('旧 source 行会回填 durable marker，不在升级后重复付费', async () => {
    mocks.keywordCount.mockResolvedValue(2);

    await expect(
      extractAndAccumulateKeywords(
        'session-1',
        'folder-1',
        'user-1',
        'A normal lecture.'
      )
    ).resolves.toEqual([]);

    expect(mocks.markerWriteRaw).toHaveBeenCalledTimes(1);
    expect(mocks.claimActiveJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeActiveJob).toHaveBeenCalledWith(
      'keyword-job-1',
      expect.objectContaining({ legacyMarkerBackfill: true, actualTokens: 0 }),
      0
    );
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});
