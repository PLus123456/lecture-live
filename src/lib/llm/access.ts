import type { ThinkingDepth } from '@/types/llm';
import {
  getModelById,
  getProviderForPurpose,
  parseProviders,
  type LLMProviderConfig,
} from '@/lib/llm/gateway';
import { prisma } from '@/lib/prisma';
import {
  resolveUserFeatureFlags,
  clampDepthToCap,
  type EffectiveFeatureFlags,
  type ThinkingDepthCap,
} from '@/lib/userRoles';

export class LLMAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMAccessError';
  }
}

interface LLMAccessUser {
  role: 'ADMIN' | 'PRO' | 'FREE';
  allowedModels: string;
  customGroupId: string | null;
}

export interface AuthorizedLlmSelection {
  user: LLMAccessUser;
  providerConfig?: LLMProviderConfig;
  providerName?: string;
  modelId?: string;
  /** 该用户运行时生效的能力开关（思考深度上限 / 摘要权限），由所属组解析 */
  featureFlags: EffectiveFeatureFlags;
}

function buildAllowedModelSet(allowedModels: string): Set<string> {
  return new Set(
    allowedModels
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function canUseDatabaseModel(
  user: LLMAccessUser,
  providerConfig: LLMProviderConfig
): boolean {
  if (user.role === 'ADMIN' || user.allowedModels === '*') {
    return true;
  }

  const allowed = buildAllowedModelSet(user.allowedModels);
  return [
    providerConfig.dbModelId,
    providerConfig.model,
    providerConfig.name,
  ].some((identifier) => Boolean(identifier && allowed.has(identifier)));
}

function canUseProviderName(user: LLMAccessUser, providerName: string): boolean {
  if (user.role === 'ADMIN' || user.allowedModels === '*') {
    return true;
  }

  return buildAllowedModelSet(user.allowedModels).has(providerName);
}

export async function resolveAuthorizedLlmSelection(
  userId: string,
  requestedIdentifier?: string
): Promise<AuthorizedLlmSelection> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { allowedModels: true, role: true, customGroupId: true },
  });

  if (!user) {
    throw new LLMAccessError('User not found');
  }

  // 能力开关按所属组解析（组配置为唯一真源），随选择一并返回给调用方
  const featureFlags = await resolveUserFeatureFlags(user);

  const normalizedIdentifier = requestedIdentifier?.trim();
  if (!normalizedIdentifier) {
    // 未指定模型 → 下游会回落到 CHAT 用途的默认模型。但默认模型也必须在用户 allowedModels 内，
    // 否则受限组只要不传 model 就能绕过绑定拿到（通常更强的）默认模型。此处补齐这道校验。
    if (user.role !== 'ADMIN' && user.allowedModels !== '*') {
      try {
        const fallback = await getProviderForPurpose('CHAT');
        const allowed = fallback.dbModelId
          ? canUseDatabaseModel(user, fallback)
          : canUseProviderName(user, fallback.name);
        if (!allowed) {
          throw new LLMAccessError('Requested model is not allowed');
        }
      } catch (error) {
        if (error instanceof LLMAccessError) throw error;
        // 默认模型解析失败（未配置任何模型）→ 交给下游按原有兜底逻辑处理
      }
    }
    return { user, featureFlags };
  }

  try {
    const dbModelConfig = await getModelById(normalizedIdentifier);
    if (
      dbModelConfig.dbModelId &&
      dbModelConfig.dbModelId === normalizedIdentifier
    ) {
      if (!canUseDatabaseModel(user, dbModelConfig)) {
        throw new LLMAccessError('Requested model is not allowed');
      }

      return {
        user,
        providerConfig: dbModelConfig,
        modelId: dbModelConfig.dbModelId,
        featureFlags,
      };
    }
  } catch (error) {
    if (error instanceof LLMAccessError) {
      throw error;
    }
  }

  const providers = parseProviders();
  if (providers[normalizedIdentifier]) {
    if (!canUseProviderName(user, normalizedIdentifier)) {
      throw new LLMAccessError('Requested model is not allowed');
    }

    return {
      user,
      providerConfig: providers[normalizedIdentifier],
      providerName: normalizedIdentifier,
      featureFlags,
    };
  }

  return { user, featureFlags };
}

/**
 * 决定最终发给 gateway 的 thinkingDepth：
 *  - 按所属组的思考深度上限 cap 收紧（cap='medium' 时 high→medium；cap='off' 视作最低档
 *    参与数值比较，真正的"禁用思考"由 resolveEffectivePreference 在 preference 层强制 off）
 *  - 模型不是 DEPTH 模式时，深度参数无意义，回落到模型默认深度
 *  - 否则按（收紧后的）用户请求
 */
export function resolveEffectiveThinkingDepth(
  cap: ThinkingDepthCap,
  requestedDepth: ThinkingDepth,
  providerConfig?: LLMProviderConfig
): ThinkingDepth {
  const depthCap: ThinkingDepth = cap === 'off' ? 'low' : cap;
  const clampedDepth = clampDepthToCap(requestedDepth, depthCap) as ThinkingDepth;

  if (providerConfig && providerConfig.thinkingMode !== 'DEPTH') {
    return providerConfig.thinkingDepth;
  }

  return clampedDepth;
}
