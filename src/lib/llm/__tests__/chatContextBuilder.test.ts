import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/llm/tokenizer', () => ({
  estimateTokens: (text: string) => (text ? text.length : 0),
  truncateToTokensFromEnd: (text: string, maxTokens: number) =>
    text.length > maxTokens ? text.slice(-maxTokens) : text,
}));

import { buildChatContext } from '@/lib/llm/chatContextBuilder';
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
});
