// src/lib/llm/gateway.ts
// 多 Provider LLM 网关 — 优先从数据库读取配置，回退到环境变量

import type { ThinkingDepth, LlmPurpose } from '@/types/llm';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { logger, serializeError } from '@/lib/logger';

/** 安全：截断上游 API 错误响应，避免泄露 API key 或敏感信息 */
function sanitizeApiError(text: string, maxLen = 200): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '...(truncated)' : text;
}

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

/**
 * 思考模式：
 *  NONE     - 不支持思考
 *  OPTIONAL - 用户可选（Claude Extended Thinking）
 *  FORCED   - 模型自带思考无法关闭（OpenAI o1/o3、DeepSeek R1）
 */
export type ThinkingMode = 'NONE' | 'OPTIONAL' | 'FORCED';

export interface LLMProviderConfig {
  name: string;
  displayName: string;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingBudget: number; // 0 = 关闭 extended thinking
  thinkingDepth: ThinkingDepth; // 数据库中的 thinkingDepth 字段（默认深度）
  /** 模型的思考能力分类，决定 UI 展示和实际请求是否带 thinking 参数 */
  thinkingMode: ThinkingMode;
  /** 模型是否支持调节思考深度（low/medium/high）。false 时使用 thinkingDepth 固定值 */
  supportsThinkingDepth: boolean;
  /** 模型是否支持图片输入（多模态） */
  supportsImage: boolean;
  maxTokens: number;
  /**
   * 模型输入上下文窗口（token）。从数据库 LlmModel.contextWindow 取，
   * 环境变量 fallback 模式下默认 8192。reportManager / chatContextBuilder
   * 根据这个值计算 token 预算和 map-reduce 阈值。
   */
  contextWindow: number;
  temperature: number;
  isAnthropic: boolean; // Anthropic 原生 API 需要特殊处理
  /** 数据库模型 ID（从数据库加载时有值） */
  dbModelId?: string;
  /** 数据库 Provider ID（从数据库加载时有值） */
  dbProviderId?: string;
  /** 模型用途 */
  purpose?: LlmPurpose;
}

/**
 * Thinking depth → Anthropic Extended Thinking 的 budget_tokens 映射。
 * 仅当模型 thinkingMode != 'NONE' 且实际启用思考（FORCED 或 OPTIONAL+用户开）时使用。
 */
const THINKING_BUDGET_MAP: Record<ThinkingDepth, number> = {
  low: 2000,
  medium: 5000,
  high: 10000,
};
const llmLogger = logger.child({ component: 'llm-gateway' });

/* ------------------------------------------------------------------ */
/*  环境变量 fallback（保留向后兼容）                                      */
/* ------------------------------------------------------------------ */

