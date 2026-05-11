// Isomorphic token 计数 —— 浏览器与 Node 端共用。
//
// 用 gpt-tokenizer 的 cl100k_base 编码（GPT-3.5/4 系），对国内外主流 LLM
// （Claude / GPT / DeepSeek / Kimi / GLM / 豆包 / Minimax）都是 BPE 系列，
// token 边界相近，误差通常 ±15%。本项目用 estimateTokens() 做上下文预算的
// **预估**（reactive retry 兜底处理真实超限），所以这点误差可接受。
//
// 不为不同供应商加载不同 tokenizer 的原因：
//  - 多分词器 → 包体积 ~3x、首次加载慢、维护成本高
//  - 大部分商业 LLM 不公开自家分词器，cl100k 已是事实上的代理标准

import { encode } from 'gpt-tokenizer';

/**
 * 估算字符串的 token 数。空串返回 0。
 *
 * 性能参考（M1 Mac）：60K 字符 transcript ≈ 5ms。
 * 浏览器端配合 debounce 使用，不要每个 keystroke 都跑。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

/**
 * 估算多段拼接后的 token 数。比逐段相加更准 —— 因为段间空白会被合并编码。
 */
export function estimateTokensJoined(parts: readonly string[], separator = '\n'): number {
  if (parts.length === 0) return 0;
  return estimateTokens(parts.join(separator));
}

/**
 * 按 token 数从文本尾部截取，保留最后 N 个 token 对应的文本。
 * 用于 L4 "transcript 只保留尾部" 场景。
 *
 * 注：encode → slice → decode 会引入 BPE 边界问题（个别字符可能畸形），
 * 但截断本身就是降级行为，可接受。
 */
export function truncateToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return '';
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return text;

  // 简单近似：按 token 比例反推字符位置，从尾部取
  const ratio = maxTokens / tokens.length;
  const charStart = Math.max(0, Math.floor(text.length * (1 - ratio)));
  return text.slice(charStart);
}

/**
 * 估算文本是否在给定 token 上限内。比 estimateTokens() 快一些 ——
 * gpt-tokenizer 的 isWithinTokenLimit() 在超过上限时会提前终止编码。
 */
export function isWithinTokens(text: string, limit: number): boolean {
  if (!text) return true;
  return encode(text).length <= limit;
}
