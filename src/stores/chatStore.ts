'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ChatMessage, ChatModelOption, ThinkingDepth } from '@/types/llm';

/** 对话元数据（含活跃/已关闭状态） */
export interface ConversationMeta {
  id: string;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  degradationLevel: number;
  messageCount: number;
}

/** 前端 token 用量估算（用于小圈 UI） */
export interface ChatTokenUsage {
  used: number;
  budget: number;
  level: number;
  breakdown: {
    systemPrompt: number;
    transcript: number;
    summary: number;
    history: number;
    userInput: number;
  };
}

/**
 * 用户对一次请求的思考偏好。前端把 selectedDepth + selectedThinkingEnabled 合成一个单一字段：
 *  - off            : 不思考
 *  - low/medium/high: DEPTH 模型上选的档位
 *  - forced         : 强制思考（DEPTH 模型用模型默认深度；FORCED/AUTO 模型一致）
 *  - auto           : 让模型/网关自决，请求不带 thinking 参数
 */
export type ThinkingPreference =
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'forced'
  | 'auto';

interface ChatStore {
  // ── 用户偏好（持久化） ──
  selectedModel: string;
  selectedThinkingPreference: ThinkingPreference;

  // ── 运行时状态（不持久化） ──
  isLoading: boolean;
  availableModels: ChatModelOption[];
  modelsLoaded: boolean;

  /** 当前活跃 conversation ID */
  activeConversationId: string | null;
  /** 当前 session 下所有 conversations（含已关闭的，用于切换选择） */
  conversations: ConversationMeta[];
  /** 活跃 conversation 的消息（按时间序） */
  messages: ChatMessage[];
  /** 主动压缩切割点之前的"已折叠"消息（UI 展开后可见，但不再发给 LLM） */
  archivedMessages: ChatMessage[];
  /** 最近一次 token usage 估算（供小圈 UI 用） */
  tokenUsage: ChatTokenUsage | null;
  /** 上下文已满标志（413 错误后置位，提示用户新建对话） */
  contextFull: boolean;

  // ── Setters ──
  setLoading: (loading: boolean) => void;
  setSelectedModel: (model: string) => void;
  setSelectedThinkingPreference: (pref: ThinkingPreference) => void;
  setAvailableModels: (models: ChatModelOption[], defaultModel: string) => void;

  setActiveConversation: (id: string | null) => void;
  setConversations: (list: ConversationMeta[]) => void;
  addConversation: (conv: ConversationMeta) => void;

  setMessages: (messages: ChatMessage[], archived?: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  /** 按 id 局部更新一条消息（流式增量用） */
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;

  setTokenUsage: (usage: ChatTokenUsage | null) => void;
  setContextFull: (full: boolean) => void;

  /** 重置当前 session 的运行时状态（切换 session 或退出时调用） */
  resetSession: () => void;
}

const initialRuntimeState = {
  isLoading: false,
  availableModels: [] as ChatModelOption[],
  modelsLoaded: false,
  activeConversationId: null,
  conversations: [] as ConversationMeta[],
  messages: [] as ChatMessage[],
  archivedMessages: [] as ChatMessage[],
  tokenUsage: null,
  contextFull: false,
} as const;

const DEFAULT_PREFERENCE: ThinkingPreference = 'auto';

/**
 * 旧 persist schema 兼容：把 selectedThinkingEnabled + selectedDepth 合并成
 * 新的 selectedThinkingPreference 字段，向前端保留单一信息源。
 * 旧字段读到后不再写回（partialize 只持久化新字段）。
 */
function migrateLegacyThinking(state: unknown): ThinkingPreference {
  if (!state || typeof state !== 'object') return DEFAULT_PREFERENCE;
  const s = state as Record<string, unknown>;
  if (
    s.selectedThinkingPreference === 'off' ||
    s.selectedThinkingPreference === 'low' ||
    s.selectedThinkingPreference === 'medium' ||
    s.selectedThinkingPreference === 'high' ||
    s.selectedThinkingPreference === 'forced' ||
    s.selectedThinkingPreference === 'auto'
  ) {
    return s.selectedThinkingPreference;
  }
  if (s.selectedThinkingEnabled === false) return 'off';
  if (s.selectedThinkingEnabled === true) {
    const depth = s.selectedDepth;
    if (depth === 'low' || depth === 'medium' || depth === 'high') return depth;
    return 'forced';
  }
  return DEFAULT_PREFERENCE;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      selectedModel: '',
      selectedThinkingPreference: DEFAULT_PREFERENCE,
      ...initialRuntimeState,

      setLoading: (isLoading) => set({ isLoading }),
      setSelectedModel: (selectedModel) => set({ selectedModel }),
      setSelectedThinkingPreference: (selectedThinkingPreference) =>
        set({ selectedThinkingPreference }),

      setAvailableModels: (availableModels, defaultModel) =>
        set((state) => ({
          availableModels,
          modelsLoaded: true,
          selectedModel:
            state.selectedModel &&
            availableModels.some((m) => m.name === state.selectedModel)
              ? state.selectedModel
              : defaultModel,
        })),

      setActiveConversation: (activeConversationId) =>
        set({
          activeConversationId,
          // 切换 conversation 时清空 token usage 和 contextFull（重新估算）
          tokenUsage: null,
          contextFull: false,
        }),

      setConversations: (conversations) => set({ conversations }),

      addConversation: (conv) =>
        set((state) => ({
          conversations: [...state.conversations, conv],
        })),

      setMessages: (messages, archived = []) =>
        set({ messages, archivedMessages: archived }),

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      updateMessage: (id, patch) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, ...patch } : m
          ),
        })),

      setTokenUsage: (tokenUsage) => set({ tokenUsage }),
      setContextFull: (contextFull) => set({ contextFull }),

      resetSession: () => set(initialRuntimeState),
    }),
    {
      name: 'lecture-live-chat-prefs',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // 只持久化用户偏好；conversation 数据每次进入页面从 API 拉
      partialize: (state) => ({
        selectedModel: state.selectedModel,
        selectedThinkingPreference: state.selectedThinkingPreference,
      }),
      // v1 → v2: 把 selectedDepth + selectedThinkingEnabled 合并为 selectedThinkingPreference
      migrate: (persisted, version) => {
        if (version < 2) {
          const pref = migrateLegacyThinking(persisted);
          const selectedModel =
            typeof (persisted as Record<string, unknown>)?.selectedModel === 'string'
              ? ((persisted as Record<string, unknown>).selectedModel as string)
              : '';
          return { selectedModel, selectedThinkingPreference: pref };
        }
        return persisted;
      },
    }
  )
);

/** ThinkingDepth × Boolean 解构（给 useChat 用，避免 import 类型链路绕一圈） */
export function preferenceToFields(pref: ThinkingPreference): {
  thinkingDepth?: ThinkingDepth;
  thinkingEnabled?: boolean;
} {
  switch (pref) {
    case 'off':
      return { thinkingEnabled: false };
    case 'low':
    case 'medium':
    case 'high':
      return { thinkingEnabled: true, thinkingDepth: pref };
    case 'forced':
      return { thinkingEnabled: true };
    case 'auto':
      return {};
  }
}
