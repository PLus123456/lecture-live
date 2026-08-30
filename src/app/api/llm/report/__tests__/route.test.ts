import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  verifyAuth: vi.fn(),
  sessionFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  resolveUserFeatureFlags: vi.fn(),
  resolveUserSummaryModels: vi.fn(),
  resolveSummaryModel: vi.fn(),
  loadSessionTranscriptBundle: vi.fn(),
  extractTranscriptText: vi.fn(),
  generateOrReuseSessionReport: vi.fn(),
  invalidateSessionsApiCache: vi.fn(),
  isPaymentBenefitAvailable: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock('@/lib/auth', () => ({ verifyAuth: mocks.verifyAuth }));
vi.mock('@/lib/payment/entitlementAdmission', () => ({
  isPaymentBenefitAvailable: mocks.isPaymentBenefitAvailable,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findUnique: mocks.sessionFindUnique },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock('@/lib/security', () => ({
  assertOwnership: vi.fn(),
  assertSessionReadAccess: vi.fn(),
}));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: mocks.resolveUserFeatureFlags,
  resolveUserSummaryModels: mocks.resolveUserSummaryModels,
}));
vi.mock('@/lib/llm/gateway', () => ({ callLLM: vi.fn() }));
vi.mock('@/lib/llm/summaryModel', () => ({
  resolveSummaryModel: mocks.resolveSummaryModel,
}));
vi.mock('@/lib/apiResponseCache', () => ({
  invalidateSessionsApiCache: mocks.invalidateSessionsApiCache,
}));
vi.mock('@/lib/sessionPersistence', () => ({
  extractTranscriptText: mocks.extractTranscriptText,
  loadSessionTranscriptBundle: mocks.loadSessionTranscriptBundle,
  loadSessionReport: vi.fn(),
}));
vi.mock('@/lib/llm/reportGenerationService', () => ({
  generateOrReuseSessionReport: mocks.generateOrReuseSessionReport,
}));

import { POST } from '@/app/api/llm/report/route';
import { SessionReportBudgetExceededError } from '@/lib/llm/reportManager';
import { ActiveJobBudgetExceededError } from '@/lib/jobQueue';

const SESSION = {
  id: 'session-1',
  userId: 'user-1',
  title: 'Lecture',
  courseName: 'Security',
  durationMs: 60_000,
  createdAt: new Date('2026-08-20T00:00:00.000Z'),
  targetLang: 'en',
  recordingPath: null,
  transcriptPath: 'transcript.json',
  summaryPath: 'summary.json',
};

function request() {
  return new Request('http://localhost/api/llm/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION.id }),
  });
}

describe('POST /api/llm/report single-flight response', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.enforceRateLimit.mockResolvedValue(null);
    mocks.isPaymentBenefitAvailable.mockResolvedValue(true);
    mocks.verifyAuth.mockResolvedValue({ id: 'user-1' });
    mocks.sessionFindUnique.mockResolvedValue(SESSION);
    mocks.userFindUnique.mockResolvedValue({ role: 'USER', customGroupId: null });
    mocks.resolveUserFeatureFlags.mockResolvedValue({ allowFinalSummary: true });
    mocks.resolveUserSummaryModels.mockResolvedValue({ finalSummaryModelId: null });
    mocks.resolveSummaryModel.mockResolvedValue({
      routing: { purpose: 'FINAL_SUMMARY' },
      provider: {
        dbModelId: 'model-1',
        contextWindow: 16_384,
        maxTokens: 4096,
      },
    });
    mocks.loadSessionTranscriptBundle.mockResolvedValue({
      segments: [{ id: 'segment-1', text: 'lecture text' }],
      summaries: [],
    });
    mocks.extractTranscriptText.mockReturnValue('lecture text '.repeat(20));
  });

  it('未认证请求不消耗报告限流桶', async () => {
    mocks.verifyAuth.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('同版本正在生成时返回明确 202 + Retry-After，不谎报完成', async () => {
    mocks.generateOrReuseSessionReport.mockResolvedValue({
      status: 'in_progress',
      sourceHash: 'a'.repeat(64),
      plan: {
        providerCalls: 2,
        reservedTokens: 10_000,
        chunkCount: 0,
        usesMapReduce: false,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ key: 'user:user-1' })
    );
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      inProgress: true,
    });
    expect(mocks.invalidateSessionsApiCache).not.toHaveBeenCalled();
  });

  it('有效缓存复用仍返回 200，且不做无意义缓存失效', async () => {
    mocks.generateOrReuseSessionReport.mockResolvedValue({
      status: 'reused',
      sourceHash: 'b'.repeat(64),
      reportPath: 'reports/existing.json',
      reportData: {
        significance: {
          score: 0.1,
          reason: 'not enough content',
          isWorthSummarizing: false,
        },
        report: null,
        generatedAt: '2026-08-20T00:00:00.000Z',
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      reused: true,
      hasReport: false,
    });
    expect(mocks.invalidateSessionsApiCache).not.toHaveBeenCalled();
  });

  it('整次工作量超过硬预算时返回 413', async () => {
    mocks.generateOrReuseSessionReport.mockRejectedValue(
      new SessionReportBudgetExceededError({
        providerCalls: 500,
        reservedTokens: 2_000_000,
        chunkCount: 498,
        usesMapReduce: true,
      })
    );

    const response = await POST(request());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      providerCalls: 500,
      reservedTokens: 2_000_000,
    });
  });

  it('新版本无法取得共享预留时返回 429 + Retry-After', async () => {
    mocks.generateOrReuseSessionReport.mockRejectedValue(
      new ActiveJobBudgetExceededError(
        'llm_report_tokens',
        'user',
        2_000_000,
        5_000_000
      )
    );

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Report generation token budget exhausted',
      dimension: 'user',
    });
  });
});
