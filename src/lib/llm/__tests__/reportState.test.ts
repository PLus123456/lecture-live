import { describe, expect, it } from 'vitest';
import {
  isSessionReportGenerationResolved,
  shouldShowSessionReportPending,
} from '@/lib/llm/reportState';

function state(isWorthSummarizing: boolean, report: unknown) {
  return {
    significance: {
      score: isWorthSummarizing ? 0.9 : 0.1,
      reason: 'test',
      isWorthSummarizing,
    },
    report,
    generatedAt: '2026-08-20T00:00:00.000Z',
  };
}

describe('isSessionReportGenerationResolved', () => {
  it('缺失结果与 worth=true/report=null 失败态都必须继续轮询', () => {
    expect(isSessionReportGenerationResolved(null)).toBe(false);
    expect(isSessionReportGenerationResolved(state(true, null))).toBe(false);
  });

  it('有效正报告和有效否定 report:null 都是已解决状态', () => {
    expect(isSessionReportGenerationResolved(state(true, { title: 'Report' }))).toBe(
      true
    );
    expect(isSessionReportGenerationResolved(state(false, null))).toBe(true);
  });

  it('202 等待 winner 时，旧的 worth=true/report=null 必须显示为后台生成中', () => {
    expect(shouldShowSessionReportPending(state(true, null), true)).toBe(true);
    expect(shouldShowSessionReportPending(state(true, null), false)).toBe(false);
    expect(
      shouldShowSessionReportPending(state(true, { title: 'Report' }), true)
    ).toBe(false);
    expect(shouldShowSessionReportPending(state(false, null), true)).toBe(false);
  });
});
