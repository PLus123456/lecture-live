import { describe, expect, it, vi } from 'vitest';

// token 估算固定成「字符数」，让预算 / 切块边界可预测。
vi.mock('@/lib/llm/tokenizer', () => ({
  estimateTokens: (text: string) => (text ? text.length : 0),
  estimateTokensJoined: (parts: readonly string[], sep = '\n') =>
    parts.length === 0 ? 0 : parts.join(sep).length,
  truncateToTokensFromEnd: (text: string, maxTokens: number) =>
    text.length > maxTokens ? text.slice(-maxTokens) : text,
}));

import {
  computeReportBudgets,
  generateSessionReport,
} from '@/lib/llm/reportManager';

/**
 * L39：`computeTranscriptInputBudget` 的老实现是
 *   `Math.max(2000, floor(cw*0.8) - 1500 - 9000 - 4000)`
 * contextWindow=8192 时括号里是 **-7947**，却被钳回 2000 —— 给出一份根本塞不下的预算，
 * 叠加 system + summary + output 必然超窗 → 上游 400 → 报告永远生成失败。
 */
describe('computeReportBudgets（L39 预算必须真的塞得下）', () => {
  const windows = [4096, 8192, 16384, 32768, 128_000, 200_000];

  it.each(windows)(
    'contextWindow=%i：四项预算之和恰好等于可用窗口，且 transcript 预算为正',
    (contextWindow) => {
      const b = computeReportBudgets(contextWindow);
      expect(
        b.systemReserve + b.summaryBudget + b.transcriptBudget + b.outputReserve
      ).toBe(b.usable);
      expect(b.transcriptBudget).toBeGreaterThan(0);
      expect(b.usable).toBe(Math.floor(contextWindow * 0.8));
    }
  );

  it('8K 窗口下 transcript 预算必须小于可用窗口（旧实现给的 2000 + 9000 摘要预留会超窗）', () => {
    const b = computeReportBudgets(8192);
    expect(b.transcriptBudget).toBeLessThan(b.usable);
    // 摘要预留也必须一起收缩，否则收缩了别的等于没修
    expect(b.summaryBudget).toBeLessThan(9000);
  });

  it('大窗口下仍是老的固定预留（不因为修小窗口而牺牲大窗口）', () => {
    const b = computeReportBudgets(200_000);
    expect(b.systemReserve).toBe(1500);
    expect(b.outputReserve).toBe(4000);
    expect(b.summaryBudget).toBe(9000);
  });
});

/** 造一个「每句 ≈800 token」的超长转录，逼出 map-reduce 的 500 块上限 */
function makeHugeTranscript(sentenceCount: number): string {
  return Array.from(
    { length: sentenceCount },
    (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(795)}。`
  ).join('');
}

interface CapturedCall {
  system: string;
  user: string;
}

function makeCallLLM(captured: CapturedCall[]) {
  return vi.fn(async (system: string, user: string) => {
    captured.push({ system, user });
    if (system.includes('recording quality evaluator')) {
      return JSON.stringify({
        score: 0.9,
        reason: 'ok',
        isWorthSummarizing: true,
      });
    }
    if (system.includes('fact extractor')) {
      return '{"facts":["f"]}';
    }
    return JSON.stringify({
      title: 'T',
      topic: 'TOPIC',
      participants: ['P'],
      date: '2026-08-22',
      duration: '1h',
      overview: 'ORIGINAL_OVERVIEW',
      sections: [],
      conclusions: [],
      actionItems: [],
      keyTerms: {},
    });
  });
}

describe('generateSessionReport（M17 切块触顶必须在产物里声明）', () => {
  it('触顶时报告 overview 前置截断声明，且模型也被告知拿到的不是全文', async () => {
    const captured: CapturedCall[] = [];
    const callLLM = makeCallLLM(captured);

    const data = await generateSessionReport({
      sessionId: 's1',
      transcript: makeHugeTranscript(600), // 600 块 > maxChunks=500
      sessionTitle: '课',
      courseName: '课程',
      durationMs: 3_600_000,
      date: '2026-08-22',
      summaryBlocks: [],
      language: 'zh',
      callLLM,
    });

    expect(data.report).not.toBeNull();
    expect(data.report!.overview).toContain('⚠️');
    expect(data.report!.overview).toContain('ORIGINAL_OVERVIEW');
    expect(data.report!.overview).toMatch(/仅覆盖约前 \d+%/);

    // 报告 prompt 里也应带上同样的声明（否则模型仍会按"全场纪要"下结论）
    const reportCall = captured.find(
      (c) =>
        !c.system.includes('recording quality evaluator') &&
        !c.system.includes('fact extractor')
    );
    expect(reportCall).toBeDefined();
    expect(reportCall!.user + reportCall!.system).toContain('⚠️');
  }, 30_000);

  it('未触顶时不加任何截断声明（避免误报）', async () => {
    const captured: CapturedCall[] = [];
    const callLLM = makeCallLLM(captured);

    const data = await generateSessionReport({
      sessionId: 's2',
      transcript: makeHugeTranscript(20), // 20 块，远未触顶但仍走 map-reduce
      sessionTitle: '课',
      courseName: '课程',
      durationMs: 3_600_000,
      date: '2026-08-22',
      summaryBlocks: [],
      language: 'zh',
      callLLM,
    });

    expect(data.report).not.toBeNull();
    expect(data.report!.overview).toBe('ORIGINAL_OVERVIEW');
  }, 30_000);
});