/** 从环境变量解析所有 provider 配置（fallback 用） */
export function parseProviders(): Record<string, LLMProviderConfig> {
  const providers: Record<string, LLMProviderConfig> = {};
  const envKeys = Object.keys(process.env).filter((k) =>
    k.startsWith('LLM_PROVIDERS_')
  );

  // 提取所有 provider 前缀（如 CLAUDE, GPT, DEEPSEEK）
  const prefixes = new Set(
    envKeys.map((k) => k.replace('LLM_PROVIDERS_', '').split('_')[0])
  );

  for (const prefix of Array.from(prefixes)) {
    const get = (suffix: string) =>
      process.env[`LLM_PROVIDERS_${prefix}_${suffix}`] || '';
    const name = get('NAME');
    if (!name) continue;

    const isAnthropic = get('IS_ANTHROPIC') === 'true';
    // 环境变量 fallback：缺省按 Anthropic = OPTIONAL+depth、其他 = NONE 推断；
    // 用户可通过 THINKING_MODE / SUPPORTS_THINKING_DEPTH / SUPPORTS_IMAGE 覆盖
    const envThinkingMode = (get('THINKING_MODE') || '').toUpperCase();
    const thinkingMode: ThinkingMode =
      envThinkingMode === 'FORCED' || envThinkingMode === 'OPTIONAL'
        ? envThinkingMode
        : isAnthropic
          ? 'OPTIONAL'
          : 'NONE';
    const envSupportsDepth = get('SUPPORTS_THINKING_DEPTH').toLowerCase();
    const supportsThinkingDepth =
      envSupportsDepth === 'true' || envSupportsDepth === '1'
        ? true
        : envSupportsDepth === 'false' || envSupportsDepth === '0'
          ? false
          : isAnthropic;
    providers[name] = {
      name,
      displayName: get('DISPLAY_NAME'),
      apiBase: get('API_BASE'),
      apiKey: get('API_KEY'),
      model: get('MODEL'),
      thinkingBudget: parseInt(get('THINKING_BUDGET') || '0'),
      thinkingDepth: 'medium',
      thinkingMode,
      supportsThinkingDepth,
      supportsImage: get('SUPPORTS_IMAGE') === 'true',
      maxTokens: parseInt(get('MAX_TOKENS') || '4096'),
      // 环境变量 fallback：未配置时默认 8192（保守值，与 Prisma schema 默认一致）
      contextWindow: parseInt(get('CONTEXT_WINDOW') || '8192'),
      temperature: parseFloat(get('TEMPERATURE') || '0.3'),
      isAnthropic,
    };
  }
  return providers;
}

/* ------------------------------------------------------------------ */
/*  数据库查询函数                                                      */
/* ------------------------------------------------------------------ */

function normalizeThinkingMode(value: unknown): ThinkingMode {
  const v = typeof value === 'string' ? value.toUpperCase() : '';
  return v === 'FORCED' || v === 'OPTIONAL' ? v : 'NONE';
}

/** 将数据库模型 + 供应商 转为 LLMProviderConfig */
function dbModelToConfig(
  model: {
    id: string;
    modelId: string;
    displayName: string;
    thinkingDepth: string;
    thinkingMode: string;
    supportsThinkingDepth: boolean;
    supportsImage: boolean;
    maxTokens: number;
    contextWindow: number;
    temperature: number;
    purpose: string;
    isDefault: boolean;
    provider: {
      id: string;
      name: string;
      apiKey: string;
      apiBase: string;
      isAnthropic: boolean;
    };
  }
): LLMProviderConfig {
  const depth = model.thinkingDepth as ThinkingDepth;
  return {
    name: model.provider.name,
    displayName: model.displayName,
    apiBase: model.provider.apiBase,
    apiKey: decrypt(model.provider.apiKey), // 解密存储的 API Key
    model: model.modelId,
    thinkingBudget: THINKING_BUDGET_MAP[depth] ?? THINKING_BUDGET_MAP.medium,
    thinkingDepth: depth,
    thinkingMode: normalizeThinkingMode(model.thinkingMode),
    supportsThinkingDepth: Boolean(model.supportsThinkingDepth),
    supportsImage: Boolean(model.supportsImage),
    maxTokens: model.maxTokens,
    contextWindow: model.contextWindow,
    temperature: model.temperature,
    isAnthropic: model.provider.isAnthropic,
    dbModelId: model.id,
    dbProviderId: model.provider.id,
    purpose: model.purpose as LlmPurpose,
  };
}

/**
 * 按用途获取默认模型及其供应商配置。
 * 优先从数据库读取 isDefault=true 的模型，找不到则回退到环境变量。
 */
export async function getProviderForPurpose(
  purpose: LlmPurpose
): Promise<LLMProviderConfig> {
  try {
    // 优先查找该用途下 isDefault=true 的模型
    let model = await prisma.llmModel.findFirst({
      where: { purpose, isDefault: true },
      include: { provider: true },
      orderBy: { sortOrder: 'asc' },
    });

    // 如果没有默认模型，取该用途下排序最前的
    if (!model) {
      model = await prisma.llmModel.findFirst({
        where: { purpose },
        include: { provider: true },
        orderBy: { sortOrder: 'asc' },
      });
    }

    if (model) {
      return dbModelToConfig(model);
    }
  } catch {
    // 数据库不可用，回退到环境变量
    console.warn(`[LLM Gateway] 数据库查询失败，回退到环境变量配置 (purpose=${purpose})`);
  }

  // Fallback: 环境变量
  return getActiveProvider();
}

