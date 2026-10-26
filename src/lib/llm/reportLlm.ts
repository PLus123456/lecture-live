import { callLLMWithHistoryStream, type LLMCallUsage } from '@/lib/llm/gateway';
import type { ResolvedSummaryModel } from '@/lib/llm/summaryModel';

/**
 * 报告可能使用耗时较长的思考模型。服务端收集流式结果，避免非流式 120 秒总超时
 * 截断仍在正常生成的报告；保留四分钟硬期限、输出大小限制和真实用量结算。
 */
export async function callReportLLM(
  system: string,
  user: string,
  options: {
    routing: ResolvedSummaryModel['routing'];
    maxOutputTokens: number;
    onUsage: (usage: LLMCallUsage | undefined) => void;
  }
): Promise<string> {
  const result = await callLLMWithHistoryStream(
    system,
    [{ role: 'user', content: user }],
    {
      ...options.routing,
      maxOutputTokens: options.maxOutputTokens,
      maxResponseUtf8Bytes: 1024 * 1024,
      signal: AbortSignal.timeout(240_000),
    },
    () => undefined
  );
  options.onUsage(result.usage);
  return result.text;
}
