export interface LLMProviderInfo {
  name: string;
  displayName: string;
  isAvailable: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Which model generated this reply (assistant only) */
  model?: string;
  /** Thinking depth used for this reply (assistant only) */
  thinkingDepth?: ThinkingDepth;
  /** LLM 的思考过程（extended thinking 或 /keyword 步骤） */
  thinking?: string;
}

export interface KeywordEntry {
  text: string;
  source: 'manual' | 'llm' | string; // string = filename e.g. "slides.pptx"
  active: boolean;
}

/**
 * Thinking depth controls how deeply the model reasons before answering.
 * - low:    No extended thinking, fast response, good for simple lookups
 * - medium: Default balanced mode
 * - high:   Extended thinking enabled, good for complex analysis
 */
export type ThinkingDepth = 'low' | 'medium' | 'high';

/** LLM 用途枚举（与 Prisma LlmPurpose 对应） */
export type LlmPurpose =
  | 'CHAT'
  | 'REALTIME_SUMMARY'
  | 'FINAL_SUMMARY'
  | 'KEYWORD_EXTRACTION'
  | 'EMBEDDING';

/**
 * 思考模式（与后端 LlmModel.thinkingMode 一致）：
 *  - NONE   : 模型不支持思考，请求不带任何 thinking 参数
 *  - AUTO   : 模型自己决定是否思考，请求不带 thinking/reasoning 参数（GLM-4.5、DeepSeek-V3 等）
 *  - FORCED : 模型自带思考无法关闭（o1/o3、R1）；OpenAI 兼容不发 reasoning_effort
 *  - DEPTH  : 支持深度思考（Claude Extended Thinking、gpt-5 reasoning_effort），用户可调 off/low/med/high
 */
export type ThinkingMode = 'NONE' | 'AUTO' | 'FORCED' | 'DEPTH';

/** What the /api/llm/models endpoint returns per model */
export interface ChatModelOption {
  /** 兼容标识 — 数据库模式下为 dbModelId，环境变量模式下为 provider name */
  name: string;
  /** 模型数据库 ID（数据库模式下有值） */
  id?: string;
  /** 模型标识（如 "gpt-4o", "claude-sonnet-4-6"） */
  modelId?: string;
  /** Human-readable label shown in UI */
  displayName: string;
  /**
   * @deprecated 用 `thinkingMode !== 'NONE'` 代替。保留输出仅为兼容旧前端代码。
   */
  supportsThinking: boolean;
  /** 模型思考能力分类，决定底部"思考"按钮 popover 的选项集 */
  thinkingMode: ThinkingMode;
  /**
   * @deprecated 用 `thinkingMode === 'DEPTH'` 代替。
   * 保留字段：admin 后台数据库还有 supportsThinkingDepth 列，前端临时回显用。
   */
  supportsThinkingDepth: boolean;
  /** Allowed thinking depths for this model（仅 mode='DEPTH' 时非空） */
  allowedDepths: ThinkingDepth[];
  /** 是否支持图片输入（多模态） */
  supportsImage: boolean;
  /** 模型用途 */
  purpose?: LlmPurpose;
}

/** Response shape of GET /api/llm/models */
export interface ChatModelsResponse {
  models: ChatModelOption[];
  defaultModel: string;
}