/**
 * 按数据库模型 ID 获取配置。
 * 找不到时回退到环境变量的 active provider。
 */
export async function getModelById(
  modelId: string
): Promise<LLMProviderConfig> {
  try {
    const model = await prisma.llmModel.findUnique({
      where: { id: modelId },
      include: { provider: true },
    });

    if (model) {
      return dbModelToConfig(model);
    }
  } catch {
    console.warn(`[LLM Gateway] 数据库查询失败，回退到环境变量配置 (modelId=${modelId})`);
  }

  // Fallback
  return getActiveProvider();
}

/**
 * 返回所有可用模型列表（从数据库读取）。
 * 数据库为空时回退到环境变量解析的模型。
 */
export async function listAvailableModels(): Promise<LLMProviderConfig[]> {
  try {
    const models = await prisma.llmModel.findMany({
      include: { provider: true },
      orderBy: [{ purpose: 'asc' }, { sortOrder: 'asc' }],
    });

    if (models.length > 0) {
      return models.map(dbModelToConfig);
    }
  } catch {
    console.warn('[LLM Gateway] 数据库查询失败，回退到环境变量配置');
  }

  // Fallback: 将环境变量配置转为数组
  return Object.values(parseProviders());
}

/* ------------------------------------------------------------------ */
/*  环境变量 active provider（兼容旧逻辑）                                */
/* ------------------------------------------------------------------ */

export function getActiveProvider(): LLMProviderConfig {
  const providers = parseProviders();
  const activeName = process.env.LLM_ACTIVE_PROVIDER || '';
  const provider = providers[activeName];
  if (!provider)
    throw new Error(`LLM provider "${activeName}" not configured`);
  return provider;
}

/* ------------------------------------------------------------------ */
/*  Thinking budget 解析                                               */
/* ------------------------------------------------------------------ */

/**
 * 决定一次请求的有效思考深度：
 *  - 模型不支持调节（supportsThinkingDepth=false）→ 模型默认值
 *  - 用户没传 → 模型默认值
 *  - 用户传了 → 用户值（合法时）
 */
function resolveEffectiveDepth(
  provider: LLMProviderConfig,
  requestedDepth?: ThinkingDepth
): ThinkingDepth {
  if (!provider.supportsThinkingDepth) {
    return provider.thinkingDepth;
  }
  if (
    requestedDepth === 'low' ||
    requestedDepth === 'medium' ||
    requestedDepth === 'high'
  ) {
    return requestedDepth;
  }
  return provider.thinkingDepth;
}

/**
 * 计算实际请求要带的 Anthropic Extended Thinking budget_tokens。
 *  thinkingMode = NONE                           → 0（不启用）
 *  thinkingMode = OPTIONAL && enabled !== true   → 0（用户没开）
 *  thinkingMode = OPTIONAL && enabled === true   → 按深度
 *  thinkingMode = FORCED                         → 按深度（无视 enabled）
 *
 * 仅在 Anthropic 路径生效。OpenAI-compat 模型不发 thinking 参数（即使是 o1/R1），
 * 服务器端会自然按模型本身的 reasoning 行为返回。
 */
function resolveThinkingBudget(
  provider: LLMProviderConfig,
  depth?: ThinkingDepth,
  enabled?: boolean
): number {
  if (provider.thinkingMode === 'NONE') return 0;
  if (provider.thinkingMode === 'OPTIONAL' && enabled !== true) return 0;
  if (!provider.isAnthropic) return 0;
  const eff = resolveEffectiveDepth(provider, depth);
  return THINKING_BUDGET_MAP[eff];
}

