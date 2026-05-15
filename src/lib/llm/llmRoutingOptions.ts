import type { LlmPurpose } from '@/types/llm';
import type { AuthorizedLlmSelection } from '@/lib/llm/access';

/**
 * 把 access.ts 解析出来的 selection 转成 gateway.callLLM(WithHistory) 接受的
 * provider 路由参数。
 *
 * 优先级：modelId（用户在前端选了 DB model）→ providerOverride（选了 env-var
 * provider）→ purpose（前两者都没指定时，按调用方期望的用途走 DB-first 默认）。
 *
 * 第三分支必须返回 purpose、不能是 `{}`：否则 gateway 会落到 getActiveProvider()
 * 强制读 env LLM_ACTIVE_PROVIDER，DB-only 部署里直接抛 "LLM provider not
 * configured" → 调用方外层 catch 不识别为上下文超长 → 500。
 */
export function buildLlmRoutingOptions(
  selection: Pick<AuthorizedLlmSelection, 'modelId' | 'providerName'>,
  fallbackPurpose: LlmPurpose
):
  | { modelId: string }
  | { providerOverride: string }
  | { purpose: LlmPurpose } {
  if (selection.modelId) {
    return { modelId: selection.modelId };
  }
  if (selection.providerName) {
    return { providerOverride: selection.providerName };
  }
  return { purpose: fallbackPurpose };
}
