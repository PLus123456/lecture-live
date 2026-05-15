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

interface ChatStore {
  // ── 用户偏好（持久化） ──
  selectedModel: string;
  selectedDepth: ThinkingDepth;
  /**
   * 用户是否显式开启 thinking。
   *  - 模型 thinkingMode='OPTIONAL' 时，决定是否带 thinking 参数
   *  - 模型 thinkingMode='FORCED'   时，UI 不展示开关，发送方仍传 true（无效但无副作用）
   *  - 模型 thinkingMode='NONE'     时，前端忽略此值
   */
  selectedThinkingEnabled: boolean;

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
  setSelectedDepth: (depth: ThinkingDepth) => void;
  setSelectedThinkingEnabled: (enabled: boolean) => void;
  setAvailableModels: (models: ChatModelOption[], defaultModel: string) => void;

  setActiveConversation: (id: string | null) => void;
  setConversations: (list: ConversationMeta[]) => void;
  addConversation: (conv: ConversationMeta) => void;

  setMessages: (messages: ChatMessage[], archived?: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;

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

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      selectedModel: '',
      selectedDepth: 'medium',
      selectedThinkingEnabled: false,
      ...initialRuntimeState,

      setLoading: (isLoading) => set({ isLoading }),
      setSelectedModel: (selectedModel) => set({ selectedModel }),
      setSelectedDepth: (selectedDepth) => set({ selectedDepth }),
      setSelectedThinkingEnabled: (selectedThinkingEnabled) =>
        set({ selectedThinkingEnabled }),

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

      setTokenUsage: (tokenUsage) => set({ tokenUsage }),
      setContextFull: (contextFull) => set({ contextFull }),

      resetSession: () => set(initialRuntimeState),
    }),
    {
      name: 'lecture-live-chat-prefs',
      storage: createJSONStorage(() => localStorage),
      // 只持久化用户偏好；conversation 数据每次进入页面从 API 拉
      partialize: (state) => ({
        selectedModel: state.selectedModel,
        selectedDepth: state.selectedDepth,
        selectedThinkingEnabled: state.selectedThinkingEnabled,
      }),
    }
  )
);