interface LLMCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface LLMCallResult {
  text: string;
  thinking?: string;
  usage?: LLMCallUsage;
}

/** callLLMWithHistory 的详细返回类型（包含 thinking） */
export interface LLMDetailedResult {
  text: string;
  thinking?: string;
}

async function executeLoggedCall(
  provider: LLMProviderConfig,
  context: {
    kind: 'single' | 'history';
    thinkingDepth?: ThinkingDepth;
    promptChars: number;
    messageCount: number;
    purpose?: LlmPurpose;
  },
  executor: () => Promise<LLMCallResult>,
  detailed?: false
): Promise<string>;
async function executeLoggedCall(
  provider: LLMProviderConfig,
  context: {
    kind: 'single' | 'history';
    thinkingDepth?: ThinkingDepth;
    promptChars: number;
    messageCount: number;
    purpose?: LlmPurpose;
  },
  executor: () => Promise<LLMCallResult>,
  detailed: true
): Promise<LLMDetailedResult>;
async function executeLoggedCall(
  provider: LLMProviderConfig,
  context: {
    kind: 'single' | 'history';
    thinkingDepth?: ThinkingDepth;
    promptChars: number;
    messageCount: number;
    purpose?: LlmPurpose;
  },
  executor: () => Promise<LLMCallResult>,
  detailed?: boolean
): Promise<string | LLMDetailedResult> {
  const startedAt = Date.now();

  try {
    const result = await executor();
    llmLogger.info(
      {
        provider: provider.name,
        model: provider.model,
        purpose: context.purpose ?? provider.purpose,
        kind: context.kind,
        thinkingDepth: context.thinkingDepth ?? provider.thinkingDepth,
        promptChars: context.promptChars,
        messageCount: context.messageCount,
        durationMs: Date.now() - startedAt,
        usage: result.usage,
      },
      'LLM request completed'
    );
    if (detailed) {
      return { text: result.text, thinking: result.thinking };
    }
    return result.text;
  } catch (error) {
    llmLogger.error(
      {
        provider: provider.name,
        model: provider.model,
        purpose: context.purpose ?? provider.purpose,
        kind: context.kind,
        thinkingDepth: context.thinkingDepth ?? provider.thinkingDepth,
        promptChars: context.promptChars,
        messageCount: context.messageCount,
        durationMs: Date.now() - startedAt,
        err: serializeError(error),
      },
      'LLM request failed'
    );
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  统一调用接口                                                        */
/* ------------------------------------------------------------------ */

/** 统一调用接口 — 支持按用途 / 按模型 ID / 按 provider 名称查找 */
export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  options?: {
    providerOverride?: string;
    thinkingDepth?: ThinkingDepth;
    /** 用户是否显式开启思考（仅对 thinkingMode=OPTIONAL 模型生效） */
    thinkingEnabled?: boolean;
    streamCallback?: (chunk: string) => void;
    /** 按用途查找（优先级高于 providerOverride） */
    purpose?: LlmPurpose;
    /** 按数据库模型 ID 查找 */
    modelId?: string;
  }
): Promise<string> {
  let provider: LLMProviderConfig;

  if (options?.modelId) {
    provider = await getModelById(options.modelId);
  } else if (options?.purpose) {
    provider = await getProviderForPurpose(options.purpose);
  } else if (options?.providerOverride) {
    const providers = parseProviders();
    provider = providers[options.providerOverride] ?? getActiveProvider();
  } else {
    provider = getActiveProvider();
  }

  const budget = resolveThinkingBudget(
    provider,
    options?.thinkingDepth,
    options?.thinkingEnabled
  );

  return executeLoggedCall(
    provider,
    {
      kind: 'single',
      thinkingDepth: options?.thinkingDepth,
      promptChars: systemPrompt.length + userMessage.length,
      messageCount: 1,
      purpose: options?.purpose,
    },
    () =>
      provider.isAnthropic
        ? callAnthropic(provider, systemPrompt, userMessage, budget)
        : callOpenAICompatible(
            provider,
            systemPrompt,
            userMessage,
            options?.thinkingDepth
          )
  );
}

/** 带历史消息的调用（用于 Chat） */
export async function callLLMWithHistory(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: {
    providerOverride?: string;
    thinkingDepth?: ThinkingDepth;
    thinkingEnabled?: boolean;
    purpose?: LlmPurpose;
    modelId?: string;
    detailed: true;
  }
): Promise<LLMDetailedResult>;
export async function callLLMWithHistory(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: {
    providerOverride?: string;
    thinkingDepth?: ThinkingDepth;
    /** 用户是否显式开启思考（仅对 thinkingMode=OPTIONAL 模型生效） */
    thinkingEnabled?: boolean;
    /** 按用途查找 */
    purpose?: LlmPurpose;
    /** 按数据库模型 ID 查找 */
    modelId?: string;
    /** 返回详细结果（包含 thinking） */
    detailed?: false;
  }
): Promise<string>;
export async function callLLMWithHistory(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: {
    providerOverride?: string;
    thinkingDepth?: ThinkingDepth;
    thinkingEnabled?: boolean;
    purpose?: LlmPurpose;
    modelId?: string;
    detailed?: boolean;
  }
): Promise<string | LLMDetailedResult> {
  let provider: LLMProviderConfig;

  if (options?.modelId) {
    provider = await getModelById(options.modelId);
  } else if (options?.purpose) {
    provider = await getProviderForPurpose(options.purpose);
  } else if (options?.providerOverride) {
    const providers = parseProviders();
    provider = providers[options.providerOverride] ?? getActiveProvider();
  } else {
    provider = getActiveProvider();
  }

  const budget = resolveThinkingBudget(
    provider,
    options?.thinkingDepth,
    options?.thinkingEnabled
  );
  const ctx = {
    kind: 'history' as const,
    thinkingDepth: options?.thinkingDepth,
    promptChars:
      systemPrompt.length +
      messages.reduce((total, message) => total + message.content.length, 0),
    messageCount: messages.length,
    purpose: options?.purpose,
  };
  const executor = () =>
    provider.isAnthropic
      ? callAnthropicWithHistory(provider, systemPrompt, messages, budget)
      : callOpenAICompatibleWithHistory(
          provider,
          systemPrompt,
          messages,
          options?.thinkingDepth
        );

  if (options?.detailed) {
    return executeLoggedCall(provider, ctx, executor, true);
  }
  return executeLoggedCall(provider, ctx, executor);
}

/* ------------------------------------------------------------------ */
/*  Anthropic 原生 API                                                 */
/* ------------------------------------------------------------------ */

async function callAnthropic(
  provider: LLMProviderConfig,
  system: string,
  userMsg: string,
  thinkingBudget: number
): Promise<LLMCallResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    system,
    messages: [{ role: 'user', content: userMsg }],
  };

  if (thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    };
    body.temperature = 1; // thinking 模式下 temperature 必须为 1
  } else {
    body.temperature = provider.temperature;
  }

  const res = await fetch(`${provider.apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${sanitizeApiError(errText)}`);
  }

  const data = await res.json() as {
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  let text = '';
  let thinking = '';
  for (const block of data.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinking += block.thinking;
    }
  }

  return {
    text,
    thinking: thinking || undefined,
    usage: {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      totalTokens:
        (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  };
}

async function callAnthropicWithHistory(
  provider: LLMProviderConfig,
  system: string,
  messages: Array<{ role: string; content: string }>,
  thinkingBudget: number
): Promise<LLMCallResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    system,
    messages,
  };

  if (thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    };
    body.temperature = 1;
  } else {
    body.temperature = provider.temperature;
  }

  const res = await fetch(`${provider.apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${sanitizeApiError(errText)}`);
  }

  const data = await res.json() as {
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  let text = '';
  let thinking = '';
  for (const block of data.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinking += block.thinking;
    }
  }

  return {
    text,
    thinking: thinking || undefined,
    usage: {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      totalTokens:
        (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  OpenAI-compatible API                                              */
/* ------------------------------------------------------------------ */

/**
 * 从 OpenAI 兼容 API 的 message 对象中提取 thinking / reasoning 内容。
 * 兼容多种格式：
 *   - OpenAI o1/o3: message.reasoning_content
 *   - DeepSeek R1:   message.reasoning_content
 *   - 其他兼容 API:  message.reasoning / message.thinking
 */
function extractOpenAIThinking(
  message: Record<string, unknown> | undefined
): string | undefined {
  if (!message) return undefined;
  const raw =
    message.reasoning_content ?? message.reasoning ?? message.thinking;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

async function callOpenAICompatible(
  provider: LLMProviderConfig,
  system: string,
  userMsg: string,
  depth?: ThinkingDepth
): Promise<LLMCallResult> {
  const temperature = depth === 'low' ? 0.1 : provider.temperature;

  const res = await fetch(`${provider.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: provider.maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI-compatible API error (${res.status}): ${sanitizeApiError(errText)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const msg = data.choices?.[0]?.message;

  return {
    text: (typeof msg?.content === 'string' ? msg.content : '') as string,
    thinking: extractOpenAIThinking(msg),
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
  };
}

async function callOpenAICompatibleWithHistory(
  provider: LLMProviderConfig,
  system: string,
  messages: Array<{ role: string; content: string }>,
  depth?: ThinkingDepth
): Promise<LLMCallResult> {
  const temperature = depth === 'low' ? 0.1 : provider.temperature;

  const res = await fetch(`${provider.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: provider.maxTokens,
      temperature,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI-compatible API error (${res.status}): ${sanitizeApiError(errText)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const msg = data.choices?.[0]?.message;

  return {
    text: (typeof msg?.content === 'string' ? msg.content : '') as string,
    thinking: extractOpenAIThinking(msg),
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Embedding API（OpenAI 兼容 /v1/embeddings 端点）                    */
/* ------------------------------------------------------------------ */

/**
 * 调用 EMBEDDING 用途的模型把文本批量转向量。复用 OpenAI 兼容 embeddings 端点。
 *
 * 国内模型支持情况（截至 2026-05）：
 *  - 豆包 / GLM / DeepSeek / Kimi / Minimax：通过 OpenAI 兼容协议都暴露 /embeddings
 *  - Anthropic Claude：不提供原生 embedding，需要切到 Voyage 等第三方
 *
 * 调用者应在 admin 后台为 LlmPurpose.EMBEDDING 配置一个合适的 OpenAI 兼容模型。
 */
export async function callEmbedding(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const provider = await getProviderForPurpose('EMBEDDING');

  if (provider.isAnthropic) {
    throw new Error(
      'Anthropic 不支持 embeddings 端点，请在 admin 面板把 EMBEDDING 用途配置到 OpenAI 兼容模型上'
    );
  }

  const startedAt = Date.now();
  const res = await fetch(`${provider.apiBase}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      input: texts,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Embedding API error (${res.status}): ${sanitizeApiError(errText)}`
    );
  }

  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };

  if (!Array.isArray(data.data) || data.data.length !== texts.length) {
    throw new Error(
      `Embedding API returned mismatched array (expected ${texts.length}, got ${data.data?.length ?? 0})`
    );
  }

  // 按 index 重排（OpenAI 协议保证按输入顺序，但保险起见排序）
  const sorted = [...data.data].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0)
  );
  const vectors = sorted.map((item) => {
    if (!Array.isArray(item.embedding)) {
      throw new Error('Embedding API response missing embedding array');
    }
    return item.embedding;
  });

  llmLogger.info(
    {
      provider: provider.name,
      model: provider.model,
      purpose: 'EMBEDDING',
      batchSize: texts.length,
      dim: vectors[0]?.length ?? 0,
      durationMs: Date.now() - startedAt,
      usage: data.usage,
    },
    'Embedding request completed'
  );

  return vectors;
}
