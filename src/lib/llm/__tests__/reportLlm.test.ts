import { beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.hoisted(() => vi.fn());
vi.mock('@/lib/llm/gateway', () => ({ callLLMWithHistoryStream: stream }));
import { callReportLLM } from '@/lib/llm/reportLlm';

describe('报告模型流式调用', () => {
  beforeEach(() => vi.resetAllMocks());

  it('收完整正文才返回，并把真实用量交还报告预算账本', async () => {
    stream.mockResolvedValue({ text: '{"report":"complete"}', thinking: 'private reasoning', usage: { inputTokens: 100, outputTokens: 40 } });
    const onUsage = vi.fn();
    expect(await callReportLLM('system', 'transcript', { routing: { modelId: 'owner-model' }, maxOutputTokens: 2048, onUsage }))
      .toBe('{"report":"complete"}');
    expect(stream).toHaveBeenCalledWith('system', [{ role: 'user', content: 'transcript' }],
      expect.objectContaining({ modelId: 'owner-model', maxOutputTokens: 2048, signal: expect.any(AbortSignal) }), expect.any(Function));
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 40 });
  });

  it('流中断或超时不得把部分正文当作报告成功', async () => {
    stream.mockRejectedValue(new Error('stream truncated'));
    const onUsage = vi.fn();
    await expect(callReportLLM('system', 'transcript', { routing: { purpose: 'FINAL_SUMMARY' }, maxOutputTokens: 2048, onUsage }))
      .rejects.toThrow('stream truncated');
    expect(onUsage).not.toHaveBeenCalled();
  });
});
