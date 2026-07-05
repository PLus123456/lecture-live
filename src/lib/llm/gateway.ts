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

/**
 * 出站 LLM 请求超时（防慢速上游拖垮请求处理器 / 连接耗尽）。
 *  - 非流式调用（callXxx / embedding）：整次请求总超时。
 *  - 流式调用（streamXxx）：仅给「响应头到达」设超时，拿到响应头即清除计时器，
 *    不限制后续 SSE body 流时长，避免误杀合法的长回答（与 nginx SSE 长超时一致）。
 */
const LLM_REQUEST_TIMEOUT_MS = 120_000;
const LLM_STREAM_HEADERS_TIMEOUT_MS = 60_000;

/**
 * 给流式出站请求加「响应头超时」：超时只在响应头到达前生效，到达后立即清除，
 * 故长 SSE 流不会被中途 abort。
 */
async function fetchStreamWithHeadersTimeout(
  url: string,
  init: RequestInit,
  headersTimeoutMs = LLM_STREAM_HEADERS_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), headersTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

/**
 * 思考模式（4 值）：
 *  NONE   - 模型不支持思考，请求不带 thinking/reasoning 参数
 *  AUTO   - 模型自己决定是否思考（GLM-4.5、DeepSeek-V3），请求不带参数
 *  FORCED - 模型自带思考无法关闭（o1/R1），OpenAI-compat 不发 reasoning_effort
 *  DEPTH  - 支持深度思考（Claude Extended Thinking、gpt-5），用户可调 off/low/med/high
 */
export type ThinkingMode = 'NONE' | 'AUTO' | 'FORCED' | 'DEPTH';

/**
 * 用户对一次请求的思考偏好（由前端拆出来的 selectedThinkingPreference 直传到 gateway）：
 *  off / low / medium / high — 用户在 DEPTH 模型上选的具体档位
 *  forced                    — 强制思考（不指定深度，用模型默认）
 *  auto                      — 让模型自己决定，不发任何 thinking 参数
 */
export type ThinkingPreference =
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'forced'
  | 'auto';

