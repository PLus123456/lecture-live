import { describe, expect, it } from 'vitest';
import {
  assertSessionReportWorkWithinBudget,
  generateSessionReport,
  planSessionReportWork,
  REPORT_MAX_PROVIDER_CALLS,
  REPORT_MAX_RESERVED_TOKENS,
  SessionReportBudgetExceededError,
  type PlanReportWorkOptions,
} from '@/lib/llm/reportManager';

function work(
  overrides: Partial<PlanReportWorkOptions> = {}
): PlanReportWorkOptions {
  return {
    transcript: 'A substantive lecture sentence. '.repeat(20),
    sessionTitle: 'Lecture',
    courseName: 'Security',
    durationMs: 60_000,
    date: '2026-08-20',
    summaryBlocks: [],
    language: 'en',
    contextWindow: 16_384,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

describe('session report whole-operation budget', () => {
  it('短 transcript 是零 provider 工作量，正常小报告保持可用', () => {
    const short = planSessionReportWork(work({ transcript: 'too short' }));
    expect(short).toEqual({
      providerCalls: 0,
      reservedTokens: 0,
      chunkCount: 0,
      usesMapReduce: false,
    });
    expect(() => assertSessionReportWorkWithinBudget(short)).not.toThrow();

    const normal = planSessionReportWork(work());
    expect(normal.providerCalls).toBe(2);
    expect(normal.usesMapReduce).toBe(false);
    expect(normal.reservedTokens).toBeGreaterThan(0);
    expect(() => assertSessionReportWorkWithinBudget(normal)).not.toThrow();
  });

  it('合法长课 map/reduce 会一次性计入 significance、所有 map 和 reduce', () => {
    const plan = planSessionReportWork(
      work({ transcript: 'A meaningful lecture sentence. '.repeat(4_000) })
    );

    expect(plan.usesMapReduce).toBe(true);
    expect(plan.chunkCount).toBeGreaterThan(1);
    expect(plan.providerCalls).toBe(plan.chunkCount + 2);
    expect(plan.providerCalls).toBeLessThanOrEqual(REPORT_MAX_PROVIDER_CALLS);
    expect(plan.reservedTokens).toBeLessThanOrEqual(REPORT_MAX_RESERVED_TOKENS);
    expect(() => assertSessionReportWorkWithinBudget(plan)).not.toThrow();
  });

  it('规划调用数与实际 significance + map + reduce 路径一致', async () => {
    const input = work({
      transcript: 'A meaningful lecture sentence. '.repeat(4_000),
    });
    const plan = planSessionReportWork(input);
    let calls = 0;

    const report = await generateSessionReport({
      ...input,
      sessionId: 'session-1',
      callLLM: async (system) => {
        calls += 1;
        if (system.includes('recording quality evaluator')) {
          return JSON.stringify({
            score: 0.9,
            reason: 'substantive',
            isWorthSummarizing: true,
          });
        }
        if (system.includes('fact extractor')) {
          return JSON.stringify({ facts: ['fact'] });
        }
        return JSON.stringify({
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
        });
      },
    });

    expect(report.report).not.toBeNull();
    expect(calls).toBe(plan.providerCalls);
  });

  it('reduce 预留覆盖 tokenizer 的 20 万字符高压缩 suffix 下限', () => {
    const plan = planSessionReportWork(
      work({ transcript: 'A meaningful lecture sentence. '.repeat(4_000) })
    );

    expect(plan.usesMapReduce).toBe(true);
    expect(plan.reservedTokens).toBeGreaterThan(800_000);
    expect(() => assertSessionReportWorkWithinBudget(plan)).not.toThrow();
  });

  it('原 500-way 放大输入在首个 provider 调用前被拒绝', () => {
    const plan = planSessionReportWork(
      work({ transcript: 'unbounded '.repeat(120_000) })
    );

    expect(plan.chunkCount).toBeGreaterThan(REPORT_MAX_PROVIDER_CALLS);
    expect(() => assertSessionReportWorkWithinBudget(plan)).toThrow(
      SessionReportBudgetExceededError
    );
  });

  it('即使调用数少，异常大的单次输出预算也会被总 token 上限拒绝', () => {
    const plan = planSessionReportWork(
      work({ maxOutputTokens: REPORT_MAX_RESERVED_TOKENS })
    );

    expect(plan.providerCalls).toBe(2);
    expect(plan.reservedTokens).toBeGreaterThan(REPORT_MAX_RESERVED_TOKENS);
    expect(() => assertSessionReportWorkWithinBudget(plan)).toThrow(
      SessionReportBudgetExceededError
    );
  });

  it('非有限 provider 配置退回保守默认值，不以 NaN 绕过预算', () => {
    const invalid = planSessionReportWork(
      work({ contextWindow: Number.NaN, maxOutputTokens: Number.NaN })
    );
    const fallback = planSessionReportWork(
      work({ contextWindow: undefined, maxOutputTokens: undefined })
    );

    expect(invalid).toEqual(fallback);
    expect(Number.isFinite(invalid.reservedTokens)).toBe(true);
  });
});
