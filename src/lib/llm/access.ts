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
  resolveUserDefaultChatModelId,
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
  requestedIdentifier?: string,
  opts?: {
    /**
     * 未指定模型时是否强制「CHAT 用途默认模型必须在 allowedModels 内」。默认 true（聊天路径用）。
     * 摘要路径应传 false：摘要模型是管理员/用户组的决策（走 REALTIME_SUMMARY 用途默认或组绑定模型），
     * 与用户可选的聊天模型无关，用 CHAT 默认模型是否被允许来门禁摘要属于「判错了用途」，
     * 会把受限组的摘要误判成 403。
     */
    enforceDefaultModelAccess?: boolean;
    /**
     * 未指定模型时是否先套用「组默认聊天模型」（组绑定 chatModelId，管理员决策、绕过
     * allowedModels 门禁）。缺省跟随 enforceDefaultModelAccess（即聊天路径默认开启）；
     * 摘要路径传了 enforceDefaultModelAccess:false 即自动关闭，避免组的聊天默认误入摘要。
     */
    applyGroupChatDefault?: boolean;
  }
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

  // 回落到 CHAT 默认模型前的门禁：默认模型也必须在用户 allowedModels 内，否则受限组
  // 只要「不传 model」或「传一个不存在的 model」就能绕过绑定拿到（通常更强的）默认模型。
  // 空 id 分支与「非空但查无此模型」的 fall-through 分支都要走这道校验（此前只有空 id 分支有，
  // 伪造一个不存在的 id 即可绕过 —— 见下方 return { user, featureFlags } 前的调用）。
  const enforceDefaultModelAccess = opts?.enforceDefaultModelAccess ?? true;
  const assertDefaultModelAllowedOrThrow = async () => {
    if (
      !enforceDefaultModelAccess ||
      user.role === 'ADMIN' ||
      user.allowedModels === '*'
    ) {
      return;
    }
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
  };

  // 组默认聊天模型：用户未显式选模型时按组绑定解析（组绑定=管理员决策，绕过 allowedModels）。
  // 存在性经 getModelById 校验，失效（模型已删/回落 env provider）视作未绑定 → 走全局默认。
  const applyGroupChatDefault =
    opts?.applyGroupChatDefault ?? enforceDefaultModelAccess;
  const resolveGroupChatDefaultOrNull = async () => {
    if (!applyGroupChatDefault) return null;
    const groupDefaultId = await resolveUserDefaultChatModelId(user).catch(
      () => null
    );
    if (!groupDefaultId) return null;
    const cfg = await getModelById(groupDefaultId).catch(() => null);
    if (cfg && cfg.dbModelId === groupDefaultId) {
      return { cfg, modelId: groupDefaultId };
    }
    return null;
  };

  const normalizedIdentifier = requestedIdentifier?.trim();
  if (!normalizedIdentifier) {
    // 未指定模型 → 组默认聊天模型优先，其次回落到 CHAT 用途的全局默认（需校验授权）。
    const groupDefault = await resolveGroupChatDefaultOrNull();
    if (groupDefault) {
      return {
        user,
        providerConfig: groupDefault.cfg,
        modelId: groupDefault.modelId,
        featureFlags,
      };
    }
    await assertDefaultModelAllowedOrThrow();
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

  // 非空但既不是已配置的 DB 模型、也不是已配置的 provider 名 —— 即「伪造 / 陈旧」的 id。
  // 与空 id 分支同口径：组默认聊天模型优先；否则下游会回落到 CHAT 默认模型，必须校验
  // 默认模型授权，防止受限用户发 model:"does-not-exist" 绕过用户组模型绑定。
  const groupDefault = await resolveGroupChatDefaultOrNull();
  if (groupDefault) {
    return {
      user,
      providerConfig: groupDefault.cfg,
      modelId: groupDefault.modelId,
      featureFlags,
    };
  }
  await assertDefaultModelAllowedOrThrow();
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
