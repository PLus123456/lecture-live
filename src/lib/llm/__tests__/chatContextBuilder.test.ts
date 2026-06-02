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

  describe('attachmentsText（附件进 token 预算）', () => {
    it('attachmentsText 计入 breakdown.systemPrompt 和 total（与 reportText 同款）', async () => {
      const attachmentsText = 'A'.repeat(500);
      const common = {
        history: [] as ConversationTurn[],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1 as const,
        inputBudget: 100_000,
        buildSystemPrompt: (t: string, s: string) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
      };
      const ctxWith = await buildChatContext({ ...common, attachmentsText });
      const ctxWithout = await buildChatContext({ ...common });

      // mock estimateTokens = length，delta 应正好等于 attachmentsText.length
      expect(
        ctxWith.breakdown.systemPrompt - ctxWithout.breakdown.systemPrompt
      ).toBe(attachmentsText.length);
      expect(ctxWith.breakdown.total - ctxWithout.breakdown.total).toBe(
        attachmentsText.length
      );
    });

    it('reportText + attachmentsText 同时存在 → 两者 token 都计入 total', async () => {
      const reportText = 'R'.repeat(300);
      const attachmentsText = 'A'.repeat(400);
      const common = {
        history: [] as ConversationTurn[],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1 as const,
        inputBudget: 100_000,
        buildSystemPrompt: (t: string, s: string) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
      };
      const ctxNone = await buildChatContext({ ...common });
      const ctxBoth = await buildChatContext({
        ...common,
        reportText,
        attachmentsText,
      });

      expect(ctxBoth.breakdown.total - ctxNone.breakdown.total).toBe(
        reportText.length + attachmentsText.length
      );
      expect(
        ctxBoth.breakdown.systemPrompt - ctxNone.breakdown.systemPrompt
      ).toBe(reportText.length + attachmentsText.length);
    });

    it('未传 attachmentsText → 预算不受影响（token 计 0）', async () => {
      const common = {
        history: [] as ConversationTurn[],
        userInput: 'q',
        transcript: [{ text: 't', startMs: 0 }],
        summary: 's',
        totalTranscriptMs: 0,
        minLevel: 1 as const,
        inputBudget: 100_000,
        buildSystemPrompt: (t: string, s: string) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(),
        language: 'zh',
      };
      const ctxUndefined = await buildChatContext({ ...common });
      const ctxEmpty = await buildChatContext({ ...common, attachmentsText: '' });

      expect(ctxUndefined.breakdown.total).toBe(ctxEmpty.breakdown.total);
    });

    it('大附件占用使预算收缩 → 降级到更窄 transcript 窗口（核心不变量）', async () => {
      // 6 轮 user 对话：L1/L2 用 5 轮窗口，更高级别收到 3 轮甚至 1 轮窗口。
      // 每轮 user 的 transcriptOffsetMs 单调递增，配合 transcript segments 的 startMs
      // 使「窗口越窄 → transcriptWindowByTurns 截掉越多前缀 → transcript token 越少」。
      const history: ConversationTurn[] = [];
      for (let i = 0; i < 6; i++) {
        history.push({
          role: 'user',
          content: `u${i}`,
          transcriptOffsetMs: i * 1000,
        });
        history.push({
          role: 'assistant',
          content: `a${i}`,
          transcriptOffsetMs: i * 1000,
        });
      }
      // 每个 user 轮对应一段 100 字符 transcript。5 轮窗口 ≈ 500 字符；3 轮 ≈ 300；1 轮 ≈ 100。
      const transcript: TranscriptSegment[] = [];
      for (let i = 0; i < 6; i++) {
        transcript.push({ text: 'T'.repeat(100), startMs: i * 1000 });
      }

      const common = {
        history,
        userInput: 'q',
        summary: '',
        transcript,
        totalTranscriptMs: 6000,
        minLevel: 1 as const,
        buildSystemPrompt: (t: string, s: string) => `<t>${t}</t><s>${s}</s>`,
        callLLM: vi.fn(async () => 'compressed-history'),
        language: 'zh',
      };

      // 选一个预算：不带附件时 L1（5 轮窗口）正好塞得下，带大附件时 L1 超预算被迫降级。
      const baseline = await buildChatContext({
        ...common,
        inputBudget: 1_000_000,
      });
      // baseline 选到 L1，transcript 含全部 6 段拼接文本（user≤5 轮时窗口=整段，
      // 这里 6 轮>5 → 5 轮窗口截掉最早 1 段，剩 5 段 ≈ 500 字符）
      expect(baseline.level).toBe(1);

      const budget = baseline.breakdown.total; // 不带附件时 L1 恰好等于预算
      const attachmentsText = 'A'.repeat(250); // 占掉 250 token 预算

      const withAttach = await buildChatContext({
        ...common,
        inputBudget: budget,
        attachmentsText,
      });

      // 附件吃掉预算 → L1 容不下 → 必须降级到更窄窗口（level 上升）
      expect(withAttach.level).toBeGreaterThan(baseline.level);
      // 收缩后 transcript token 应严格变小（窗口变窄截掉了更多前缀）
      expect(withAttach.breakdown.transcript).toBeLessThan(
        baseline.breakdown.transcript
      );
      // 且最终 total（含附件占用）仍被压回预算内
      expect(withAttach.breakdown.total).toBeLessThanOrEqual(budget);
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
