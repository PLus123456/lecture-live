import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/llm/tokenizer', () => ({
  estimateTokens: (text: string) => (text ? text.length : 0),
  // 与 estimateTokens 保持一致：join 后按字符长度计（不引入空格等额外字符）
  estimateTokensJoined: (parts: readonly string[], separator = '\n') =>
    parts.length === 0 ? 0 : parts.join(separator).length,
  truncateToTokensFromEnd: (text: string, maxTokens: number) =>
    text.length > maxTokens ? text.slice(-maxTokens) : text,
}));

import {
  buildChatContext,
  estimateRawContextTokens,
  REPORT_TEXT_MAX_CHARS,
  type TranscriptSegment,
  type ConversationTurn,
} from '@/lib/llm/chatContextBuilder';
import { estimateTokens } from '@/lib/llm/tokenizer';

describe('chatContextBuilder', () => {
  it('把当前降级级别产出的 transcript 和 summary 真正写入 system prompt', async () => {
    const ctx = await buildChatContext({
      history: [],
      userInput: '请解释这一段',
      transcript: [{ text: 'TRANSCRIPT_UNIQUE_MARKER', startMs: 0 }],
      summary: 'SUMMARY_UNIQUE_MARKER',
      totalTranscriptMs: 0,
      minLevel: 1,
      inputBudget: 100_000,
      buildSystemPrompt: (transcriptContext, summaryContext) =>
        [
          '系统提示',
          `<lecture_transcript>${transcriptContext}</lecture_transcript>`,
          `<lecture_summary>${summaryContext}</lecture_summary>`,
        ].join('\n'),
      callLLM: vi.fn(),
      language: 'zh',
    });

    expect(ctx.systemPrompt).toContain('TRANSCRIPT_UNIQUE_MARKER');
    expect(ctx.systemPrompt).toContain('SUMMARY_UNIQUE_MARKER');
    expect(ctx.breakdown.total).toBe(
      estimateTokens(ctx.systemPrompt) + estimateTokens('请解释这一段')
    );
  });

  describe('forceMinLevel', () => {
    it('forceMinLevel=6 → 输出 level >= 6（即使 minLevel=1 且预算充足）', async () => {
      const ragRetrieve = vi.fn(async () => 'RAG_TRANSCRIPT_CHUNK');
      const ctx = await buildChatContext({
        history: [],
        userInput: '问题',
        transcript: [{ text: 'short transcript', startMs: 0 }],
        summary: 'summary',
        totalTranscriptMs: 0,
        minLevel: 1,
        forceMinLevel: 6,
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) =>
          `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(async () => 'compressed'),
        language: 'zh',
        ragRetrieve,
      });

      expect(ctx.level).toBeGreaterThanOrEqual(6);
      // L6 必须走 RAG（即使 transcript 很短）
      expect(ragRetrieve).toHaveBeenCalled();
      expect(ctx.systemPrompt).toContain('RAG_TRANSCRIPT_CHUNK');
    });

    it('forceMinLevel < minLevel → 仍以 minLevel 起点（不破坏单调降级）', async () => {
      const ctx = await buildChatContext({
        history: [],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 3,
        forceMinLevel: 1, // 比 minLevel 低 → 应被忽略
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
      });

      expect(ctx.level).toBeGreaterThanOrEqual(3);
    });

    it('未传 forceMinLevel → 行为与之前完全一致（默认 L1 起步）', async () => {
      const ctx = await buildChatContext({
        history: [],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1,
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
      });
      expect(ctx.level).toBe(1);
    });
  });

  describe('reportText', () => {
    it('提供 reportText → output.reportText 等于（截断后的）输入', async () => {
      const reportText = '这是一份录音 report 全文';
      const ctx = await buildChatContext({
        history: [],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1,
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
        reportText,
      });

      expect(ctx.reportText).toBe(reportText);
    });

    it('reportText 长于 8000 字符 → 被截断到 REPORT_TEXT_MAX_CHARS', async () => {
      const longReport = 'X'.repeat(20_000);
      const ctx = await buildChatContext({
        history: [],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1,
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
        reportText: longReport,
      });

      expect(ctx.reportText).toBeDefined();
      expect(ctx.reportText!.length).toBe(REPORT_TEXT_MAX_CHARS);
      expect(ctx.reportText).toBe(longReport.slice(0, REPORT_TEXT_MAX_CHARS));
    });

    it('reportText 不传 → output.reportText 是 undefined', async () => {
      const ctx = await buildChatContext({
        history: [],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1,
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
      });

      expect(ctx.reportText).toBeUndefined();
    });

    it('reportText 计入 breakdown.systemPrompt 和 total', async () => {
      const reportText = 'R'.repeat(500);
      const ctxWith = await buildChatContext({
        history: [],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1,
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
        reportText,
      });
      const ctxWithout = await buildChatContext({
        history: [],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1,
        inputBudget: 100_000,
        buildSystemPrompt: (t, s) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
      });

      // mock estimateTokens = length，所以 delta 应当正好等于 reportText.length
      expect(
        ctxWith.breakdown.systemPrompt - ctxWithout.breakdown.systemPrompt
      ).toBe(reportText.length);
      expect(ctxWith.breakdown.total - ctxWithout.breakdown.total).toBe(
        reportText.length
      );
    });
  });

  describe('estimateRawContextTokens', () => {
    it('数值合理：> 0 且接近手工估算', () => {
      const transcript: TranscriptSegment[] = [
        { text: 'aaaaa', startMs: 0 },
        { text: 'bbb', startMs: 1000 },
      ];
      const history: ConversationTurn[] = [
        { role: 'user', content: 'hello', transcriptOffsetMs: 0 },
        { role: 'assistant', content: 'hi', transcriptOffsetMs: 0 },
      ];
      const userInput = 'next?';

      const total = estimateRawContextTokens(transcript, history, userInput);

      // 实现用 estimateTokensJoined(parts, ' ')。mock 下 = 拼接后字符串长度：
      // 'aaaaa bbb hello hi next?' = 5+1+3+1+5+1+2+1+5 = 24
      expect(total).toBe(24);
      expect(total).toBeGreaterThan(0);
    });

    it('空输入 → 0', () => {
      expect(estimateRawContextTokens([], [], '')).toBe(0);
    });

    it('只有 userInput → 等于 userInput 的 token 数', () => {
      expect(estimateRawContextTokens([], [], 'hello')).toBe(
        estimateTokens('hello')
      );
    });
  });
});
