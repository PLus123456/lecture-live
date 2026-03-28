'use client';

import { create } from 'zustand';
import type { ChatMessage, ChatModelOption, ThinkingDepth } from '@/types/llm';

interface ChatStore {
  messages: ChatMessage[];
  isLoading: boolean;

  // Model & depth selection
  selectedModel: string; // provider name
  selectedDepth: ThinkingDepth;
  availableModels: ChatModelOption[];
  modelsLoaded: boolean;

  addMessage: (message: ChatMessage) => void;
  setLoading: (loading: boolean) => void;
  setSelectedModel: (model: string) => void;
  setSelectedDepth: (depth: ThinkingDepth) => void;
  setAvailableModels: (models: ChatModelOption[], defaultModel: string) => void;
  clearAll: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  isLoading: false,
  selectedModel: '',
  selectedDepth: 'medium',
  availableModels: [],
  modelsLoaded: false,

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  setLoading: (isLoading) => set({ isLoading }),

  setSelectedModel: (selectedModel) => set({ selectedModel }),

  setSelectedDepth: (selectedDepth) => set({ selectedDepth }),

  setAvailableModels: (availableModels, defaultModel) =>
    set((state) => ({
      availableModels,
      modelsLoaded: true,
      // Keep current selection if still valid, otherwise use default
      selectedModel:
        state.selectedModel &&
        availableModels.some((m) => m.name === state.selectedModel)
          ? state.selectedModel
          : defaultModel,
    })),

  clearAll: () =>
    set({ messages: [], isLoading: false }),
}));
