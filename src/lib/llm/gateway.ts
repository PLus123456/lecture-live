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

export interface LLMProviderConfig {
  name: string;
  displayName: string;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingBudget: number; // 0 = 关闭 extended thinking
  thinkingDepth: ThinkingDepth; // 数据库中的 thinkingDepth 字段
  maxTokens: number;
  temperature: number;
  isAnthropic: boolean; // Anthropic 原生 API 需要特殊处理
  /** 数据库模型 ID（从数据库加载时有值） */
  dbModelId?: string;
  /** 数据库 Provider ID（从数据库加载时有值） */
  dbProviderId?: string;
  /** 模型用途 */
  purpose?: LlmPurpose;
}

/** Thinking depth → thinking budget tokens mapping */
const THINKING_BUDGET_MAP: Record<ThinkingDepth, number> = {
  low: 0,        // No thinking
  medium: 0,     // No thinking (use default model behavior)
  high: 10000,   // Extended thinking with budget
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

    providers[name] = {
      name,
      displayName: get('DISPLAY_NAME'),
      apiBase: get('API_BASE'),
      apiKey: get('API_KEY'),
      model: get('MODEL'),
      thinkingBudget: parseInt(get('THINKING_BUDGET') || '0'),
      thinkingDepth: 'medium',
      maxTokens: parseInt(get('MAX_TOKENS') || '4096'),
      temperature: parseFloat(get('TEMPERATURE') || '0.3'),
      isAnthropic: get('IS_ANTHROPIC') === 'true',
    };
  }
  return providers;
}

/* ------------------------------------------------------------------ */
/*  数据库查询函数                                                      */
/* ------------------------------------------------------------------ */

/** 将数据库模型 + 供应商 转为 LLMProviderConfig */
function dbModelToConfig(
  model: {
    id: string;
    modelId: string;
    displayName: string;
    thinkingDepth: string;
    maxTokens: number;
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
    thinkingBudget: THINKING_BUDGET_MAP[depth] ?? 0,
    thinkingDepth: depth,
    maxTokens: model.maxTokens,
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

/** Resolve effective thinking budget for a request */
function resolveThinkingBudget(
  provider: LLMProviderConfig,
  depth?: ThinkingDepth
): number {
  if (!depth || depth === 'low' || depth === 'medium') {
    // low/medium: use 0 (no thinking), regardless of provider default
    return depth === 'low' ? 0 : provider.thinkingBudget;
  }
  // high: use our budget map, but only for Anthropic
  if (!provider.isAnthropic) return 0;
  return THINKING_BUDGET_MAP[depth];
}

interface LLMCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface LLMCallResult {
  text: string;
  usage?: LLMCallUsage;
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
  executor: () => Promise<LLMCallResult>
): Promise<string> {
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

  const budget = resolveThinkingBudget(provider, options?.thinkingDepth);

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
  options?: {
    providerOverride?: string;
    thinkingDepth?: ThinkingDepth;
    /** 按用途查找 */
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

  const budget = resolveThinkingBudget(provider, options?.thinkingDepth);

  return executeLoggedCall(
    provider,
    {
      kind: 'history',
      thinkingDepth: options?.thinkingDepth,
      promptChars:
        systemPrompt.length +
        messages.reduce((total, message) => total + message.content.length, 0),
      messageCount: messages.length,
      purpose: options?.purpose,
    },
    () =>
      provider.isAnthropic
        ? callAnthropicWithHistory(provider, systemPrompt, messages, budget)
        : callOpenAICompatibleWithHistory(
            provider,
            systemPrompt,
            messages,
            options?.thinkingDepth
          )
  );
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
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  const text = (data.content ?? []).reduce((result, block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return result + block.text;
    }
    return result;
  }, '');

  return {
    text,
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
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  const text = (data.content ?? []).reduce((result, block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return result + block.text;
    }
    return result;
  }, '');

  return {
    text,
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
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  return {
    text: data.choices?.[0]?.message?.content ?? '',
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
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
  };
}
