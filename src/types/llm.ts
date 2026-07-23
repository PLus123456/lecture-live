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
  /** 思考耗时（毫秒），用于"已深度思考 Ns"标签（assistant only） */
  thinkingMs?: number;
  /** 该消息是否仍在 SSE 流式生成中（assistant only） */
  streaming?: boolean;
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
  | 'EMBEDDING'
  | 'TRANSLATION';

/**
 * 思考模式（与后端 LlmModel.thinkingMode 一致）
 * 'OPTIONAL' 为历史值，等价于：supportsThinkingDepth=true → 'DEPTH'，否则 → 'AUTO'。
 * 当前 gateway 内部仍输出 'OPTIONAL'；admin UI / API 在边界处归一化为 4 值新枚举。
 * TODO(unit-3): gateway 迁移完成后从联合中移除 'OPTIONAL'。
 */
export type ThinkingMode = 'NONE' | 'AUTO' | 'FORCED' | 'DEPTH' | 'OPTIONAL';

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
   * 详细思考模式：
   *  - 'NONE'   : 模型不思考，UI 隐藏开关与深度选择器
   *  - 'AUTO'   : 让模型自行决定是否思考，不发送 thinking 参数
   *  - 'FORCED' : 模型自带思考无法关闭，UI 不显示开关；按固定深度（thinking_budget）发送
   *  - 'DEPTH'  : 模型支持思考且允许用户在 chat 端调节深度（低/中/高）
   */
  supportsThinkingDepth: boolean;
  /** Allowed thinking depths for this model（仅 mode='DEPTH' 时非空） */
  allowedDepths: ThinkingDepth[];
  /** 是否支持图片输入（多模态） */
  supportsImage: boolean;
  /** 模型输入上下文窗口（token），用于前端 token 用量小圈预算估算 */
  contextWindow: number;
  /** 模型用途 */
  purpose?: LlmPurpose;
}

/** Response shape of GET /api/llm/models */
export interface ChatModelsResponse {
  models: ChatModelOption[];
  defaultModel: string;
}
