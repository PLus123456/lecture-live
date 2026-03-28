'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { TranslationMode } from '@/types/transcript';

interface TranslationStore {
  translations: Record<string, string>; // segmentId → translated text
  mode: TranslationMode;
  localModelLoaded: boolean;
  localModelProgress: number;
  localModelStatus: string;

  setTranslation: (segmentId: string, text: string) => void;
  setMode: (mode: TranslationMode) => void;
  setLocalModelLoaded: (loaded: boolean) => void;
  setLocalModelProgress: (progress: number) => void;
  setLocalModelStatus: (status: string) => void;
  clearAll: () => void;
}

export const useTranslationStore = create<TranslationStore>()(
  persist(
    (set) => ({
      translations: {},
      mode: 'soniox',
      localModelLoaded: false,
      localModelProgress: 0,
      localModelStatus: '',

      setTranslation: (segmentId, text) =>
        set((state) => ({
          translations: { ...state.translations, [segmentId]: text },
        })),

      setMode: (mode) => set({ mode }),

      setLocalModelLoaded: (loaded) => set({ localModelLoaded: loaded }),

      setLocalModelProgress: (progress) => set({ localModelProgress: progress }),

      setLocalModelStatus: (status) => set({ localModelStatus: status }),

      clearAll: () =>
        set({
          translations: {},
          localModelLoaded: false,
          localModelProgress: 0,
          localModelStatus: '',
        }),
    }),
    {
      name: 'lecture-live-translations',
      storage: createJSONStorage(() => sessionStorage),
      // 只持久化翻译数据，不持久化本地模型状态
      partialize: (state) => ({
        translations: state.translations,
      }),
    }
  )
);
