/** v2 增量式摘要块 */
export interface SummaryBlock {
  id: string;
  blockIndex: number; // 第几个摘要块（递增，不可变）
  timeRange: {
    startMs: number;
    endMs: number;
  };
  keyPoints: string[];
  definitions: Record<string, string>;
  summary: string;
  suggestedQuestions: string[];
  frozen: boolean; // true = 已冻结，不再修改
}

export interface SummaryState {
  blocks: SummaryBlock[];
  runningContext: string; // 滚动上下文摘要（给下一次 LLM 调用做背景）
}

/** LLM 返回的增量摘要结果 */
export interface IncrementalSummaryResult {
  new_key_points: string[];
  new_definitions: Record<string, string>;
  new_summary: string;
  new_questions: string[];
  updated_running_context: string;
}

/** Legacy — 保留向后兼容 */
export interface SummarizeRequest {
  newTranscript: string;
  runningContext?: string;
  courseContext?: string;
  language: string;
  providerOverride?: string;
}

export interface SummarizeResponse {
  keyPoints: string[];
  definitions?: Record<string, string>;
  summary?: string;
  suggestedQuestions?: string[];
  timeRange?: string;
  timestamp: number;
}
