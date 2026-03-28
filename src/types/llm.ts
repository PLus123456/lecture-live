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
export type LlmPurpose = 'CHAT' | 'REALTIME_SUMMARY' | 'FINAL_SUMMARY' | 'KEYWORD_EXTRACTION';

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
  /** Whether this model supports thinking depth selection */
  supportsThinking: boolean;
  /** Allowed thinking depths for this model */
  allowedDepths: ThinkingDepth[];
  /** 模型用途 */
  purpose?: LlmPurpose;
}

/** Response shape of GET /api/llm/models */
export interface ChatModelsResponse {
  models: ChatModelOption[];
  defaultModel: string;
}