export interface LLMProviderConfig {
  name: string;
  displayName: string;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingDepth: ThinkingDepth; // 数据库中的 thinkingDepth 字段（默认深度）
  /** 模型的思考能力分类，决定 UI 展示和实际请求是否带 thinking 参数 */
  thinkingMode: ThinkingMode;
  /**
   * @deprecated 与 thinkingMode='DEPTH' 等价，保留字段是为了不破坏 admin 后台 API。
   * 新逻辑只看 thinkingMode。
   */
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
 * 仅当 thinkingMode='DEPTH' 实际启用思考时使用。
 */
const THINKING_BUDGET_MAP: Record<ThinkingDepth, number> = {
  low: 2000,
  medium: 5000,
  high: 10000,
};

/**
 * Anthropic Extended Thinking 要求 budget_tokens 严格小于 max_tokens，否则整次请求
 * 返回 400。THINKING_BUDGET_MAP 里的档位（medium=5000/high=10000）可能 >= 模型的
 * maxTokens（DEPTH 模型默认 maxTokens=4096），故按 maxTokens 钳一次：
 *  - 上界 maxTokens-1（满足 < max_tokens 硬约束）
 *  - 下界 1024（Anthropic 要求 budget_tokens>=1024，且预算被压得过小时仍能触发思考）
 * 极端情况下 maxTokens<=1024 时以 maxTokens-1 为准（宁可小于下限也不能 >= max_tokens）。
 */
function clampThinkingBudget(depth: ThinkingDepth, maxTokens: number): number {
  const desired = THINKING_BUDGET_MAP[depth];
  const upper = Math.max(1, maxTokens - 1);
  const clamped = Math.min(desired, upper);
  return Math.max(Math.min(1024, upper), clamped);
}
const llmLogger = logger.child({ component: 'llm-gateway' });

/* ------------------------------------------------------------------ */
/*  环境变量 fallback（保留向后兼容）                                      */
/* ------------------------------------------------------------------ */

/** 把任意字符串规范成 4 值 ThinkingMode；接受旧 'OPTIONAL'，按 isAnthropic 推断 */
function parseThinkingMode(value: unknown, isAnthropic: boolean): ThinkingMode {
  const v = typeof value === 'string' ? value.toUpperCase() : '';
  if (v === 'NONE' || v === 'AUTO' || v === 'FORCED' || v === 'DEPTH') {
    return v;
  }
  // 'OPTIONAL' 是旧 schema 值；按是否能调节深度推断
  if (v === 'OPTIONAL') {
    return isAnthropic ? 'DEPTH' : 'AUTO';
  }
  return isAnthropic ? 'DEPTH' : 'NONE';
}

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
    const thinkingMode = parseThinkingMode(get('THINKING_MODE'), isAnthropic);
    providers[name] = {
      name,
      displayName: get('DISPLAY_NAME'),
      apiBase: get('API_BASE'),
      apiKey: get('API_KEY'),
      model: get('MODEL'),
      thinkingDepth: 'medium',
      thinkingMode,
      // 派生字段：保留兼容输出，admin 后台/旧前端继续读
      supportsThinkingDepth: thinkingMode === 'DEPTH',
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
  const thinkingMode = parseThinkingMode(
    model.thinkingMode,
    model.provider.isAnthropic
  );
  return {
    name: model.provider.name,
    displayName: model.displayName,
    apiBase: model.provider.apiBase,
    apiKey: decrypt(model.provider.apiKey), // 解密存储的 API Key
    model: model.modelId,
    thinkingDepth: depth,
    thinkingMode,
    // 派生：admin 后台还在写 supportsThinkingDepth，但 gateway 不再用；
    // 输出时按 thinkingMode='DEPTH' 推导，保证与新 schema 语义一致。
    supportsThinkingDepth: thinkingMode === 'DEPTH',
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
/*  Thinking 参数构建                                                  */
/* ------------------------------------------------------------------ */

type ThinkingParams = {
  /** Anthropic Extended Thinking 参数（仅 Anthropic 路径用） */
  thinking?: { type: 'enabled'; budget_tokens: number };
  /** OpenAI-compat reasoning_effort 参数 */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  /** 最终 temperature —— Anthropic 在 thinking 启用时必须为 1 */
  temperature: number;
};

/** 旧调用方传 thinkingDepth/thinkingEnabled 时映射到新 preference 枚举 */
function legacyToPreference(
  thinkingDepth?: ThinkingDepth,
  thinkingEnabled?: boolean
): ThinkingPreference {
  if (thinkingEnabled === false) return 'off';
  if (thinkingDepth === 'low' || thinkingDepth === 'medium' || thinkingDepth === 'high') {
    return thinkingDepth;
  }
  return 'auto';
}

/**
 * 根据 provider × mode × userPref 计算这一次请求要带的 thinking 参数。
 * 详细分支表见 PR 描述。Anthropic 与 OpenAI 兼容两条路径都走这里，
 * 派生出 thinking / reasoning_effort / temperature 后由调用方拼到请求体里。
 */
function buildThinkingParams(
  provider: LLMProviderConfig,
  userPref: ThinkingPreference
): ThinkingParams {
  const isAnthropic = provider.isAnthropic;
  const mode = provider.thinkingMode;

  // 默认：不发任何 thinking 参数，用 provider.temperature
  const empty: ThinkingParams = { temperature: provider.temperature };

  if (mode === 'NONE' || mode === 'AUTO') {
    return empty;
  }

  if (mode === 'FORCED') {
    if (isAnthropic) {
      // Anthropic 的 FORCED：用模型默认深度强制启用
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: clampThinkingBudget(
            provider.thinkingDepth,
            provider.maxTokens
          ),
        },
        temperature: 1,
      };
    }
    // OpenAI-compat FORCED 模型自带思考，不发 reasoning_effort
    return empty;
  }

  // mode === 'DEPTH'
  if (isAnthropic) {
    if (userPref === 'off') return empty;
    const depth: ThinkingDepth =
      userPref === 'low' || userPref === 'medium' || userPref === 'high'
        ? userPref
        : provider.thinkingDepth; // forced / auto → 用模型默认深度
    return {
      thinking: {
        type: 'enabled',
        budget_tokens: clampThinkingBudget(depth, provider.maxTokens),
      },
      temperature: 1,
    };
  }

  // OpenAI-compat × DEPTH
  if (userPref === 'off') {
    return { ...empty, reasoning_effort: 'minimal' };
  }
  if (userPref === 'low' || userPref === 'medium' || userPref === 'high') {
    return { ...empty, reasoning_effort: userPref };
  }
  // forced / auto → 用模型默认深度
  return { ...empty, reasoning_effort: provider.thinkingDepth };
}

interface LLMCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/* ------------------------------------------------------------------ */
/*  多模态消息（图片输入）                                                */
/* ------------------------------------------------------------------ */

/** 一张随聊天消息上传的图片（base64 data URL 已被拆成 mediaType + data） */
export interface ChatImageInput {
  /** 如 "image/png" */
  mediaType: string;
  /** 纯 base64（不含 data: 前缀） */
  data: string;
}

/** 带历史 + 可选图片的聊天消息（图片仅对当前轮 user 消息有意义） */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 多模态图片（仅当前轮 user 消息携带；历史消息不重发图片） */
  images?: ChatImageInput[];
}

