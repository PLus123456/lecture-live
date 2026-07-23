// 用途路由行（LlmModel）参数的公共校验/兜底，供 /api/admin/llm-routes* 复用
import type { LlmAdminPurpose } from '@/lib/llm/defaults';

export const VALID_THINKING_MODES = ['NONE', 'AUTO', 'FORCED', 'DEPTH'] as const;
export const VALID_DEPTHS = ['low', 'medium', 'high'] as const;

/** 各用途的温度兜底（摘要/关键词偏低求稳，聊天偏中） */
export const DEFAULT_TEMPERATURE: Record<LlmAdminPurpose, number> = {
  CHAT: 0.6,
  REALTIME_SUMMARY: 0.3,
  FINAL_SUMMARY: 0.4,
  KEYWORD_EXTRACTION: 0.2,
  EMBEDDING: 0.3, // 嵌入不用温度，占位
  TRANSLATION: 0.2, // 翻译求忠实，低温
};

/**
 * 清洗温度：undefined → fallback；非 0–2 的数字 → null（调用方报 400）。
 * 保留一位小数，避免脏精度值落库。
 */
export function coerceTemperature(
  value: unknown,
  fallback: number
): number | null {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) return null;
  return Math.round(n * 10) / 10;
}
