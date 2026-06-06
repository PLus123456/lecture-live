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

/**
 * 单个对话的运行时状态切片 —— 按 conversationId 隔离。
 *
 * 关键不变量：每个对话的流式状态互相独立。发送流的 SSE 回调在闭包里捕获自己的
 * conversationId，写入时只动自己这一片；即使用户在流式途中切到别的对话/录音，
 * 旧流也只会写回已非活跃的切片，结构上无法污染当前对话（根治跨路由串台/孤儿消息）。
 */
export interface ConversationRuntime {
  /** 活跃可见消息（按时间序） */
  messages: ChatMessage[];
  /** 主动压缩切割点之前的"已折叠"消息（UI 展开后可见，但不再发给 LLM） */
  archivedMessages: ChatMessage[];
  /** 该对话是否有发送流进行中 */
  isLoading: boolean;
  /** 最近一次 token usage 估算（供小圈 UI 用） */
  tokenUsage: ChatTokenUsage | null;
  /** 上下文已满标志（EOL/413 后置位，提示用户新建对话） */
  contextFull: boolean;
}

/**
 * 空切片（稳定冻结引用）：未初始化的对话读到它，避免每次 `?? {}` 新建对象
 * 触发无谓重渲染。消费方只读，绝不就地修改。
 */
export const EMPTY_CONVERSATION_RUNTIME: ConversationRuntime = Object.freeze({
  messages: [],
  archivedMessages: [],
  isLoading: false,
  tokenUsage: null,
  contextFull: false,
});

interface ChatStore {
  // ── 用户偏好（持久化） ──
  selectedModel: string;
  selectedThinkingPreference: ThinkingPreference;

  // ── 全局运行时（模型列表，一次性拉取，跨对话共享，不持久化） ──
  availableModels: ChatModelOption[];
  modelsLoaded: boolean;

  // ── 导航态（不持久化） ──
  /** 当前活跃 conversation ID */
  activeConversationId: string | null;
  /** 当前 session 下所有 conversations（含已关闭的，用于切换选择） */
  conversations: ConversationMeta[];

  // ── 按 conversationId 隔离的运行时切片（不持久化） ──
  byConversation: Record<string, ConversationRuntime>;

  // ── 偏好 / 模型 Setters ──
  setSelectedModel: (model: string) => void;
  setSelectedThinkingPreference: (pref: ThinkingPreference) => void;
  setAvailableModels: (models: ChatModelOption[], defaultModel: string) => void;

  // ── 导航 Setters ──
  setActiveConversation: (id: string | null) => void;
  setConversations: (list: ConversationMeta[]) => void;
  addConversation: (conv: ConversationMeta) => void;
  /**
   * 从导航态移除一个对话（删除对话后调用）：一次性清掉 conversations 列表项 +
   * byConversation 运行时切片 + 若删的是当前活跃对话则把 activeConversationId 置空。
   */
  removeConversation: (id: string) => void;

  // ── 按对话隔离的运行时 Setters（均需传 conversationId） ──
  setMessages: (
    conversationId: string,
    messages: ChatMessage[],
    archived?: ChatMessage[]
  ) => void;
  addMessage: (conversationId: string, message: ChatMessage) => void;
  /** 按 id 局部更新某对话的一条消息（流式增量用） */
  updateMessage: (
    conversationId: string,
    id: string,
    patch: Partial<ChatMessage>
  ) => void;
  setLoading: (conversationId: string, loading: boolean) => void;
  setTokenUsage: (conversationId: string, usage: ChatTokenUsage | null) => void;
  setContextFull: (conversationId: string, full: boolean) => void;

  /** 清空单个对话的运行时切片（进入对话前重置，避免残留上一次的流） */
  resetConversation: (conversationId: string) => void;
  /**
   * 重置 session 级运行时（切换 session / 退出时调用）：清空所有对话切片 + 导航态。
   * 保留模型列表（全局、跨 session）与用户偏好（持久化）。
   */
  resetSession: () => void;
}

const INITIAL_RUNTIME = {
  availableModels: [] as ChatModelOption[],
  modelsLoaded: false,
  activeConversationId: null as string | null,
  conversations: [] as ConversationMeta[],
  byConversation: {} as Record<string, ConversationRuntime>,
} as const;

const DEFAULT_PREFERENCE: ThinkingPreference = 'auto';

/**
 * 不可变地更新某对话的运行时切片：基于旧切片（或空切片）合并 patch，
 * 返回一个新的 byConversation map（仅替换目标 conversationId 的切片引用，
 * 其余切片保持原引用 → 其它对话的订阅者不会因此重渲染）。
 */
function patchRuntime(
  byConversation: Record<string, ConversationRuntime>,
  conversationId: string,
  patch: Partial<ConversationRuntime>
): Record<string, ConversationRuntime> {
  const prev = byConversation[conversationId] ?? EMPTY_CONVERSATION_RUNTIME;
  return {
    ...byConversation,
    [conversationId]: { ...prev, ...patch },
  };
}

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
      ...INITIAL_RUNTIME,

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
        set({ activeConversationId }),

      setConversations: (conversations) => set({ conversations }),

      addConversation: (conv) =>
        set((state) => ({
          conversations: [...state.conversations, conv],
        })),

      removeConversation: (id) =>
        set((state) => {
          const nextBy = { ...state.byConversation };
          delete nextBy[id];
          return {
            conversations: state.conversations.filter((c) => c.id !== id),
            byConversation: nextBy,
            activeConversationId:
              state.activeConversationId === id
                ? null
                : state.activeConversationId,
          };
        }),

      setMessages: (conversationId, messages, archived = []) =>
        set((state) => ({
          byConversation: patchRuntime(state.byConversation, conversationId, {
            messages,
            archivedMessages: archived,
          }),
        })),

      addMessage: (conversationId, message) =>
        set((state) => {
          const prev =
            state.byConversation[conversationId] ?? EMPTY_CONVERSATION_RUNTIME;
          return {
            byConversation: patchRuntime(state.byConversation, conversationId, {
              messages: [...prev.messages, message],
            }),
          };
        }),

      updateMessage: (conversationId, id, patch) =>
        set((state) => {
          const prev =
            state.byConversation[conversationId] ?? EMPTY_CONVERSATION_RUNTIME;
          return {
            byConversation: patchRuntime(state.byConversation, conversationId, {
              messages: prev.messages.map((m) =>
                m.id === id ? { ...m, ...patch } : m
              ),
            }),
          };
        }),

      setLoading: (conversationId, isLoading) =>
        set((state) => ({
          byConversation: patchRuntime(state.byConversation, conversationId, {
            isLoading,
          }),
        })),

      setTokenUsage: (conversationId, tokenUsage) =>
        set((state) => ({
          byConversation: patchRuntime(state.byConversation, conversationId, {
            tokenUsage,
          }),
        })),

      setContextFull: (conversationId, contextFull) =>
        set((state) => ({
          byConversation: patchRuntime(state.byConversation, conversationId, {
            contextFull,
          }),
        })),

      resetConversation: (conversationId) =>
        set((state) => {
          if (!state.byConversation[conversationId]) return {};
          const next = { ...state.byConversation };
          delete next[conversationId];
          return { byConversation: next };
        }),

      resetSession: () =>
        set({
          activeConversationId: null,
          conversations: [],
          byConversation: {},
        }),
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