/** 流式事件：思考增量 / 正文增量 / token 用量 */
export type LLMStreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number };

/** 流式调用结束后的汇总结果 */
export interface LLMStreamResult {
  text: string;
  thinking?: string;
  usage?: LLMCallUsage;
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
    thinkingPref?: ThinkingPreference;
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
    thinkingPref?: ThinkingPreference;
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
    thinkingPref?: ThinkingPreference;
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
        thinkingMode: provider.thinkingMode,
        thinkingPref: context.thinkingPref ?? 'auto',
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
        thinkingMode: provider.thinkingMode,
        thinkingPref: context.thinkingPref ?? 'auto',
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

interface CallOptions {
  providerOverride?: string;
  /** @deprecated 用 thinkingPreference 代替 */
  thinkingDepth?: ThinkingDepth;
  /** @deprecated 用 thinkingPreference 代替 */
  thinkingEnabled?: boolean;
  /** 用户对一次请求的思考偏好（4 值新接口） */
  thinkingPreference?: ThinkingPreference;
  streamCallback?: (chunk: string) => void;
  purpose?: LlmPurpose;
  modelId?: string;
}

/** 解析调用方传入的 options 找到 provider + thinkingPref */
async function resolveProviderAndPref(options?: CallOptions): Promise<{
  provider: LLMProviderConfig;
  pref: ThinkingPreference;
}> {
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

  const pref =
    options?.thinkingPreference ??
    legacyToPreference(options?.thinkingDepth, options?.thinkingEnabled);

  return { provider, pref };
}

/** 统一调用接口 — 支持按用途 / 按模型 ID / 按 provider 名称查找 */
export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  options?: CallOptions
): Promise<string> {
  const { provider, pref } = await resolveProviderAndPref(options);
  const thinkingParams = buildThinkingParams(provider, pref);

  return executeLoggedCall(
    provider,
    {
      kind: 'single',
      thinkingPref: pref,
      promptChars: systemPrompt.length + userMessage.length,
      messageCount: 1,
      purpose: options?.purpose,
    },
    () =>
      provider.isAnthropic
        ? callAnthropic(provider, systemPrompt, userMessage, thinkingParams)
        : callOpenAICompatible(
            provider,
            systemPrompt,
            userMessage,
            thinkingParams
          )
  );
}

/** 带历史消息的调用（用于 Chat） */
export async function callLLMWithHistory(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: CallOptions & { detailed: true }
): Promise<LLMDetailedResult>;
export async function callLLMWithHistory(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: CallOptions & { detailed?: false }
): Promise<string>;
export async function callLLMWithHistory(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: CallOptions & { detailed?: boolean }
): Promise<string | LLMDetailedResult> {
  const { provider, pref } = await resolveProviderAndPref(options);
  const thinkingParams = buildThinkingParams(provider, pref);
  const ctx = {
    kind: 'history' as const,
    thinkingPref: pref,
    promptChars:
      systemPrompt.length +
      messages.reduce((total, message) => total + message.content.length, 0),
    messageCount: messages.length,
    purpose: options?.purpose,
  };
  const executor = () =>
    provider.isAnthropic
      ? callAnthropicWithHistory(provider, systemPrompt, messages, thinkingParams)
      : callOpenAICompatibleWithHistory(
          provider,
          systemPrompt,
          messages,
          thinkingParams
        );

  if (options?.detailed) {
    return executeLoggedCall(provider, ctx, executor, true);
  }
  return executeLoggedCall(provider, ctx, executor);
}

/* ------------------------------------------------------------------ */
/*  流式调用接口（SSE）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 逐行读取 fetch Response 的 SSE 流，对每个非空 data 行回调 handler。
 * 兼容 Anthropic（event:+data: 成对）与 OpenAI（纯 data: 行）两种 SSE 格式 ——
 * 这里只关心 data: 负载，event: 行交给上层从 JSON 的 type 字段判断。
 */
