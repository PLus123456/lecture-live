import 'server-only';

import { estimateTokens } from './tokenizer';
import type { LLMProviderConfig } from './gateway';

/**
 * 工程冗余系数 —— tokenizer 估算与各家 LLM 实际 tokenize 有差异（cl100k_base
 * 对非英文存在 ±15% 误差），同时也给请求/响应模板的开销留出余量。
 *
 * 0.8 = 用 80% 的 contextWindow 做"可用预算"，留 20% 给：
 *   - tokenizer 估算误差
 *   - JSON 请求结构（messages 数组本身的开销）
 *   - 模型实际 tokenize 时的 BPE 差异
 */
export const SAFETY_RATIO = 0.8;

/**
 * 触发预防式降级的阈值。estimateTotalTokens() ≥ contextWindow × THRESHOLD
 * 时进入下一级降级。
 *
 * 设为 0.8 而非 SAFETY_RATIO 是为了在 estimateTotalTokens() 把 maxTokens 已经
 * 减出去的情况下，依然有空间做实际调用 —— 即"剩余 20% 留给输出"。
 */
export const DEGRADATION_TRIGGER_RATIO = 0.8;

export interface ContextBudget {
  /** 模型输入上下文窗口（token） */
  contextWindow: number;
  /** 单次输出 max_tokens */
  outputMaxTokens: number;
  /** 工程冗余后的"可输入"预算 */
  inputBudget: number;
  /** 触发降级的阈值（与 inputBudget 同口径） */
  degradationThreshold: number;
}

/**
 * 根据 LLM provider 配置计算可用 token 预算。
 *
 * inputBudget = (contextWindow - outputMaxTokens) × SAFETY_RATIO
 *
 * 注意：参数里 contextWindow 必须从数据库 LlmModel.contextWindow 取，
 * LLMProviderConfig.maxTokens 仅是 API 调用的输出上限。
 */
export function computeContextBudget(
  provider: LLMProviderConfig,
  contextWindow: number
): ContextBudget {
  const outputMaxTokens = Math.max(1, provider.maxTokens || 4096);
  const usable = Math.max(0, contextWindow - outputMaxTokens);
  const inputBudget = Math.floor(usable * SAFETY_RATIO);
  return {
    contextWindow,
    outputMaxTokens,
    inputBudget,
    degradationThreshold: Math.floor(contextWindow * DEGRADATION_TRIGGER_RATIO),
  };
}

export interface ChatTokenBreakdown {
  systemPrompt: number;
  transcript: number;
  summary: number;
  history: number;
  userInput: number;
  total: number;
}

/**
 * 估算 chat 请求各组件的 token 占用。用于 UI 小圈展示 + 预防式降级判定。
 *
 * 各字段独立估算后相加 —— 实际拼接编码可能略少（段间空白合并），但少量
 * 高估对降级判定是安全方向。
 */
export function estimateChatBreakdown(input: {
  systemPrompt: string;
  transcript: string;
  summary: string;
  history: ReadonlyArray<{ content: string }>;
  userInput: string;
}): ChatTokenBreakdown {
  const systemPrompt = estimateTokens(input.systemPrompt);
  const transcript = estimateTokens(input.transcript);
  const summary = estimateTokens(input.summary);
  const history = input.history.reduce(
    (acc, msg) => acc + estimateTokens(msg.content),
    0
  );
  const userInput = estimateTokens(input.userInput);
  return {
    systemPrompt,
    transcript,
    summary,
    history,
    userInput,
    total: systemPrompt + transcript + summary + history + userInput,
  };
}

/**
 * 是否需要预防式降级（基于估算的 token 是否超过 degradationThreshold）。
 */
export function shouldDegrade(
  breakdown: ChatTokenBreakdown,
  budget: ContextBudget
): boolean {
  return breakdown.total >= budget.degradationThreshold;
}
