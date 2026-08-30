'use client';

import { create } from 'zustand';
import type { KeywordEntry } from '@/types/llm';
import {
  normalizeKeywordKey,
  validateExistingKeywordItems,
  type ExistingKeywordPolicyFailure,
} from '@/lib/llm/keywordPolicy';

export interface AddKeywordsResult {
  added: KeywordEntry[];
  rejected: number;
  duplicates: number;
  reasons: ExistingKeywordPolicyFailure[];
}

interface KeywordStore {
  keywords: KeywordEntry[];
  isExtracting: boolean;

  addKeywords: (entries: KeywordEntry[]) => AddKeywordsResult;
  removeKeyword: (text: string) => void;
  toggleKeyword: (text: string) => void;
  setExtracting: (extracting: boolean) => void;
  getActiveKeywords: () => string[];
  clearAll: () => void;
}

export const useKeywordStore = create<KeywordStore>((set, get) => ({
  keywords: [],
  isExtracting: false,

  addKeywords: (entries) => {
    const result: AddKeywordsResult = {
      added: [],
      rejected: 0,
      duplicates: 0,
      reasons: [],
    };
    set((state) => {
      const next = [...state.keywords];
      const known = new Set(next.map((entry) => normalizeKeywordKey(entry.text)));

      for (const entry of entries) {
        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        const key = normalizeKeywordKey(text);
        if (!key || known.has(key)) {
          result.duplicates += 1;
          continue;
        }

        const validation = validateExistingKeywordItems([
          ...next.map((current) => current.text),
          text,
        ]);
        if (!validation.ok) {
          result.rejected += 1;
          if (!result.reasons.includes(validation.reason)) {
            result.reasons.push(validation.reason);
          }
          continue;
        }

        const accepted = { ...entry, text };
        next.push(accepted);
        known.add(key);
        result.added.push(accepted);
      }
      return result.added.length > 0 ? { keywords: next } : state;
    });
    return result;
  },

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
