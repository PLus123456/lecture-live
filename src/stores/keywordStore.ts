'use client';

import { create } from 'zustand';
import type { KeywordEntry } from '@/types/llm';

interface KeywordStore {
  keywords: KeywordEntry[];
  isExtracting: boolean;

  addKeywords: (entries: KeywordEntry[]) => void;
  removeKeyword: (text: string) => void;
  toggleKeyword: (text: string) => void;
  setExtracting: (extracting: boolean) => void;
  getActiveKeywords: () => string[];
  clearAll: () => void;
}

export const useKeywordStore = create<KeywordStore>((set, get) => ({
  keywords: [],
  isExtracting: false,

  addKeywords: (entries) =>
    set((state) => {
      const existing = new Set(state.keywords.map((k) => k.text));
      const newEntries = entries.filter((e) => !existing.has(e.text));
      return { keywords: [...state.keywords, ...newEntries] };
    }),

  removeKeyword: (text) =>
    set((state) => ({
      keywords: state.keywords.filter((k) => k.text !== text),
    })),

  toggleKeyword: (text) =>
    set((state) => ({
      keywords: state.keywords.map((k) =>
        k.text === text ? { ...k, active: !k.active } : k
      ),
    })),

  setExtracting: (isExtracting) => set({ isExtracting }),

  getActiveKeywords: () =>
    get()
      .keywords.filter((k) => k.active)
      .map((k) => k.text),

  clearAll: () => set({ keywords: [], isExtracting: false }),
}));
