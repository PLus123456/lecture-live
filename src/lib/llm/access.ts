import type { ThinkingDepth } from '@/types/llm';
import {
  getModelById,
  parseProviders,
  type LLMProviderConfig,
} from '@/lib/llm/gateway';
import { prisma } from '@/lib/prisma';

export class LLMAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMAccessError';
  }
}

interface LLMAccessUser {
  role: 'ADMIN' | 'PRO' | 'FREE';
  allowedModels: string;
}

export interface AuthorizedLlmSelection {
  user: LLMAccessUser;
  providerConfig?: LLMProviderConfig;
  providerName?: string;
  modelId?: string;
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
    select: { allowedModels: true, role: true },
  });

  if (!user) {
    throw new LLMAccessError('User not found');
  }

  const normalizedIdentifier = requestedIdentifier?.trim();
  if (!normalizedIdentifier) {
    return { user };
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
    };
  }

  return { user };
}

/**
 * 决定最终发给 gateway 的 thinkingDepth：
 *  - FREE 用户禁止 high（成本高）
 *  - 模型不支持调节深度时，强制使用模型默认深度
 *  - 否则按用户请求
 */
export function resolveEffectiveThinkingDepth(
  role: LLMAccessUser['role'],
  requestedDepth: ThinkingDepth,
  providerConfig?: LLMProviderConfig
): ThinkingDepth {
  const clampedDepth =
    role === 'FREE' && requestedDepth === 'high' ? 'medium' : requestedDepth;

  if (providerConfig && !providerConfig.supportsThinkingDepth) {
    return providerConfig.thinkingDepth;
  }

  return clampedDepth;
}
