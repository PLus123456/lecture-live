import type { LlmPurpose } from '@/types/llm';
import {
  getModelById,
  getProviderForPurpose,
  type LLMProviderConfig,
} from '@/lib/llm/gateway';

/** 与用户组绑定的两个摘要用途 */
export type SummaryPurpose = 'REALTIME_SUMMARY' | 'FINAL_SUMMARY';

export interface ResolvedSummaryModel {
  /** 传给 callLLM 的路由参数：组配了有效模型 → { modelId }；否则 → { purpose } 全局默认 */
  routing: { modelId: string } | { purpose: LlmPurpose };
  /** 预解析到的 provider 配置（组模型或全局默认）；解析失败为 null（调用方按需兜底 contextWindow） */
  provider: LLMProviderConfig | null;
}

/**
 * 把「用户组解析出的摘要模型 id」+「用途兜底」解析成 gateway 路由参数与 provider 配置。
 *
 * 组配了具体模型且该模型仍存在（getModelById 命中同一 DB id）→ 用 { modelId }；
 * 否则（未配 / 模型已删 / 解析异常）→ 回落全局该用途默认 { purpose }。
 *
 * 存在性校验很关键：getModelById 找不到会回落 env active provider（DB-only 部署里直接抛错），
 * 若不校验、残留的失效 id 会让每次摘要都炸。这里校验后失效即静默回落全局默认。
 */
export async function resolveSummaryModel(
  groupModelId: string | null | undefined,
  fallbackPurpose: SummaryPurpose
): Promise<ResolvedSummaryModel> {
  const id = groupModelId?.trim();
  if (id) {
    const cfg = await getModelById(id).catch(() => null);
    if (cfg && cfg.dbModelId === id) {
      return { routing: { modelId: id }, provider: cfg };
    }
    // 命中 env active provider（dbModelId !== id）或解析失败 → 视作失效，回落全局默认
  }

  const provider = await getProviderForPurpose(fallbackPurpose).catch(() => null);
  return { routing: { purpose: fallbackPurpose }, provider };
}
