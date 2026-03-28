'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { SummaryBlock } from '@/types/summary';

interface SummaryStore {
  blocks: SummaryBlock[];
  runningContext: string;
  isLoading: boolean;
  currentBatchSentences: number;
  error: string | null;

  addBlock: (block: SummaryBlock) => void;
  freezeLastBlock: () => void;
  updateRunningContext: (ctx: string) => void;
  setLoading: (loading: boolean) => void;
  setBatchSentences: (count: number) => void;
  setError: (error: string | null) => void;
  clearAll: () => void;
}

export const useSummaryStore = create<SummaryStore>()(
  persist(
    (set) => ({
      blocks: [],
      runningContext: '',
      isLoading: false,
      currentBatchSentences: 0,
      error: null,

      addBlock: (block) =>
        set((state) => ({ blocks: [...state.blocks, block] })),

      freezeLastBlock: () =>
        set((state) => {
          if (state.blocks.length === 0) return state;
          const blocks = [...state.blocks];
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], frozen: true };
          return { blocks };
        }),

      updateRunningContext: (runningContext) => set({ runningContext }),

      setLoading: (isLoading) => set({ isLoading }),

      setBatchSentences: (count) => set({ currentBatchSentences: count }),

      setError: (error) => set({ error }),

      clearAll: () =>
        set({
          blocks: [],
          runningContext: '',
          isLoading: false,
          currentBatchSentences: 0,
          error: null,
        }),
    }),
    {
      name: 'lecture-live-summary',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        blocks: state.blocks,
        runningContext: state.runningContext,
      }),
    }
  )
);