async function readSseLines(
  res: Response,
  onData: (data: string) => void
): Promise<void> {
  const body = res.body;
  if (!body) throw new Error('Streaming response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 事件以空行分隔；逐行处理 data: 前缀
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
      buffer = buffer.slice(newlineIdx + 1);
      if (line.startsWith('data:')) {
        onData(line.slice(5).trim());
      }
    }
  }
  // flush 残留行
  const tail = buffer.replace(/\r$/, '');
  if (tail.startsWith('data:')) {
    onData(tail.slice(5).trim());
  }
}

/**
 * 流式带历史调用。Anthropic-native 走 /v1/messages?stream=true，
 * OpenAI 兼容走 /chat/completions?stream=true。每个增量通过 onEvent 上抛，
 * 全流结束后返回累计的 text/thinking/usage。
 *
 * 注意：保留与 callLLMWithHistory 完全一致的 provider/thinking 解析路径，
 * 非流式接口未受影响（sessionFinalization 等仍用 callLLM/callLLMWithHistory）。
 */
export async function callLLMWithHistoryStream(
  systemPrompt: string,
  messages: ReadonlyArray<ChatHistoryMessage>,
  options: CallOptions,
  onEvent: (ev: LLMStreamEvent) => void
): Promise<LLMStreamResult> {
  const { provider, pref } = await resolveProviderAndPref(options);
  const thinkingParams = buildThinkingParams(provider, pref);
  const startedAt = Date.now();

  try {
    const result = provider.isAnthropic
      ? await streamAnthropicWithHistory(
          provider,
          systemPrompt,
          messages,
          thinkingParams,
          onEvent
        )
      : await streamOpenAICompatibleWithHistory(
          provider,
          systemPrompt,
          messages,
          thinkingParams,
          onEvent
        );
    llmLogger.info(
      {
        provider: provider.name,
        model: provider.model,
        purpose: options.purpose ?? provider.purpose,
        kind: 'history-stream',
        thinkingMode: provider.thinkingMode,
        thinkingPref: pref,
        messageCount: messages.length,
        durationMs: Date.now() - startedAt,
        usage: result.usage,
      },
      'LLM streaming request completed'
    );
    return result;
  } catch (error) {
    llmLogger.error(
      {
        provider: provider.name,
        model: provider.model,
        purpose: options.purpose ?? provider.purpose,
        kind: 'history-stream',
        thinkingMode: provider.thinkingMode,
        thinkingPref: pref,
        messageCount: messages.length,
        durationMs: Date.now() - startedAt,
        err: serializeError(error),
      },
      'LLM streaming request failed'
    );
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  多模态 content 构建                                                  */
/* ------------------------------------------------------------------ */

/**
 * Anthropic content block：当前轮带图时拼成 [text, image...]。
 * supportsImage=false 时忽略图片、退回纯文本 —— 防止把持久化的图片附件发给纯文本
 * 模型触发上游 400（该 400 非 context-length，降级重试无效，会导致每轮失败）。
 */
function buildAnthropicContent(
  msg: ChatHistoryMessage,
  supportsImage: boolean
): string | Array<Record<string, unknown>> {
  if (!supportsImage || !msg.images || msg.images.length === 0) {
    return msg.content;
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  for (const img of msg.images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    });
  }
  return blocks;
}

/**
 * OpenAI content：当前轮带图时拼成 [text, image_url...]。
 * supportsImage=false 时忽略图片、退回纯文本（同 Anthropic 侧，避免纯文本模型收到
 * image_url 触发上游 400）。
 */
function buildOpenAIContent(
  msg: ChatHistoryMessage,
  supportsImage: boolean
): string | Array<Record<string, unknown>> {
  if (!supportsImage || !msg.images || msg.images.length === 0) {
    return msg.content;
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  for (const img of msg.images) {
    blocks.push({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    });
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/*  Anthropic 原生 API                                                 */
/* ------------------------------------------------------------------ */

async function callAnthropic(
  provider: LLMProviderConfig,
  system: string,
  userMsg: string,
  params: ThinkingParams
): Promise<LLMCallResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    system,
    messages: [{ role: 'user', content: userMsg }],
    temperature: params.temperature,
  };

  if (params.thinking) {
    body.thinking = params.thinking;
  }

  const res = await fetch(`${provider.apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
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
  params: ThinkingParams
): Promise<LLMCallResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    system,
    messages,
    temperature: params.temperature,
  };

  if (params.thinking) {
    body.thinking = params.thinking;
  }

  const res = await fetch(`${provider.apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
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

/**
 * Anthropic 原生流式带历史调用（POST /v1/messages, stream:true）。
 * 解析 content_block_delta：text_delta → 正文；thinking_delta → 思考。
 * message_start 携带 input_tokens，message_delta 携带 output_tokens。
 */
async function streamAnthropicWithHistory(
  provider: LLMProviderConfig,
  system: string,
  messages: ReadonlyArray<ChatHistoryMessage>,
  params: ThinkingParams,
  onEvent: (ev: LLMStreamEvent) => void
): Promise<LLMStreamResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    system,
    // 过滤掉 content 为空/纯空白的历史消息：Anthropic Messages API 对空 content
    // 的消息返回 400，会毒化整条对话（此前某轮落库空 assistant 消息即触发）。
    messages: messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({
        role: m.role,
        content: buildAnthropicContent(m, provider.supportsImage),
      })),
    temperature: params.temperature,
    stream: true,
  };
  if (params.thinking) {
    body.thinking = params.thinking;
  }

  const res = await fetchStreamWithHeadersTimeout(
    `${provider.apiBase}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Anthropic API error (${res.status}): ${sanitizeApiError(errText)}`
    );
  }

  let text = '';
  let thinking = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  // 记录 mid-stream error 事件：Anthropic 上游过载/超限时会先发 {"type":"error",...}
  // 再关流。若不捕获，截断的半句正文会被当成功返回并永久落库。读完流后统一抛出，
  // 让路由把它当失败处理（不落库 assistant 消息）。
  let streamError: string | undefined;

  await readSseLines(res, (data) => {
    if (!data || data === '[DONE]') return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const eventType = parsed.type;

    if (eventType === 'error') {
      const errObj = parsed.error as Record<string, unknown> | undefined;
      const errMsg =
        typeof errObj?.message === 'string'
          ? errObj.message
          : typeof errObj?.type === 'string'
            ? errObj.type
            : 'unknown streaming error';
      streamError = sanitizeApiError(errMsg);
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        onEvent({ type: 'text', delta: delta.text });
      } else if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        thinking += delta.thinking;
        onEvent({ type: 'thinking', delta: delta.thinking });
      }
    } else if (eventType === 'message_start') {
      const msg = parsed.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (typeof usage?.input_tokens === 'number') {
        inputTokens = usage.input_tokens;
        onEvent({ type: 'usage', inputTokens });
      }
    } else if (eventType === 'message_delta') {
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (typeof usage?.output_tokens === 'number') {
        outputTokens = usage.output_tokens;
        onEvent({ type: 'usage', outputTokens });
      }
    }
  });

  if (streamError) {
    throw new Error(`Anthropic streaming error: ${streamError}`);
  }

  return {
    text,
    thinking: thinking || undefined,
    usage: { inputTokens, outputTokens },
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

/** 在 reasoning_effort='minimal' 时让 temperature 收紧一点，匹配老逻辑的 low=0.1 */
function temperatureForOpenAI(
  provider: LLMProviderConfig,
  params: ThinkingParams
): number {
  if (params.reasoning_effort === 'minimal' || params.reasoning_effort === 'low') {
    return Math.min(provider.temperature, 0.1);
  }
  return params.temperature;
}

async function callOpenAICompatible(
  provider: LLMProviderConfig,
  system: string,
  userMsg: string,
  params: ThinkingParams
): Promise<LLMCallResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    temperature: temperatureForOpenAI(provider, params),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ],
  };
  if (params.reasoning_effort) {
    body.reasoning_effort = params.reasoning_effort;
  }

  const res = await fetch(`${provider.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
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
  params: ThinkingParams
): Promise<LLMCallResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    temperature: temperatureForOpenAI(provider, params),
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (params.reasoning_effort) {
    body.reasoning_effort = params.reasoning_effort;
  }

  const res = await fetch(`${provider.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
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

/**
 * OpenAI 兼容流式带历史调用（POST /chat/completions, stream:true）。
 * 解析 choices[0].delta.content → 正文；delta.reasoning_content / reasoning → 思考。
 * stream_options.include_usage=true 让最后一个 chunk 携带 usage。
 */
async function streamOpenAICompatibleWithHistory(
  provider: LLMProviderConfig,
  system: string,
  messages: ReadonlyArray<ChatHistoryMessage>,
  params: ThinkingParams,
  onEvent: (ev: LLMStreamEvent) => void
): Promise<LLMStreamResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    temperature: temperatureForOpenAI(provider, params),
    messages: [
      { role: 'system', content: system },
      // 过滤空 content 历史消息（与 Anthropic 侧一致）：多数 OpenAI 兼容 provider
      // 容忍空串，但个别实现同样报错；统一过滤避免对话中毒的跨 provider 差异。
      ...messages
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({
          role: m.role,
          content: buildOpenAIContent(m, provider.supportsImage),
        })),
    ],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.reasoning_effort) {
    body.reasoning_effort = params.reasoning_effort;
  }

  const res = await fetchStreamWithHeadersTimeout(
    `${provider.apiBase}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `OpenAI-compatible API error (${res.status}): ${sanitizeApiError(errText)}`
    );
  }

  let text = '';
  let thinking = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  // mid-stream error 兜底（部分 OpenAI 兼容 provider 会在 data 行里塞 {"error":{...}}
  // 后关流）——读完流后统一抛出，避免把截断正文当成功持久化。
  let streamError: string | undefined;

  await readSseLines(res, (data) => {
    if (!data || data === '[DONE]') return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    const errObj = parsed.error as Record<string, unknown> | undefined;
    if (errObj) {
      const errMsg =
        typeof errObj.message === 'string'
          ? errObj.message
          : typeof errObj.type === 'string'
            ? errObj.type
            : 'unknown streaming error';
      streamError = sanitizeApiError(errMsg);
      return;
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onEvent({ type: 'text', delta: delta.content });
      }
      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
      if (reasoning) {
        thinking += reasoning;
        onEvent({ type: 'thinking', delta: reasoning });
      }
    }

    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === 'number') {
        inputTokens = usage.prompt_tokens;
      }
      if (typeof usage.completion_tokens === 'number') {
        outputTokens = usage.completion_tokens;
      }
      onEvent({ type: 'usage', inputTokens, outputTokens });
    }
  });

  if (streamError) {
    throw new Error(`OpenAI-compatible streaming error: ${streamError}`);
  }

  return {
    text,
    thinking: thinking || undefined,
    usage: { inputTokens, outputTokens },
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
/**
 * 单次 /embeddings 请求的最大输入条数。国内 embedding 供应商普遍对单请求 input
 * 数组长度设上限（如智谱 embedding-3 = 64）；长转录/多录音首建 RAG 时 chunk 数可轻易
 * 破百。取 32 兼顾各家（远低于常见 64 上限），超出即分批循环调用后按序合并。
 * 可用环境变量 LLM_EMBEDDING_BATCH_SIZE 覆盖。
 */
function getEmbeddingBatchSize(): number {
  const raw = parseInt(process.env.LLM_EMBEDDING_BATCH_SIZE || '', 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return 32;
}

/** 对单批文本调用 /embeddings 端点，返回与输入等长、按 index 有序的向量数组 */
async function callEmbeddingBatch(
  provider: LLMProviderConfig,
  texts: string[]
): Promise<number[][]> {
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
    signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
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
  return sorted.map((item) => {
    if (!Array.isArray(item.embedding)) {
      throw new Error('Embedding API response missing embedding array');
    }
    return item.embedding;
  });
}

export async function callEmbedding(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const provider = await getProviderForPurpose('EMBEDDING');

  if (provider.isAnthropic) {
    throw new Error(
      `Anthropic provider「${provider.name}」不支持 embeddings 端点。` +
        '请到 admin 面板「LLM Providers」配置一个 OpenAI 兼容 provider（如 OpenAI、OpenRouter、火山、智谱，或自建的 text-embedding 模型），' +
        '并把它的某个 model 用途设为 EMBEDDING 并勾选「设为默认」后保存。'
    );
  }

  const startedAt = Date.now();
  const batchSize = getEmbeddingBatchSize();

  // 分批：单请求输入条数超供应商上限会整批 400（被上层静默吞成空串导致 RAG 永久失效），
  // 故按 batchSize 切片循环调用，再按输入顺序合并（各批向量顺序已在 callEmbeddingBatch
  // 内按 index 归位）。
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const batchVectors = await callEmbeddingBatch(provider, batch);
    for (const v of batchVectors) vectors.push(v);
  }

  llmLogger.info(
    {
      provider: provider.name,
      model: provider.model,
      purpose: 'EMBEDDING',
      inputCount: texts.length,
      batchSize,
      batches: Math.ceil(texts.length / batchSize),
      dim: vectors[0]?.length ?? 0,
      durationMs: Date.now() - startedAt,
    },
    'Embedding request completed'
  );

  return vectors;
}
