// 把模型库条目挂载到某个用途（创建路由行）的公共逻辑。
// /api/admin/llm-routes POST（单独挂载）与 /api/admin/llm-providers/[id]/registry POST
// （登记时顺带挂载）共用，保证「首个模型自动成为默认 / 参数兜底 / 规格写穿」口径一致。
import type { Prisma } from '@prisma/client';
import type { LlmAdminPurpose } from '@/lib/llm/defaults';
import { DEFAULT_TEMPERATURE } from '@/lib/llm/routeParams';

export interface AttachableRegistry {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  kind: string;
  supportsImage: boolean;
  maxTokens: number;
  contextWindow: number;
}

export interface AttachRouteParams {
  thinkingMode?: string;
  thinkingDepth?: string;
  temperature?: number;
  isDefault?: boolean;
}

/** 用途与模型类型是否匹配（嵌入用途 ↔ 嵌入模型，文本用途 ↔ 文本模型） */
export function purposeMatchesKind(
  purpose: LlmAdminPurpose,
  kind: string
): boolean {
  return (purpose === 'EMBEDDING') === (kind === 'EMBEDDING');
}

/**
 * 在事务内创建一条用途路由行。规格从模型库写穿；该用途此前没有任何模型、
 * 或显式要求默认时，自动（互斥地）成为该用途默认。
 * 调用方负责先校验 kind 匹配与重复挂载。
 */
export async function createRouteForRegistry(
  tx: Prisma.TransactionClient,
  registry: AttachableRegistry,
  purpose: LlmAdminPurpose,
  params: AttachRouteParams = {}
) {
  const purposeCount = await tx.llmModel.count({ where: { purpose } });
  const maxSort = await tx.llmModel.aggregate({
    where: { purpose },
    _max: { sortOrder: true },
  });
  const makeDefault = Boolean(params.isDefault) || purposeCount === 0;
  if (makeDefault) {
    await tx.llmModel.updateMany({
      where: { purpose, isDefault: true },
      data: { isDefault: false },
    });
  }
  const thinkingMode = params.thinkingMode ?? 'NONE';
  return tx.llmModel.create({
    data: {
      providerId: registry.providerId,
      registryId: registry.id,
      // 规格：模型库写穿副本
      modelId: registry.modelId,
      displayName: registry.displayName,
      supportsImage: registry.supportsImage,
      maxTokens: registry.maxTokens,
      contextWindow: registry.contextWindow,
      // 路由层参数
      purpose,
      thinkingMode,
      supportsThinkingDepth: thinkingMode === 'DEPTH',
      thinkingDepth: params.thinkingDepth ?? 'medium',
      temperature: params.temperature ?? DEFAULT_TEMPERATURE[purpose],
      isDefault: makeDefault,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
  });
}
